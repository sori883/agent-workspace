import base64
import binascii
from contextlib import contextmanager
import fcntl
import hashlib
import math
import os
from pathlib import Path
import stat
import time
import uuid

if __package__:
    from .interactive_protocol import MAX_WIRE_BYTES, json_bytes, load_json, validate_context, validate_proposal
    from .protocol import MAX_REQUEST_BYTES, ProtocolError, validate_request, validate_run_id
else:
    from interactive_protocol import MAX_WIRE_BYTES, json_bytes, load_json, validate_context, validate_proposal
    from protocol import MAX_REQUEST_BYTES, ProtocolError, validate_request, validate_run_id


def read_file(directory, name, limit=MAX_WIRE_BYTES):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ProtocolError("UnsafeMailboxFile")
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ProtocolError("MailboxTooLarge")
    return data


def maybe_read(directory, name):
    try:
        return read_file(directory, name)
    except FileNotFoundError:
        return None


def write_once(directory, name, data):
    temporary = uuid.uuid4().hex + ".pending"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
    finally:
        os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)


class Mailbox:
    version = 1
    validate_request = staticmethod(validate_request)
    validate_proposal = staticmethod(validate_proposal)

    def _phase(self, request):
        return validate_context(request)[0]["phase"]

    def __init__(self, root, run_id):
        self.root = Path(root)
        self.run_id = validate_run_id(run_id)

    @contextmanager
    def _locked(self, create=False):
        root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        directory = lock = None
        try:
            request = self.validate_request(load_json(read_file(root, "request.json", MAX_REQUEST_BYTES)))
            if request["run_id"] != self.run_id or request["adapter"] != "interactive":
                raise ProtocolError("MailboxRunMismatch")
            if create:
                if read_file(root, "start", 128) != self.run_id.encode("ascii"):
                    raise ProtocolError("MailboxNotStarted")
                read_file(root, "attempted", 128)
                if maybe_read(root, "result.json") is not None:
                    raise ProtocolError("MailboxFinished")
                try:
                    os.mkdir("mailbox", mode=0o700, dir_fd=root)
                    os.fsync(root)
                except FileExistsError:
                    pass
            try:
                directory = os.open("mailbox", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
                lock = os.open("lock", os.O_RDWR | os.O_NOFOLLOW | (os.O_CREAT if create else 0), 0o600, dir_fd=directory)
            except FileNotFoundError:
                if create:
                    raise
                yield None, request
                return
            if not stat.S_ISREG(os.fstat(lock).st_mode):
                raise ProtocolError("UnsafeMailboxLock")
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield directory, request
        finally:
            if lock is not None:
                os.close(lock)
            if directory is not None:
                os.close(directory)
            os.close(root)

    def _request(self, raw, phase):
        value = load_json(raw)
        if not isinstance(value, dict) or set(value) != {"version", "run_id", "sequence", "kind", "body"}:
            raise ProtocolError("InvalidMailboxRequest")
        if type(value["version"]) is not int or value["version"] != self.version or value["run_id"] != self.run_id:
            raise ProtocolError("MailboxRunMismatch")
        if type(value["sequence"]) is not int or (value["sequence"], value["kind"]) not in ((1, "model"), (2, "tool")):
            raise ProtocolError("InvalidMailboxSequence")
        if not isinstance(value["body"], dict):
            raise ProtocolError("InvalidMailboxBody")
        if value["kind"] == "tool":
            self.validate_proposal(value["body"], phase)
        return value

    def _reply(self, raw, request_raw, phase):
        value = load_json(raw)
        request = self._request(request_raw, phase)
        if not isinstance(value, dict) or set(value) != {"version", "run_id", "sequence", "request_sha256", "status", "body"}:
            raise ProtocolError("InvalidMailboxReply")
        if (type(value["version"]) is not int or value["version"] != self.version or value["run_id"] != self.run_id
            or type(value["sequence"]) is not int or value["sequence"] != request["sequence"]
            or value["request_sha256"] != hashlib.sha256(request_raw).hexdigest()):
            raise ProtocolError("MailboxReplyMismatch")
        if value["status"] not in ("ok", "denied") or not isinstance(value["body"], dict):
            raise ProtocolError("InvalidMailboxReplyBody")
        if value["status"] == "ok":
            if request["kind"] == "model":
                if set(value["body"]) not in ({"response"}, {"response", "billing"}) or not isinstance(value["body"]["response"], dict):
                    raise ProtocolError("InvalidModelReply")
                if "billing" in value["body"]:
                    billing = value["body"]["billing"]
                    if (not isinstance(billing, dict) or set(billing) != {"profile_id", "estimated_usd"}
                        or billing["profile_id"] not in ("preview-v1", "gemini-3.1-flash-lite-standard-2026-10-07-v1")
                        or type(billing["estimated_usd"]) not in (int, float)
                        or not math.isfinite(billing["estimated_usd"]) or billing["estimated_usd"] < 0):
                        raise ProtocolError("InvalidModelBilling")
            elif value["body"] != {"accepted": True} or value["body"].get("accepted") is not True:
                raise ProtocolError("InvalidToolReply")
        return value

    def publish(self, kind, body):
        if kind not in ("model", "tool"):
            raise ProtocolError("InvalidMailboxKind")
        sequence = 1 if kind == "model" else 2
        raw = json_bytes({"version": self.version, "run_id": self.run_id, "sequence": sequence, "kind": kind, "body": body})
        with self._locked(create=True) as (directory, request):
            phase = self._phase(request)
            self._request(raw, phase)
            if sequence == 2:
                first = read_file(directory, "1.request.json")
                response = self._reply(read_file(directory, "1.reply.json"), first, phase)
                if response["status"] != "ok":
                    raise ProtocolError("PreviousOperationDenied")
            write_once(directory, f"{sequence}.request.json", raw)
        return sequence

    def pending(self):
        with self._locked() as (directory, request):
            if directory is None:
                return None
            phase = self._phase(request)
            for sequence in (1, 2):
                raw = maybe_read(directory, f"{sequence}.request.json")
                if raw is None:
                    return None
                value = self._request(raw, phase)
                if value["sequence"] != sequence:
                    raise ProtocolError("MailboxSequenceMismatch")
                response = maybe_read(directory, f"{sequence}.reply.json")
                if response is None:
                    return {"request_base64": base64.b64encode(raw).decode("ascii"), "sha256": hashlib.sha256(raw).hexdigest()}
                self._reply(response, raw, phase)
            return None

    def respond(self, encoded):
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_WIRE_BYTES + 2) // 3):
            raise ProtocolError("MailboxReplyTooLarge")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ProtocolError("InvalidMailboxEncoding") from None
        value = load_json(raw)
        if not isinstance(value, dict) or type(value.get("sequence")) is not int or value["sequence"] not in (1, 2):
            raise ProtocolError("InvalidMailboxSequence")
        sequence = value["sequence"]
        with self._locked() as (directory, request):
            if directory is None:
                raise ProtocolError("MailboxRequestMissing")
            original = read_file(directory, f"{sequence}.request.json")
            self._reply(raw, original, self._phase(request))
            canonical = json_bytes(value)
            existing = maybe_read(directory, f"{sequence}.reply.json")
            if existing is None:
                write_once(directory, f"{sequence}.reply.json", canonical)
            elif existing != canonical:
                raise ProtocolError("MailboxReplyConflict")
        return {"run_id": self.run_id, "sequence": sequence, "state": "replied"}

    def wait_reply(self, sequence, deadline, cancelled=None):
        if sequence not in (1, 2) or type(sequence) is not int:
            raise ProtocolError("InvalidMailboxSequence")
        while time.monotonic() < deadline:
            if cancelled is not None and cancelled.is_set():
                raise ProtocolError("MailboxCancelled")
            with self._locked() as (directory, request):
                if directory is not None:
                    raw = maybe_read(directory, f"{sequence}.reply.json")
                    if raw is not None:
                        original = read_file(directory, f"{sequence}.request.json")
                        value = self._reply(raw, original, self._phase(request))
                        if value["status"] != "ok":
                            raise ProtocolError("OperationDenied")
                        return value["body"]
            time.sleep(min(0.025, max(0, deadline - time.monotonic())))
        raise TimeoutError("MailboxDeadline")
