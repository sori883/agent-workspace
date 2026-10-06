import hashlib
from datetime import datetime
import json
import re
import secrets
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from task_cli import ROOT, RUN_ID, TaskCLI, TaskError, read_file, read_json, submission_key, validate_owner
from task_runtime.protocol import MAX_ARTIFACT_BYTES, ProtocolError, validate_request, validate_result


MAX_INPUT = 64 * 1024
MAX_OUTPUT = 512 * 1024
MAX_CHAT_RESPONSE_BYTES = 1024 * 1024
CHAT_OPERATIONS = {"conversations", "conversation", "chat"}
SAFE_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,95}\Z")


def safe_code(value, fallback="backend_unavailable"):
    value = value.split(":", 1)[0] if isinstance(value, str) else ""
    return value if SAFE_CODE.fullmatch(value) else fallback


def error_response(error):
    code = safe_code(str(error)) if isinstance(error, TaskError) else "backend_unavailable"
    if isinstance(error, ProtocolError):
        code = "invalid_request"
    status = 503
    if code in {"invalid_request", "model_not_allowed", "invalid_run_id", "invalid_conversation_id", "invalid_owner_user_id"}:
        status = 400
    elif code in {"run_not_found", "artifact_unavailable", "conversation_not_found"}:
        status = 404
    elif code in {"idempotency_conflict", "another_cli_running", "unresolved_run", "unknown_paid_usage",
                  "paid_failure_requires_review", "failed_request_already_attempted", "pilot_estimate_limit_reached",
                  "execution_already_claimed", "conversation_conflict", "conversation_busy", "invalid_conversation_state"}:
        status = 409
    elif code == "request_too_large":
        status = 413
    elif code == "conversation_context_full":
        status = 422
    return {"ok": False, "error": {"code": code, "status": status}}


def object_fields(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise TaskError("invalid_request")


def parse_submission(value, owner_user_id):
    object_fields(value, ("key", "mode", "instruction", "input_text", "output_name", "allow_model"))
    if not isinstance(value["key"], str) or not re.fullmatch(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value["key"]):
        raise TaskError("invalid_request")
    key = str(uuid.UUID(value["key"]))
    if value["mode"] not in ("offline", "model") or type(value["allow_model"]) is not bool:
        raise TaskError("invalid_request")
    if value["mode"] == "model" and not value["allow_model"]:
        raise TaskError("model_not_allowed")
    if not isinstance(value["input_text"], str):
        raise TaskError("invalid_request")
    request = validate_request({
        "schema_version": 1, "run_id": "ax-run-" + secrets.token_hex(8),
        "adapter": "offline" if value["mode"] == "offline" else "antigravity",
        "instruction": value["instruction"],
        "inputs": {"input.txt": value["input_text"]} if value["input_text"] else {},
        "output_name": value["output_name"],
    })
    payload = {name: item for name, item in value.items() if name != "key"}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return request, submission_key(owner_user_id, key), digest


class WebBridge:
    def __init__(self, cli=None, launch=None, *, owner_user_id):
        self.owner_user_id = validate_owner(owner_user_id)
        self.cli = cli or TaskCLI()
        self.launch = launch or self.start_worker

    def start_worker(self, operation, run_id):
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_" + operation, run_id],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)

    def record_spawn_failure(self, run_id):
        try:
            with self.cli.locked():
                receipt = self.cli.inspect(run_id)
                if not receipt.get("resolved"):
                    self.cli.store(self.cli.directory(run_id), receipt, error_type="worker_spawn_failed")
        except (OSError, TaskError):
            pass

    def admit(self, accept):
        deadline = time.monotonic() + 0.5
        while True:
            try:
                receipt, replayed = accept()
                break
            except TaskError as error:
                if str(error) != "another_cli_running" or time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
        if not replayed:
            try:
                self.launch("execute", receipt["run_id"])
            except OSError:
                self.record_spawn_failure(receipt["run_id"])
        return receipt, replayed

    def submit(self, value):
        request, key_hash, payload_hash = parse_submission(value, self.owner_user_id)
        receipt, replayed = self.admit(lambda: self.cli.accept(request, key_hash, payload_hash, self.owner_user_id))
        return {"run_id": receipt["run_id"], "replayed": replayed}

    def chat_service(self):
        from chat import ChatService
        return ChatService(self.cli, self.summary, owner_user_id=self.owner_user_id)

    def conversations(self, value):
        object_fields(value, ())
        return self.chat_service().list()

    def conversation(self, value):
        object_fields(value, ("id",))
        return self.chat_service().get(value["id"])

    def chat(self, value):
        receipt, replayed = self.admit(lambda: self.chat_service().accept(value))
        return {"conversation_id": receipt["conversation"]["id"], "run_id": receipt["run_id"], "replayed": replayed}

    def summary(self, receipt, active):
        resolved = receipt.get("resolved")
        if type(resolved) is not bool or receipt.get("adapter") not in ("offline", "antigravity"):
            raise TaskError("invalid_run_ledger")
        phase = safe_code(receipt.get("phase"), "unknown")
        active = active and not resolved
        if resolved:
            state = "not_started" if receipt.get("outcome") in ("not_started", "dry_run") else "succeeded" if receipt.get("outcome") == "succeeded" else "failed"
        elif phase == "accepted":
            state = "accepted"
        else:
            state = "running" if active else "needs_recovery"
        submission = receipt.get("submission")
        accepted_at = submission.get("accepted_at") if isinstance(submission, dict) else None
        if accepted_at is not None and (not isinstance(accepted_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", accepted_at)):
            raise TaskError("invalid_run_ledger")
        return {"run_id": receipt["run_id"], "adapter": receipt["adapter"], "accepted_at": accepted_at,
                "state": state, "phase": phase, "resolved": resolved, "active": active,
                "can_recover": not resolved and not active,
                "error_type": safe_code(receipt["error_type"]) if receipt.get("error_type") is not None else None}

    def list(self, value):
        object_fields(value, ())
        with self.cli.observing() as active:
            if not self.cli.runs.exists():
                return {"runs": []}
            rows = []
            conversation_groups = None
            for directory in self.cli.runs.iterdir():
                if directory.name.startswith("."):
                    continue
                receipt = self.cli.inspect(directory.name)
                if receipt.get("owner_user_id") != self.owner_user_id:
                    continue
                if "conversation" in receipt:
                    if conversation_groups is None:
                        conversation_groups = self.chat_service().groups()
                    self.require_owner(receipt, conversation_groups)
                summary = self.summary(receipt, active)
                created_at = datetime.fromisoformat(summary["accepted_at"].replace("Z", "+00:00")).timestamp() if summary["accepted_at"] else directory.stat().st_mtime
                rows.append((created_at, summary))
        rows.sort(key=lambda row: (row[0], row[1]["run_id"]), reverse=True)
        return {"runs": [row[1] for row in rows[:50]]}

    def get(self, value):
        object_fields(value, ("run_id",))
        with self.cli.observing() as active:
            receipt = self.cli.inspect(value["run_id"])
            self.require_owner(receipt)
            directory = self.cli.directory(value["run_id"])
            request = validate_request(read_json(directory / "request.json"))
            result = receipt.get("result")
            if result is not None:
                result = validate_result(result)
                if result["usage"] is not None and any(type(count) is not int for count in result["usage"].values()):
                    raise TaskError("invalid_run_ledger")
            if request["run_id"] != receipt["run_id"] or request["adapter"] != receipt["adapter"] or (result and (result["run_id"] != receipt["run_id"] or result["adapter"] != receipt["adapter"])):
                raise TaskError("invalid_run_ledger")
            cleanup = receipt.get("cleanup", {})
            return {"summary": self.summary(receipt, active), "request": request, "result": result,
                    "cleanup": {"egress_denied": cleanup.get("egress_denied") is True, "suspended": cleanup.get("suspended") is True},
                    "cleanup_errors": [safe_code(item) for item in receipt.get("cleanup_errors", [])]}

    def artifact(self, value):
        details = self.get(value)
        artifact = details["result"]["artifact"] if details["result"] else None
        if artifact is None:
            raise TaskError("artifact_unavailable")
        if artifact["name"] != details["request"]["output_name"]:
            raise TaskError("artifact_verification_failed")
        content = read_file(self.cli.directory(value["run_id"]) / "artifacts" / artifact["name"], MAX_ARTIFACT_BYTES)
        if len(content) != artifact["size_bytes"] or hashlib.sha256(content).hexdigest() != artifact["sha256"]:
            raise TaskError("artifact_verification_failed")
        return {"name": artifact["name"], "content": content.decode("utf-8")}

    def recover(self, value):
        object_fields(value, ("run_id",))
        self.require_owner(self.cli.inspect(value["run_id"]))
        with self.cli.locked():
            receipt = self.cli.inspect(value["run_id"])
            self.require_owner(receipt)
            resolved = receipt.get("resolved") is True
        if not resolved:
            try:
                self.launch("recover", value["run_id"])
            except OSError:
                self.record_spawn_failure(value["run_id"])
        return {"run_id": value["run_id"]}

    def require_owner(self, receipt, conversation_groups=None):
        if receipt.get("owner_user_id") != self.owner_user_id:
            raise TaskError("run_not_found")
        if "conversation" in receipt:
            link = receipt["conversation"]
            if not isinstance(link, dict) or not isinstance(link.get("id"), str):
                raise TaskError("invalid_conversation_state")
            self.chat_service().authorize(link["id"], conversation_groups)

    @classmethod
    def dispatch(cls, operation, value, *, cli=None, launch=None):
        if operation not in {"submit", "list", "get", "artifact", "recover"} | CHAT_OPERATIONS:
            raise TaskError("invalid_request")
        if not isinstance(value, dict):
            raise TaskError("invalid_request")
        owner = validate_owner(value.get("owner_user_id"))
        object_fields(value, ("owner_user_id", "input"))
        if not isinstance(value["input"], dict):
            raise TaskError("invalid_request")
        scoped = cls(cli, launch, owner_user_id=owner)
        return {"ok": True, "data": getattr(scoped, operation)(value["input"])}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TaskError("invalid_request")
        result[key] = value
    return result


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) == 2 and args[0] in {"_execute", "_recover"}:
            if not RUN_ID.fullmatch(args[1]):
                return 1
            def interrupted(*_):
                raise InterruptedError()
            signal.signal(signal.SIGTERM, interrupted)
            cli = TaskCLI()
            if args[0] == "_execute":
                cli.execute_accepted(args[1])
            else:
                cli.recover(args[1], wait_seconds=2)
            return 0
        if len(args) != 1:
            raise TaskError("invalid_request")
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise TaskError("request_too_large")
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError, RecursionError):
            raise TaskError("invalid_request") from None
        response = WebBridge.dispatch(args[0], value)
    except (Exception, KeyboardInterrupt) as error:
        if args and args[0].startswith("_"):
            return 1
        response = error_response(error)
    encoded = json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")
    limit = MAX_CHAT_RESPONSE_BYTES if args and args[0] in CHAT_OPERATIONS else MAX_OUTPUT
    if len(encoded) + 1 > limit:
        response = error_response(TaskError("response_too_large"))
        encoded = json.dumps(response).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
