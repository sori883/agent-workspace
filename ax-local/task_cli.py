#!/usr/bin/env python3
import argparse
import base64
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

from task_runtime.protocol import (
    MAX_ARTIFACT_BYTES,
    encode_request,
    validate_request,
    validate_result,
)

ROOT = Path(__file__).resolve().parent
RUN_ID = re.compile(r"ax-run-[0-9a-f]{16}\Z")
IMAGE = re.compile(r"localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}\Z")
PILOT_ESTIMATE_LIMIT_USD = 0.01


class TaskError(Exception):
    pass


def error_code(error):
    if isinstance(error, TaskError):
        return str(error)
    return type(error).__name__


def review_note(note):
    if not isinstance(note, str) or not note.strip() or "\x00" in note:
        raise TaskError("invalid_review_note")
    try:
        if len(note.encode("utf-8")) > 2048:
            raise TaskError("invalid_review_note")
    except UnicodeError as exc:
        raise TaskError("invalid_review_note") from exc
    return note


def read_file(path, limit):
    path = Path(path).absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise TaskError("symlink_rejected")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise TaskError("file_type_or_size")
            data = stream.read(limit + 1)
    except OSError as exc:
        raise TaskError("file_unreadable") from exc
    if len(data) > limit:
        raise TaskError("file_size")
    return data


def read_json(path, limit=200000):
    try:
        return json.loads(read_file(path, limit))
    except (ValueError, UnicodeError) as exc:
        raise TaskError("invalid_saved_json") from exc


def atomic_write(path, data):
    path = Path(path)
    if path.is_symlink():
        raise TaskError("symlink_rejected")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_json(path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())


def make_request(instruction_file, inputs, output_name, offline=False):
    if len(inputs) > 4:
        raise TaskError("too_many_inputs")
    content = {}
    for value in inputs:
        path = Path(value)
        if path.name in content:
            raise TaskError("duplicate_input_name")
        content[path.name] = read_file(path, 4096).decode("utf-8")
    return validate_request({
        "schema_version": 1,
        "run_id": "ax-run-" + secrets.token_hex(8),
        "adapter": "offline" if offline else "antigravity",
        "instruction": read_file(instruction_file, 2048).decode("utf-8"),
        "inputs": content,
        "output_name": output_name,
    })


def make_manifest(request, image):
    if not IMAGE.fullmatch(image):
        raise TaskError("runner_task_image_requires_local_digest")
    return {
        "apiVersion": "ax.io/v1alpha1",
        "kind": "Task",
        "metadata": {"name": request["run_id"], "atespace": "ax-demo"},
        "spec": {
            "image": image,
            "command": ["python3", "/opt/ax-task/runner.py", "wait"],
            "debug": True,
        },
    }


def fingerprint(request, image):
    payload = {key: value for key, value in request.items() if key != "run_id"}
    payload["image"] = image
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Transport:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        self.lock_fd = None

    def command(self, arguments, timeout=40):
        process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True,
                                   pass_fds=() if self.lock_fd is None else (self.lock_fd,))
        try:
            stdout, _ = process.communicate(timeout=timeout)
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise
        if process.returncode:
            raise TaskError("transport_command_failed")
        if len(stdout) > 200000:
            raise TaskError("transport_output_size")
        return stdout.decode("utf-8")

    def ax(self, *args):
        return self.command(["bash", str(self.root / "ax"), *args, "-a", "ax-demo"])

    def apply(self, manifest):
        self.ax("apply", "-f", str(manifest))

    def resume(self, run_id):
        self.ax("resume", "task", run_id)

    def suspend(self, run_id):
        self.ax("suspend", "task", run_id)

    def task_state(self, run_id):
        for line in self.ax("get", "tasks").splitlines()[1:]:
            fields = line.split()
            if fields and fields[0] == run_id:
                if len(fields) < 4 or fields[1] != "ax-demo":
                    raise TaskError("normal_actor_unconfirmed")
                return {"phase": fields[2], "actor": fields[3]}
        raise TaskError("task_not_found")

    def actor(self, run_id):
        if self.task_state(run_id) != {"phase": "Running", "actor": run_id}:
            raise TaskError("normal_actor_unconfirmed")
        return run_id

    def guest(self, run_id, operation, argument=None):
        arguments = ["bash", str(self.root / "ax"), "ssh", run_id, "-a", "ax-demo",
                     "--", "python3", "/opt/ax-task/runner.py", operation,
                     argument if argument is not None else run_id]
        try:
            return json.loads(self.command(arguments, timeout=15))
        except (ValueError, UnicodeError) as exc:
            raise TaskError("guest_json_invalid") from exc

    def egress(self, actor, allow):
        hosts = self.root / "egress" / ("model-hosts.json" if allow else "deny-all.json")
        self.command(["bash", str(self.root / "with-env.sh"), "bash",
                      str(self.root / "scripts/set-egress.sh"), actor, str(hosts)], timeout=50)


class TaskCLI:
    def __init__(self, root=ROOT, transport=None, clock=time.monotonic, sleep=time.sleep):
        self.root = Path(root)
        self.runs = self.root / ".state/runs"
        self.transport = transport or Transport(self.root)
        self.clock = clock
        self.sleep = sleep

    @contextlib.contextmanager
    def locked(self, wait_seconds=0):
        os.umask(0o077)
        if any(part.is_symlink() for part in (self.runs, *self.runs.parents)):
            raise TaskError("symlink_rejected")
        self.runs.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = self.runs / ".lock"
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as stream:
            deadline = time.monotonic() + wait_seconds
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError as exc:
                    if time.monotonic() >= deadline:
                        raise TaskError("another_cli_running") from exc
                    time.sleep(0.01)
            previous = getattr(self.transport, "lock_fd", None)
            self.transport.lock_fd = stream.fileno()
            try:
                yield
            finally:
                self.transport.lock_fd = previous

    @contextlib.contextmanager
    def observing(self):
        if any(part.is_symlink() for part in (self.runs, *self.runs.parents)):
            raise TaskError("symlink_rejected")
        try:
            fd = os.open(self.runs / ".lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            yield False
            return
        with os.fdopen(fd, "r+") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise TaskError("invalid_run_ledger")
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                active = True
            else:
                active = False
            yield active

    def is_active(self):
        with self.observing() as active:
            return active

    def directory(self, run_id):
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise TaskError("invalid_run_id")
        path = self.runs / run_id
        if path.is_symlink() or not path.is_dir():
            raise TaskError("run_not_found")
        return path

    def inspect(self, run_id):
        directory = self.directory(run_id)
        receipt = read_json(directory / "receipt.json")
        if receipt.get("run_id") != run_id:
            raise TaskError("receipt_run_mismatch")
        return receipt

    def guard(self, request, image):
        total = 0.0
        signature = fingerprint(request, image)
        for directory in self.runs.iterdir():
            if directory.name.startswith("."):
                continue
            if not RUN_ID.fullmatch(directory.name) or not directory.is_dir() or directory.is_symlink():
                raise TaskError("invalid_run_ledger")
            previous = self.inspect(directory.name)
            if not previous.get("resolved"):
                raise TaskError("unresolved_run:" + directory.name)
            if previous.get("adapter") != "antigravity":
                continue
            result = previous.get("result")
            if previous.get("start_attempted"):
                if result is None or result.get("usage") is None or result.get("estimated_usd") is None:
                    raise TaskError("unknown_paid_usage:" + directory.name)
                cost = result["estimated_usd"]
                if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0:
                    raise TaskError("invalid_paid_usage")
                total += cost
                if (request["adapter"] == "antigravity" and previous.get("fingerprint") == signature
                        and result.get("status") != "succeeded"):
                    raise TaskError("failed_request_already_attempted:" + directory.name)
                if request["adapter"] == "antigravity" and result.get("status") != "succeeded":
                    review = previous.get("failure_review")
                    if not isinstance(review, dict):
                        raise TaskError("paid_failure_requires_review:" + directory.name)
                    review_note(review.get("note"))
        if request["adapter"] == "antigravity" and total >= PILOT_ESTIMATE_LIMIT_USD:
            raise TaskError("pilot_estimate_limit_reached")
        return total

    def store(self, directory, receipt, **changes):
        receipt.update(changes)
        save_json(directory / "receipt.json", receipt)

    def acknowledge_failure(self, run_id, note):
        note = review_note(note)
        with self.locked():
            directory = self.directory(run_id)
            receipt = self.inspect(run_id)
            cleanup = receipt.get("cleanup", {})
            result = receipt.get("result")
            if (not receipt.get("resolved") or cleanup.get("egress_denied") is not True
                    or cleanup.get("suspended") is not True or receipt.get("cleanup_errors")
                    or result is None or result.get("usage") is None or result.get("estimated_usd") is None):
                raise TaskError("failure_review_unresolved")
            result = validate_result(result)
            if (receipt.get("adapter") != "antigravity" or not receipt.get("start_attempted")
                    or result["adapter"] != "antigravity" or result["run_id"] != run_id
                    or result["status"] == "succeeded"):
                raise TaskError("not_failed_paid_run")
            review = receipt.get("failure_review")
            if review is not None:
                if review.get("note") != note:
                    raise TaskError("failure_already_reviewed")
                return receipt
            self.store(directory, receipt, failure_review={
                "note": note, "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            return receipt

    def ready(self, run_id, timeout=180):
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            try:
                status = self.transport.guest(run_id, "status")
                self.validate_status(status, run_id)
                return status
            except (TaskError, subprocess.TimeoutExpired):
                self.sleep(2)
        raise TaskError("guest_readiness_timeout")

    @staticmethod
    def validate_status(status, run_id):
        if (not isinstance(status, dict) or status.get("run_id") != run_id
                or status.get("state") not in {"waiting", "staged", "started", "running", "finished"}):
            raise TaskError("guest_status_invalid")

    def wait_result(self, run_id):
        deadline = self.clock() + 120
        while self.clock() < deadline:
            try:
                status = self.transport.guest(run_id, "status")
            except subprocess.TimeoutExpired:
                self.sleep(2)
                continue
            except TaskError as exc:
                if str(exc) != "transport_command_failed":
                    raise
                self.sleep(2)
                continue
            self.validate_status(status, run_id)
            if status["state"] == "finished":
                return
            self.sleep(2)
        raise TaskError("result_timeout")

    def collect(self, directory, request, receipt):
        collected = self.transport.guest(request["run_id"], "collect")
        if not isinstance(collected, dict) or set(collected) != {"result", "artifact_base64"}:
            raise TaskError("collection_invalid")
        result = validate_result(collected["result"])
        if result["run_id"] != request["run_id"] or result["adapter"] != request["adapter"]:
            raise TaskError("result_identity_mismatch")
        artifact = result["artifact"]
        if artifact is not None:
            encoded = collected["artifact_base64"]
            if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_ARTIFACT_BYTES + 2) // 3):
                raise TaskError("artifact_encoding_size")
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError as exc:
                raise TaskError("artifact_encoding_invalid") from exc
            if (artifact["name"] != request["output_name"] or len(data) > MAX_ARTIFACT_BYTES
                    or artifact["size_bytes"] != len(data)
                    or artifact["sha256"] != hashlib.sha256(data).hexdigest()):
                raise TaskError("artifact_verification_failed")
            artifacts = directory / "artifacts"
            if artifacts.is_symlink():
                raise TaskError("symlink_rejected")
            artifacts.mkdir(exist_ok=True, mode=0o700)
            atomic_write(artifacts / artifact["name"], data)
        elif collected["artifact_base64"] is not None:
            raise TaskError("unexpected_artifact")
        save_json(directory / "result.json", result)
        self.store(directory, receipt, result=result, phase="collected", error_type=None)

    def cleanup(self, directory, receipt):
        errors = []
        cleanup = {"egress_denied": False, "suspended": False}
        for name, operation in (
            ("egress_denied", lambda: self.transport.egress(receipt["run_id"], False)),
            ("suspended", lambda: self.transport.suspend(receipt["run_id"])),
        ):
            try:
                operation()
                cleanup[name] = True
            except (Exception, KeyboardInterrupt) as exc:
                errors.append(name + ":" + error_code(exc))
        result = receipt.get("result")
        usage_known = (not receipt["start_attempted"] or result is not None
                       and (receipt["adapter"] == "offline" or result.get("usage") is not None
                            and result.get("estimated_usd") is not None))
        resolved = all(cleanup.values()) and usage_known
        succeeded = resolved and result is not None and result["status"] == "succeeded"
        self.store(directory, receipt, resolved=resolved, phase="finished" if resolved else "needs_recovery",
                   outcome="succeeded" if succeeded else "failed", cleanup=cleanup, cleanup_errors=errors)

    def prepare(self, request, image, known_total, dry_run=False, submission=None):
        manifest = make_manifest(request, image)
        directory = self.runs / request["run_id"]
        if directory.exists() or directory.is_symlink():
            raise FileExistsError()
        pending = Path(tempfile.mkdtemp(prefix=".pending-", dir=self.runs))
        receipt = {
                "schema_version": 1, "run_id": request["run_id"], "adapter": request["adapter"],
                "fingerprint": fingerprint(request, image), "image": image,
                "phase": "accepted" if submission else "prepared", "apply_attempted": False,
                "start_attempted": False, "result": None,
                "cleanup": {}, "cleanup_errors": [], "resolved": dry_run,
                "outcome": "dry_run" if dry_run else "pending", "error_type": None,
                "known_estimated_usd_before": known_total,
                "estimate_is_billing_guarantee": False,
        }
        if submission is not None:
            receipt["submission"] = submission
        if dry_run:
            receipt["phase"] = "dry_run"
        try:
            save_json(pending / "request.json", request)
            save_json(pending / "manifest.json", manifest)
            self.store(pending, receipt)
            os.rename(pending, directory)
            fd = os.open(self.runs, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            if pending.exists():
                shutil.rmtree(pending)
        return directory, receipt

    def execute(self, directory, request, receipt):
        try:
            self.store(directory, receipt, phase="apply_attempted", apply_attempted=True)
            self.transport.apply(directory / "manifest.json")
            self.store(directory, receipt, phase="resume_attempted")
            self.transport.resume(request["run_id"])
            self.ready(request["run_id"])
            self.transport.actor(request["run_id"])
            response = self.transport.guest(request["run_id"], "stage", encode_request(request))
            if response != {"run_id": request["run_id"], "state": "staged"}:
                raise TaskError("stage_unconfirmed")
            self.store(directory, receipt, phase="egress_attempted")
            self.transport.egress(request["run_id"], request["adapter"] != "offline")
            self.store(directory, receipt, phase="start_attempted", start_attempted=True)
            response = self.transport.guest(request["run_id"], "start")
            if response != {"run_id": request["run_id"], "state": "started"}:
                raise TaskError("start_unconfirmed")
            self.store(directory, receipt, phase="running")
            self.wait_result(request["run_id"])
            self.collect(directory, request, receipt)
        except (Exception, KeyboardInterrupt) as exc:
            self.store(directory, receipt, error_type=error_code(exc))
        finally:
            self.cleanup(directory, receipt)
        return receipt

    def run(self, request, dry_run=False):
        request = validate_request(request)
        image = read_json(self.root / "versions.json").get("runner_task", "")
        make_manifest(request, image)
        with self.locked():
            known_total = self.guard(request, image)
            directory, receipt = self.prepare(request, image, known_total, dry_run)
            if not dry_run:
                return self.execute(directory, request, receipt)
            return receipt

    def find_submission(self, key_hash, payload_hash):
        if not self.runs.exists():
            return None
        for directory in self.runs.iterdir():
            if directory.name.startswith("."):
                continue
            receipt = self.inspect(directory.name)
            submission = receipt.get("submission")
            if isinstance(submission, dict) and submission.get("key_hash") == key_hash:
                if submission.get("payload_hash") != payload_hash:
                    raise TaskError("idempotency_conflict")
                return receipt
        return None

    def accept(self, request, key_hash, payload_hash):
        request = validate_request(request)
        existing = self.find_submission(key_hash, payload_hash)
        if existing is not None:
            return existing, True
        with self.locked():
            existing = self.find_submission(key_hash, payload_hash)
            if existing is not None:
                return existing, True
            image = read_json(self.root / "versions.json").get("runner_task", "")
            make_manifest(request, image)
            known_total = self.guard(request, image)
            submission = {"key_hash": key_hash, "payload_hash": payload_hash,
                          "accepted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
            _, receipt = self.prepare(request, image, known_total, submission=submission)
            return receipt, False

    def execute_accepted(self, run_id):
        with self.locked(wait_seconds=2):
            directory = self.directory(run_id)
            receipt = self.inspect(run_id)
            if (receipt.get("phase") != "accepted" or receipt.get("resolved")
                    or receipt.get("apply_attempted") is not False or receipt.get("start_attempted")
                    or not isinstance(receipt.get("submission"), dict)):
                raise TaskError("execution_already_claimed")
            request = validate_request(read_json(directory / "request.json"))
            if (request["run_id"] != run_id or request["adapter"] != receipt.get("adapter")
                    or fingerprint(request, receipt["image"]) != receipt.get("fingerprint")
                    or read_json(directory / "manifest.json") != make_manifest(request, receipt["image"])):
                raise TaskError("request_receipt_mismatch")
            return self.execute(directory, request, receipt)

    def recover(self, run_id, wait_seconds=0):
        with self.locked(wait_seconds=wait_seconds):
            directory = self.directory(run_id)
            receipt = self.inspect(run_id)
            if receipt["phase"] == "dry_run" or receipt.get("resolved"):
                return receipt
            if (receipt.get("phase") == "accepted" and receipt.get("apply_attempted") is False
                    and receipt.get("start_attempted") is False and isinstance(receipt.get("submission"), dict)):
                self.store(directory, receipt, resolved=True, phase="not_started", outcome="not_started",
                           error_type=None, cleanup={"egress_denied": False, "suspended": False}, cleanup_errors=[])
                return receipt
            request = validate_request(read_json(directory / "request.json"))
            if request["run_id"] != run_id:
                raise TaskError("request_run_mismatch")
            try:
                self.store(directory, receipt, resolved=False, phase="recovering")
                self.transport.egress(run_id, False)
                state = self.transport.task_state(run_id)
                if state == {"phase": "Running", "actor": run_id}:
                    status = self.transport.guest(run_id, "status")
                    self.validate_status(status, run_id)
                    if status["state"] == "finished":
                        self.collect(directory, request, receipt)
                    elif receipt["start_attempted"]:
                        raise TaskError("result_not_available_no_restart")
                elif state["phase"] == "Suspended":
                    if receipt["start_attempted"] and receipt.get("result") is None:
                        raise TaskError("suspended_result_unavailable_manual_inspection")
                else:
                    raise TaskError("normal_actor_unconfirmed")
            except (Exception, KeyboardInterrupt) as exc:
                self.store(directory, receipt, error_type=error_code(exc))
            finally:
                self.cleanup(directory, receipt)
            return receipt


def parser():
    command = argparse.ArgumentParser(description="Run one bounded AX task and retain its receipt.")
    operations = command.add_subparsers(dest="operation", required=True)
    run = operations.add_parser("run")
    run.add_argument("--instruction-file", required=True, type=Path)
    run.add_argument("--input", action="append", default=[], type=Path)
    run.add_argument("--output", required=True)
    run.add_argument("--offline", action="store_true")
    run.add_argument("--dry-run", action="store_true")
    for name in ("inspect", "recover"):
        operations.add_parser(name).add_argument("run_id")
    acknowledge = operations.add_parser("acknowledge-failure", help="Record the cause and verified correction; no AX or model calls.")
    acknowledge.add_argument("run_id")
    acknowledge.add_argument("--note", required=True, help="Cause and correction evidence, 1–2048 UTF-8 bytes.")
    return command


def main(argv=None):
    os.umask(0o077)
    args = parser().parse_args(argv)

    def interrupted(*_):
        raise InterruptedError()

    previous_handler = signal.signal(signal.SIGTERM, interrupted)
    try:
        cli = TaskCLI()
        if args.operation == "run":
            request = make_request(args.instruction_file, args.input, args.output, args.offline)
            result = cli.run(request, dry_run=args.dry_run)
        elif args.operation == "recover":
            result = cli.recover(args.run_id)
        elif args.operation == "acknowledge-failure":
            result = cli.acknowledge_failure(args.run_id, args.note)
        else:
            result = cli.inspect(args.run_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if args.operation in {"inspect", "acknowledge-failure"} or result.get("outcome") in {"succeeded", "dry_run"} else 1
    except (Exception, KeyboardInterrupt) as exc:
        print(json.dumps({"error_type": error_code(exc)}), file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_handler)


if __name__ == "__main__":
    raise SystemExit(main())
