import base64
import binascii
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import launcher

PROFILE = "host-quota-8m-v1"
STATE = launcher.STATE
INPUT = launcher.ROOT / "input"
OUTPUT = launcher.ROOT / "output"
CHUNK = 32768
LIMIT = 8 * 1024 * 1024
FRAME = 65536
RUN = re.compile(r"ax-run-[0-9a-f]{16}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
ALIAS = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,58}\.(?:csv|xlsx)\Z")
ZERO_USAGE = {name: 0 for name in ("prompt_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count", "model_call_count")}


class Rejected(Exception):
    pass


def require(value, code="invalid_request"):
    if not value:
        raise Rejected(code)


def shape(value, fields):
    require(type(value) is dict and set(value) == set(fields.split()))


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def text(value, maximum):
    return type(value) is str and "\x00" not in value and len(value.encode("utf-8")) <= maximum


def uid(value):
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def pattern(regex, value):
    return type(value) is str and regex.fullmatch(value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def decode(raw):
    require(len(raw) <= FRAME, "frame_limit")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(Rejected("invalid_request")))


def b64(value, maximum):
    require(type(value) is str and len(value) <= 4 * math.ceil(maximum / 3))
    data = base64.b64decode(value, validate=True)
    require(len(data) <= maximum and base64.b64encode(data).decode() == value)
    return data


def read(name):
    fd = os.open(STATE / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and info.st_size <= FRAME, "unsafe_state")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            return decode(stream.read(FRAME + 1))
    finally:
        os.close(fd)


def save(name, value, exclusive=False):
    raw = canonical(value)
    require(len(raw) <= FRAME, "frame_limit")
    temp = STATE / ("." + name + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
        if exclusive:
            os.link(temp, STATE / name, follow_symlinks=False)
            os.unlink(temp)
        else:
            os.replace(temp, STATE / name)
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.close(fd)
        if temp.exists():
            temp.unlink()


def descriptor(value):
    shape(value, "request workbench")
    r, w = value["request"], value["workbench"]
    shape(r, "schema_version run_id root_id adapter checkpoint_revision descriptor_sha256")
    require(r["schema_version"] == 2 and type(r["schema_version"]) is int and pattern(RUN, r["run_id"]) and uid(r["root_id"]) and r["adapter"] == "python" and integer(r["checkpoint_revision"], 0, 32) and pattern(HASH, r["descriptor_sha256"]))
    shape(w, "version attempt_kind execution_policy mode profile_id remaining_ms descriptor")
    require(w["version"] == 2 and type(w["version"]) is int and w["attempt_kind"] == "python" and w["execution_policy"] == "workbench-trial-2026-10-07-v1" and integer(w["remaining_ms"], 1, 300000))
    require((w["mode"], w["profile_id"]) in (("preview", "preview-v1"), ("model", "gemini-3.1-flash-lite-standard-2026-10-07-v1")))
    d = w["descriptor"]
    shape(d, "version root_id instruction definition_manifest code_profile inputs outputs history code")
    require(d["version"] == 2 and type(d["version"]) is int and d["root_id"] == r["root_id"] and text(d["instruction"], 2048) and d["instruction"].strip() and d["code_profile"] == PROFILE)
    require(len(canonical(d)) <= 40960 and digest(canonical(d)) == r["descriptor_sha256"], "descriptor_mismatch")
    require(type(d["definition_manifest"]) is list and len(d["definition_manifest"]) <= 9)
    ids = set()
    for index, f in enumerate(d["definition_manifest"]):
        shape(f, "id sha256 size_bytes kind")
        require(uid(f["id"]) and f["id"] not in ids and pattern(HASH, f["sha256"]) and integer(f["size_bytes"], 1, 131072) and (f["kind"] == "skill" or index == 0 and f["kind"] == "agent"))
        ids.add(f["id"])
    require(sum(f["kind"] == "skill" for f in d["definition_manifest"]) <= 8)
    require(type(d["inputs"]) is list and len(d["inputs"]) <= 4)
    aliases, ids, total = set(), set(), 0
    for f in d["inputs"]:
        shape(f, "alias file_id name size_bytes sha256")
        require(pattern(ALIAS, f["alias"]) and f["alias"] not in aliases and uid(f["file_id"]) and f["file_id"] not in ids and text(f["name"], 255) and f["name"].strip() == f["name"] and not any(ord(c) < 32 or c in "/\\" for c in f["name"]) and f["name"].lower().endswith((".csv", ".xlsx")) and integer(f["size_bytes"], 1, LIMIT) and pattern(HASH, f["sha256"]))
        aliases.add(f["alias"]); ids.add(f["file_id"]); total += f["size_bytes"]
    require(total <= LIMIT, "input_limit")
    require(type(d["outputs"]) is list and 1 <= len(d["outputs"]) <= 4)
    names, output_aliases, total = set(), set(), 0
    for f in d["outputs"]:
        shape(f, "alias name size_limit_bytes")
        require(pattern(ALIAS, f["alias"]) and f["alias"] not in output_aliases and pattern(NAME, f["name"]) and f["name"] not in names and integer(f["size_limit_bytes"], 1, LIMIT))
        output_aliases.add(f["alias"]); names.add(f["name"]); total += f["size_limit_bytes"]
    require(total <= LIMIT, "output_limit")
    require(type(d["history"]) is list and len(d["history"]) <= 17 and len(canonical(d["history"])) <= 16384)
    for h in d["history"]:
        shape(h, "kind text")
        require(pattern(re.compile(r"[A-Za-z][A-Za-z0-9_]{0,95}\Z"), h["kind"]) and text(h["text"], 8192))
    p = d["code"]
    shape(p, "kind source input_aliases outputs purpose")
    require(p["kind"] == "python" and text(p["source"], 4096) and p["source"].strip() and text(p["purpose"], 2048) and p["purpose"].strip())
    require(type(p["outputs"]) is list and 1 <= len(p["outputs"]) <= 4)
    for output in p["outputs"]:
        shape(output, "name size_limit_bytes")
        require(pattern(NAME, output["name"]) and integer(output["size_limit_bytes"], 1, LIMIT))
    require(type(p["input_aliases"]) is list and len(p["input_aliases"]) == len(aliases) and set(p["input_aliases"]) == aliases and p["outputs"] == [{"name": f["name"], "size_limit_bytes": f["size_limit_bytes"]} for f in d["outputs"]])
    return r, d


def live_waiter():
    fd = os.open(STATE / "wait.lock", os.O_RDONLY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            require(read("ready.json") == {"profile": PROFILE, "version": 2}, "runner_unavailable")
            return
        raise Rejected("runner_unavailable")
    finally:
        os.close(fd)


def target(value, fields="run_id descriptor_sha256"):
    shape(value, fields)
    stage = read("stage.json")
    require(value["run_id"] == stage["request"]["run_id"], "run_mismatch")
    if "descriptor_sha256" in value:
        require(value["descriptor_sha256"] == stage["request"]["descriptor_sha256"], "descriptor_mismatch")
    return stage


def begin(value):
    r, d = descriptor(value)
    live_waiter()
    if (STATE / "stage.json").exists():
        require(read("stage.json") == value, "stage_conflict")
        require((STATE / "progress.json").exists(), "stage_incomplete")
        return {"run_id": r["run_id"], "state": "staged"}
    save("stage.json", value, True)
    save("accepted.json", {"monotonic_ns": time.monotonic_ns()}, True)
    launcher.write_input("main.py", d["code"]["source"].encode("utf-8"))
    for f in d["inputs"]:
        fd = os.open(INPUT / f["alias"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.ftruncate(fd, f["size_bytes"])
            os.fsync(fd)
        finally:
            os.close(fd)
    save("progress.json", {f["alias"]: [] for f in d["inputs"]}, True)
    return {"run_id": r["run_id"], "state": "staged"}


def put_chunk(value):
    stage = target(value, "run_id descriptor_sha256 alias index content_base64 sha256")
    require(not (STATE / "sealed.json").exists() and not (STATE / "start.json").exists(), "input_sealed")
    live_waiter()
    files = [f for f in stage["workbench"]["descriptor"]["inputs"] if f["alias"] == value["alias"]]
    require(len(files) == 1 and integer(value["index"], 0, 255))
    f = files[0]; index = value["index"]
    expected = min(CHUNK, f["size_bytes"] - index * CHUNK)
    content = b64(value["content_base64"], CHUNK)
    require(expected > 0 and len(content) == expected and digest(content) == value["sha256"], "chunk_mismatch")
    progress = read("progress.json"); prior = progress[f["alias"]]
    require(index <= len(prior), "chunk_order")
    fd = os.open(INPUT / f["alias"], os.O_RDWR | os.O_NOFOLLOW)
    try:
        if index < len(prior):
            require(prior[index] == value["sha256"] and os.pread(fd, expected, index * CHUNK) == content, "chunk_conflict")
        else:
            require(os.pwrite(fd, content, index * CHUNK) == len(content), "chunk_write_failed")
            os.fsync(fd)
            prior.append(value["sha256"])
            save("progress.json", progress)
    finally:
        os.close(fd)
    return {"run_id": value["run_id"], "state": "staged"}


def file_hash(fd, size):
    h = hashlib.sha256(); offset = 0
    while offset < size:
        data = os.pread(fd, min(CHUNK, size - offset), offset)
        require(data, "file_incomplete")
        h.update(data); offset += len(data)
    return h.hexdigest()


def seal(value):
    stage = target(value)
    if (STATE / "sealed.json").exists():
        require(read("sealed.json") == value, "seal_conflict")
        return {"run_id": value["run_id"], "state": "sealed"}
    live_waiter()
    progress = read("progress.json")
    for f in stage["workbench"]["descriptor"]["inputs"]:
        require(len(progress[f["alias"]]) == math.ceil(f["size_bytes"] / CHUNK), "input_incomplete")
        fd = os.open(INPUT / f["alias"], os.O_RDONLY | os.O_NOFOLLOW)
        try:
            require(file_hash(fd, f["size_bytes"]) == f["sha256"], "input_hash_mismatch")
            os.fchmod(fd, 0o444)
            os.fsync(fd)
        finally:
            os.close(fd)
    save("sealed.json", value, True)
    return {"run_id": value["run_id"], "state": "sealed"}


def start(value):
    stage = target(value)
    require(read("sealed.json") == value, "input_unsealed")
    require(not (STATE / "start.json").exists(), "start_already_attempted")
    live_waiter()
    require(remaining_ms(stage) > 0, "deadline_exceeded")
    save("start.json", {**value, "monotonic_ns": time.monotonic_ns()}, True)
    return {"run_id": value["run_id"], "state": "started"}


def status(value):
    shape(value, "run_id descriptor_sha256")
    require(pattern(RUN, value["run_id"]) and pattern(HASH, value["descriptor_sha256"]))
    state, attempted, result = "waiting", False, None
    if (STATE / "stage.json").exists():
        target(value); state = "staged"
    if (STATE / "start.json").exists():
        state = "started"
    if (STATE / "attempted.json").exists():
        state, attempted = "running", True
    if (STATE / "result.json").exists():
        state, attempted, result = "finished", True, read("result.json")
    return {"run_id": value["run_id"], "state": state, "attempted": attempted, "result": result}


def output_manifest(value):
    target(value)
    require(read("result.json")["status"] == "succeeded", "output_unavailable")
    return read("outputs.json")


def output_chunk(value):
    stage = target(value, "run_id manifest_sha256 alias index")
    manifest = output_manifest({"run_id": value["run_id"], "descriptor_sha256": stage["request"]["descriptor_sha256"]})
    require(value["manifest_sha256"] == manifest["manifest_sha256"], "manifest_mismatch")
    files = [f for f in manifest["outputs"] if f["alias"] == value["alias"]]
    require(len(files) == 1 and integer(value["index"], 0, 255))
    f = files[0]; expected = min(CHUNK, f["size_bytes"] - value["index"] * CHUNK)
    require(expected > 0)
    with launcher.owned_directory("output") as directory:
        fd = os.open(f["name"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == launcher.UID and info.st_nlink == 1 and info.st_size == f["size_bytes"] and stat.S_IMODE(info.st_mode) == 0o400, "unsafe_output")
            content = os.pread(fd, expected, value["index"] * CHUNK)
            require(len(content) == expected, "output_incomplete")
        finally:
            os.close(fd)
    return {"run_id": value["run_id"], "alias": f["alias"], "index": value["index"], "content_base64": base64.b64encode(content).decode(), "sha256": digest(content)}


def collect(value):
    target(value)
    return {"result": read("result.json"), "artifact_base64": None}


def summary(raw):
    value = raw.decode("utf-8", errors="replace").replace("\x00", "")
    return value.encode("utf-8")[:8192].decode("utf-8", errors="ignore")


def remaining_ms(stage):
    elapsed = (time.monotonic_ns() - read("accepted.json")["monotonic_ns"]) // 1000000
    return stage["workbench"]["remaining_ms"] - max(0, elapsed)


def run_once(stage):
    r = stage["request"]; d = stage["workbench"]["descriptor"]
    save("attempted.json", {"run_id": r["run_id"]}, True)
    result = {"schema_version": 2, "run_id": r["run_id"], "adapter": "python", "status": "failed", "exit_code": 1, "error_type": "code_setup_failed", "summary": "", "usage": ZERO_USAGE.copy(), "estimated_usd": 0}
    try:
        launcher.verify_layout(PROFILE, require_empty=False)
        limits = {f["name"]: f["size_limit_bytes"] for f in d["outputs"]}
        left = remaining_ms(stage)
        require(left > 0, "deadline_exceeded")
        observation = launcher.run_staged(list(limits), LIMIT, False, limits, min(launcher.WALL_SECONDS, left / 1000))
        result["summary"] = summary(base64.b64decode(observation["untrusted_log_base64"], validate=True))
        observed_exit = observation["exit_code"]
        result["exit_code"] = (128 - observed_exit if observed_exit < 0 else observed_exit) or 1
        result["error_type"] = observation["code"]
        if observation["code"] == "wall_limit":
            result["status"] = "timed_out"
        if observation["status"] == "succeeded":
            observed = {f["name"]: f for f in observation["outputs"]}
            outputs = [{"alias": f["alias"], **observed[f["name"]]} for f in d["outputs"]]
            require(all(f["size_bytes"] >= 1 for f in outputs), "empty_output")
            with launcher.owned_directory("output") as directory:
                for f in outputs:
                    fd = os.open(f["name"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
                    try:
                        info = os.fstat(fd)
                        require(stat.S_ISREG(info.st_mode) and info.st_uid == launcher.UID and info.st_nlink == 1 and info.st_size == f["size_bytes"], "unsafe_output")
                        os.fchmod(fd, 0o400)
                    finally:
                        os.close(fd)
            manifest = {"run_id": r["run_id"], "descriptor_sha256": r["descriptor_sha256"], "outputs": outputs}
            save("outputs.json", {**manifest, "manifest_sha256": digest(canonical(manifest))}, True)
            result.update(status="succeeded", exit_code=0, error_type=None)
    except BaseException:
        pass
    save("result.json", result, True)


def wait():
    launcher.verify_layout(PROFILE)
    fd = os.open(STATE / "wait.lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        save("ready.json", {"version": 2, "profile": PROFILE}, True)
        while not (STATE / "start.json").exists():
            time.sleep(0.025)
        stage = read("stage.json")
        start_value = read("start.json")
        require(start_value["run_id"] == stage["request"]["run_id"] and start_value["descriptor_sha256"] == stage["request"]["descriptor_sha256"])
        run_once(stage)
    finally:
        os.close(fd)


OPERATIONS = {"stage-begin": begin, "stage-chunk": put_chunk, "stage-seal": seal, "code-start": start, "code-status": status, "code-collect": collect, "output-manifest": output_manifest, "output-chunk": output_chunk}


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        if arguments == ["wait"]:
            wait(); return 0
        require(len(arguments) == 2 and arguments[0] in OPERATIONS)
        value = decode(b64(arguments[1], FRAME))
        launcher.verify_parent_capabilities()
        require(read("ready.json") == {"version": 2, "profile": PROFILE}, "runner_unavailable")
        fd = os.open(STATE / "rpc.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            response = OPERATIONS[arguments[0]](value)
        finally:
            os.close(fd)
        output = canonical(response)
        require(len(output) <= FRAME, "frame_limit")
        sys.stdout.buffer.write(output + b"\n")
        return 0
    except (Rejected, launcher.Rejected) as error:
        code = str(error)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, binascii.Error, RecursionError):
        code = "code_protocol_failed"
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code):
        code = "code_protocol_failed"
    print(json.dumps({"error": code}, separators=(",", ":")))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
