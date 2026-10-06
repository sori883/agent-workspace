from datetime import datetime, timezone
import hashlib
import json
import re
import secrets
import uuid

from task_cli import RUN_ID, TaskError, fingerprint, make_manifest, read_file, read_json
from task_runtime.protocol import MAX_ARTIFACT_BYTES, MAX_INPUT_BYTES, ProtocolError, validate_request, validate_result


MAX_TURNS = 32
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


def identifier(value, code="invalid_conversation_id"):
    if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value):
        raise TaskError(code)
    return str(uuid.UUID(value))


def history_json(messages):
    return json.dumps(messages, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def invalid_state():
    raise TaskError("invalid_conversation_state")


class ChatService:
    def __init__(self, cli, summary=None):
        self.cli = cli
        self.summarize = summary

    def groups(self):
        groups = {}
        if not self.cli.runs.exists():
            return groups
        try:
            for directory in list(self.cli.runs.iterdir()):
                if directory.name.startswith("."):
                    continue
                receipt = self.cli.inspect(directory.name)
                if "conversation" not in receipt:
                    continue
                link = receipt["conversation"]
                if not isinstance(link, dict) or set(link) != {"id", "parent_run_id", "sequence"}:
                    invalid_state()
                cid = identifier(link["id"])
                if cid != link["id"] or type(link["sequence"]) is not int or not 1 <= link["sequence"] <= MAX_TURNS:
                    invalid_state()
                parent = link["parent_run_id"]
                if parent is not None and (not isinstance(parent, str) or not RUN_ID.fullmatch(parent)):
                    invalid_state()
                groups.setdefault(cid, []).append(receipt)
        except (TaskError, OSError, ValueError, TypeError, KeyError, AttributeError):
            invalid_state()
        return groups

    def load(self, cid, groups=None):
        cid = identifier(cid)
        receipts = (self.groups() if groups is None else groups).get(cid)
        if not receipts:
            raise TaskError("conversation_not_found")
        receipts = sorted(receipts, key=lambda receipt: receipt["conversation"]["sequence"])
        if len(receipts) > MAX_TURNS:
            invalid_state()
        entries, history = [], []
        parent = None
        try:
            for index, receipt in enumerate(receipts, 1):
                link = receipt["conversation"]
                if link != {"id": cid, "parent_run_id": parent, "sequence": index}:
                    invalid_state()
                if entries and entries[-1]["receipt"].get("resolved") is not True:
                    invalid_state()
                if receipt.get("adapter") != "antigravity" or type(receipt.get("resolved")) is not bool:
                    invalid_state()
                submission = receipt.get("submission")
                if not isinstance(submission, dict) or not isinstance(submission.get("accepted_at"), str):
                    invalid_state()
                datetime.fromisoformat(submission["accepted_at"].replace("Z", "+00:00"))
                if not submission["accepted_at"].endswith("Z"):
                    invalid_state()
                directory = self.cli.directory(receipt["run_id"])
                request = validate_request(read_json(directory / "request.json"))
                context = history_json(history)
                if (len(context.encode("utf-8")) > MAX_INPUT_BYTES or request["run_id"] != receipt["run_id"]
                        or request["adapter"] != "antigravity" or request["output_name"] != "reply.txt"
                        or request["inputs"] != {"conversation.json": context}
                        or fingerprint(request, receipt["image"]) != receipt.get("fingerprint")):
                    invalid_state()
                result = receipt.get("result")
                if result is not None:
                    result = validate_result(result)
                    if (result["run_id"] != receipt["run_id"] or result["adapter"] != "antigravity"
                            or result["usage"] is not None and any(type(count) is not int for count in result["usage"].values())):
                        invalid_state()
                assistant = None
                if receipt.get("resolved") and receipt.get("outcome") == "succeeded":
                    if (result is None or result["status"] != "succeeded" or receipt.get("cleanup_errors") != []
                            or receipt.get("cleanup") != {"egress_denied": True, "suspended": True}
                            or result["artifact"]["name"] != "reply.txt"):
                        invalid_state()
                    content = read_file(directory / "artifacts/reply.txt", MAX_ARTIFACT_BYTES)
                    artifact = result["artifact"]
                    if len(content) != artifact["size_bytes"] or hashlib.sha256(content).hexdigest() != artifact["sha256"]:
                        invalid_state()
                    assistant = content.decode("utf-8")
                    history.extend(({"role": "user", "content": request["instruction"]},
                                    {"role": "assistant", "content": assistant}))
                entries.append({"receipt": receipt, "user": request["instruction"], "assistant": assistant})
                parent = receipt["run_id"]
        except (TaskError, ProtocolError, OSError, ValueError, TypeError, KeyError, AttributeError):
            invalid_state()
        return {"id": cid, "entries": entries, "history": history,
                "context_full": len(entries) >= MAX_TURNS or len(history_json(history).encode("utf-8")) > MAX_INPUT_BYTES}

    def view(self, conversation, active):
        entries = conversation["entries"]
        turns = [{"summary": self.summarize(entry["receipt"], active), "user": entry["user"], "assistant": entry["assistant"]}
                 for entry in entries]
        head = turns[-1]["summary"]
        title = entries[0]["user"][:60].replace("\r", " ").replace("\n", " ")
        summary = {"id": conversation["id"], "title": title, "updated_at": head["accepted_at"],
                   "head_run_id": head["run_id"], "turn_count": len(turns), "state": head["state"]}
        return {"conversation": summary, "turns": turns, "context_full": conversation["context_full"],
                "can_send": not conversation["context_full"] and all(turn["summary"]["resolved"] for turn in turns)}

    def get(self, cid):
        with self.cli.observing() as active:
            return self.view(self.load(cid), active)

    def list(self):
        with self.cli.observing() as active:
            groups = self.groups()
            rows = [self.view(self.load(cid, groups), active)["conversation"] for cid in groups]
        rows.sort(key=lambda row: (datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")), row["id"]), reverse=True)
        return {"conversations": rows[:50]}

    def accept(self, value):
        if not isinstance(value, dict) or set(value) != {"id", "key", "parent_run_id", "text", "allow_model"}:
            raise TaskError("invalid_request")
        cid = identifier(value["id"])
        key = identifier(value["key"], "invalid_request")
        parent = value["parent_run_id"]
        if parent is not None and (not isinstance(parent, str) or not RUN_ID.fullmatch(parent)):
            raise TaskError("invalid_run_id")
        if type(value["allow_model"]) is not bool:
            raise TaskError("invalid_request")
        if not value["allow_model"]:
            raise TaskError("model_not_allowed")
        request = validate_request({"schema_version": 1, "run_id": "ax-run-" + secrets.token_hex(8),
                                    "adapter": "antigravity", "instruction": value["text"],
                                    "inputs": {"conversation.json": "[]"}, "output_name": "reply.txt"})
        payload = {**value, "id": cid}
        del payload["key"]
        key_hash = hashlib.sha256(key.encode("ascii")).hexdigest()
        payload_hash = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        existing = self.cli.find_submission(key_hash, payload_hash)
        if existing is not None:
            return self.replay(existing, cid)
        with self.cli.locked():
            existing = self.cli.find_submission(key_hash, payload_hash)
            if existing is not None:
                return self.replay(existing, cid)
            groups = self.groups()
            conversation = self.load(cid, groups) if cid in groups else None
            entries = conversation["entries"] if conversation else []
            head = entries[-1]["receipt"]["run_id"] if entries else None
            if parent != head:
                raise TaskError("conversation_conflict")
            if any(entry["receipt"]["resolved"] is not True for entry in entries):
                raise TaskError("conversation_busy")
            if conversation and conversation["context_full"]:
                raise TaskError("conversation_context_full")
            request["inputs"]["conversation.json"] = history_json(conversation["history"] if conversation else [])
            validate_request(request)
            image = read_json(self.cli.root / "versions.json").get("runner_task", "")
            make_manifest(request, image)
            total = self.cli.guard(request, image)
            submission = {"key_hash": key_hash, "payload_hash": payload_hash,
                          "accepted_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
            _, receipt = self.cli.prepare(request, image, total, submission=submission,
                                          conversation={"id": cid, "parent_run_id": head, "sequence": len(entries) + 1})
            return receipt, False

    def replay(self, receipt, cid):
        link = receipt.get("conversation")
        if not isinstance(link, dict) or link.get("id") != cid or not RUN_ID.fullmatch(receipt["run_id"]):
            invalid_state()
        self.load(cid)
        return receipt, True
