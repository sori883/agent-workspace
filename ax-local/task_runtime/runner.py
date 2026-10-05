import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time

if __package__:
    from .protocol import IDENTIFIER_PATTERN, MAX_ARTIFACT_BYTES, MAX_REQUEST_BYTES, ProtocolError, decode_request, is_nonnegative_number, validate_request, validate_result, validate_run_id
else:
    from protocol import IDENTIFIER_PATTERN, MAX_ARTIFACT_BYTES, MAX_REQUEST_BYTES, ProtocolError, decode_request, is_nonnegative_number, validate_request, validate_result, validate_run_id


EXECUTION_TIMEOUT = 90
MAX_RESULT_BYTES = 16384


def _directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ProtocolError("UnsafeDirectory")


def _read_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ProtocolError("UnsafeFile")
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ProtocolError("FileTooLarge")
    return data


def _read_json(path, limit=MAX_RESULT_BYTES):
    try:
        return json.loads(_read_bytes(path, limit).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ProtocolError("InvalidStoredJson") from None


def _exclusive(path, data=b""):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def _write_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    temporary = path.with_name(path.name + ".pending")
    _exclusive(temporary, data)
    if path.exists() or path.is_symlink():
        raise ProtocolError("ResultAlreadyExists")
    os.rename(temporary, path)


def _request(root, run_id=None):
    _directory(root)
    request = validate_request(_read_json(root / "request.json", MAX_REQUEST_BYTES))
    if run_id is not None and request["run_id"] != validate_run_id(run_id):
        raise ProtocolError("RunIdMismatch")
    return request


def stage(root, encoded):
    request = decode_request(encoded)
    _directory(root, create=True)
    _exclusive(root / "staged")
    _write_json(root / "request.json", request)
    return {"run_id": request["run_id"], "state": "staged"}


def start(root, run_id):
    request = _request(root, run_id)
    if (root / "attempted").exists():
        raise ProtocolError("AlreadyAttempted")
    _exclusive(root / "start", request["run_id"].encode("ascii"))
    return {"run_id": run_id, "state": "started"}


def status(root, run_id):
    validate_run_id(run_id)
    if not root.exists():
        return {"run_id": run_id, "state": "waiting", "attempted": False, "result": None}
    _directory(root)
    if not (root / "request.json").exists():
        return {"run_id": run_id, "state": "waiting", "attempted": False, "result": None}
    request = _request(root, run_id)
    attempted = (root / "attempted").exists()
    result = None
    if (root / "result.json").exists():
        result = validate_result(_read_json(root / "result.json"))
        if result["run_id"] != run_id or result["adapter"] != request["adapter"] or not attempted:
            raise ProtocolError("ResultMismatch")
        state = "finished"
    elif attempted:
        state = "running"
    elif (root / "start").exists():
        state = "started"
    else:
        state = "staged"
    return {"run_id": run_id, "state": state, "attempted": attempted, "result": result}


def _artifact(root, request):
    output = root / "output"
    _directory(output)
    path = output / request["output_name"]
    data = _read_bytes(path, MAX_ARTIFACT_BYTES)
    return {"name": request["output_name"], "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}, data


def collect(root, run_id):
    current = status(root, run_id)
    if current["state"] != "finished":
        raise ProtocolError("ResultNotReady")
    result = current["result"]
    encoded = None
    if result["artifact"] is not None:
        metadata, data = _artifact(root, _request(root, run_id))
        if metadata != result["artifact"]:
            raise ProtocolError("ArtifactMismatch")
        encoded = base64.b64encode(data).decode("ascii")
    return {"result": result, "artifact_base64": encoded}


def _receipt(root):
    try:
        receipt = _read_json(root / "receipt.json")
        if not isinstance(receipt, dict) or set(receipt) != {"usage", "estimated_usd", "stop_reason"}:
            return None
        usage = receipt["usage"]
        if usage is not None and (not isinstance(usage, dict) or not usage or any(
            not isinstance(key, str) or not IDENTIFIER_PATTERN.fullmatch(key) or not is_nonnegative_number(value)
            for key, value in usage.items()
        )):
            return None
        if receipt["estimated_usd"] is not None and not is_nonnegative_number(receipt["estimated_usd"]):
            return None
        stop_reason = receipt["stop_reason"]
        if stop_reason is not None and (not isinstance(stop_reason, str) or not IDENTIFIER_PATTERN.fullmatch(stop_reason)):
            return None
        return receipt
    except (OSError, ProtocolError):
        return None


def _kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute(root, timeout=EXECUTION_TIMEOUT):
    request = _request(root)
    if _read_bytes(root / "start", 128).decode("ascii") != request["run_id"]:
        raise ProtocolError("StartMismatch")
    _exclusive(root / "attempted")
    result = {
        "schema_version": 1, "run_id": request["run_id"], "adapter": request["adapter"],
        "status": "failed", "exit_code": 1, "stop_reason": None, "usage": None,
        "estimated_usd": None, "error_type": None, "artifact": None,
    }
    process = None
    try:
        (root / "output").mkdir(mode=0o700)
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--root", str(root), "_adapter", request["run_id"]],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            result["exit_code"] = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(process)
            result.update(status="timed_out", exit_code=124, stop_reason="TIMEOUT", error_type="ExecutionTimeout")
        finally:
            _kill_group(process)
        receipt = _receipt(root)
        if receipt is not None:
            result["usage"] = receipt["usage"]
            result["estimated_usd"] = receipt["estimated_usd"]
            if result["status"] != "timed_out":
                result["stop_reason"] = receipt["stop_reason"]
        if result["status"] == "timed_out":
            pass
        elif result["exit_code"] != 0:
            result["error_type"] = "AdapterFailed"
        elif result["usage"] is None or result["estimated_usd"] is None:
            result.update(exit_code=1, error_type="UsageUnavailable")
        elif request["adapter"] == "antigravity" and (result["usage"].get("prompt_token_count", 0) <= 0 or result["usage"].get("total_token_count", 0) <= 0):
            result.update(exit_code=1, error_type="UsageUnavailable")
        elif result["stop_reason"] != ("OFFLINE" if request["adapter"] == "offline" else "UNSPECIFIED"):
            result.update(exit_code=1, error_type="AgentStopped")
        else:
            result["artifact"], _ = _artifact(root, request)
            result["status"] = "succeeded"
        validate_result(result)
    except BaseException as error:
        if process is not None:
            _kill_group(process)
        result.update(status="failed", exit_code=1, error_type=type(error).__name__, artifact=None)
    validate_result(result)
    _write_json(root / "result.json", result)
    return result


def _run_adapter(root, run_id):
    request = _request(root, run_id)
    if not (root / "attempted").is_file():
        raise ProtocolError("NotAttempted")
    _exclusive(root / "adapter-attempted")
    output = root / "output"
    _directory(output)
    os.chdir(output)
    if request["adapter"] == "offline":
        if __package__:
            from .adapters.offline import run
        else:
            from adapters.offline import run
        run(request, output, root / "receipt.json")
    else:
        if __package__:
            from .adapters.antigravity import run
        else:
            from adapters.antigravity import run
        asyncio.run(run(request, output, root / "receipt.json"))


def wait(root):
    _directory(root, create=True)
    while not (root / "start").exists():
        time.sleep(0.1)
    try:
        execute(root)
    except FileExistsError:
        if not (root / "attempted").exists():
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/workspace/task"))
    parser.add_argument("command", choices=("wait", "stage", "start", "status", "collect", "_adapter"))
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    root = args.root.absolute()
    try:
        if args.command == "wait":
            if args.value is not None:
                raise ProtocolError("UnexpectedArgument")
            wait(root)
            return 0
        if args.value is None:
            raise ProtocolError("MissingArgument")
        if args.command == "_adapter":
            _run_adapter(root, args.value)
            return 0
        result = {"stage": stage, "start": start, "status": status, "collect": collect}[args.command](root, args.value)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except BaseException as error:
        print(json.dumps({"error_type": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
