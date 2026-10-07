import base64
import binascii
import json
import math
import re


SCHEMA_VERSION = 1
MAX_INSTRUCTION_BYTES = 2048
MAX_INPUT_BYTES = 4096
MAX_INPUTS = 4
MAX_ARTIFACT_BYTES = 65536
MAX_REQUEST_BYTES = 49152
MAX_ENCODED_REQUEST_BYTES = 4 * ((MAX_REQUEST_BYTES + 2) // 3)
RUN_ID_PATTERN = re.compile(r"ax-run-[0-9a-f]{16}\Z")
NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_.:-]{0,95}\Z")
ADAPTERS = frozenset(("antigravity", "offline", "interactive"))
REQUEST_FIELDS = frozenset(("schema_version", "run_id", "adapter", "instruction", "inputs", "output_name"))
RESULT_FIELDS = frozenset(("schema_version", "run_id", "adapter", "status", "exit_code", "stop_reason", "usage", "estimated_usd", "error_type", "artifact"))


class ProtocolError(ValueError):
    pass


def validate_run_id(value):
    if not isinstance(value, str) or not RUN_ID_PATTERN.fullmatch(value):
        raise ProtocolError("InvalidRunId")
    return value


def validate_name(value):
    if not isinstance(value, str) or not NAME_PATTERN.fullmatch(value):
        raise ProtocolError("InvalidName")
    return value


def _text_size(value):
    if not isinstance(value, str) or "\x00" in value:
        raise ProtocolError("InvalidText")
    try:
        return len(value.encode("utf-8"))
    except UnicodeError:
        raise ProtocolError("InvalidText") from None


def validate_request(value):
    if not isinstance(value, dict) or set(value) != REQUEST_FIELDS:
        raise ProtocolError("InvalidRequestFields")
    if type(value["schema_version"]) is not int or value["schema_version"] != SCHEMA_VERSION:
        raise ProtocolError("InvalidSchemaVersion")
    validate_run_id(value["run_id"])
    if not isinstance(value["adapter"], str) or value["adapter"] not in ADAPTERS:
        raise ProtocolError("InvalidAdapter")
    size = _text_size(value["instruction"])
    if not size or size > MAX_INSTRUCTION_BYTES or not value["instruction"].strip():
        raise ProtocolError("InvalidInstructionSize")
    inputs = value["inputs"]
    if not isinstance(inputs, dict) or len(inputs) > MAX_INPUTS:
        raise ProtocolError("InvalidInputs")
    total = 0
    for name, text in inputs.items():
        validate_name(name)
        total += _text_size(text)
    if total > MAX_INPUT_BYTES:
        raise ProtocolError("InputTooLarge")
    validate_name(value["output_name"])
    if value["adapter"] == "interactive":
        if __package__:
            from .interactive_protocol import validate_context
        else:
            from interactive_protocol import validate_context
        validate_context(value)
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("DuplicateJsonKey")
        result[key] = value
    return result


def decode_request(encoded):
    if not isinstance(encoded, str) or len(encoded) > MAX_ENCODED_REQUEST_BYTES:
        raise ProtocolError("RequestTooLarge")
    try:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_REQUEST_BYTES:
            raise ProtocolError("RequestTooLarge")
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
    except ProtocolError:
        raise
    except (UnicodeError, binascii.Error, ValueError, RecursionError):
        raise ProtocolError("InvalidRequestEncoding") from None
    return validate_request(value)


def encode_request(value):
    validate_request(value)
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_REQUEST_BYTES:
        raise ProtocolError("RequestTooLarge")
    return base64.b64encode(data).decode("ascii")


def is_nonnegative_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def validate_result(value):
    if not isinstance(value, dict) or set(value) != RESULT_FIELDS:
        raise ProtocolError("InvalidResultFields")
    if type(value["schema_version"]) is not int or value["schema_version"] != SCHEMA_VERSION:
        raise ProtocolError("InvalidSchemaVersion")
    validate_run_id(value["run_id"])
    if not isinstance(value["adapter"], str) or value["adapter"] not in ADAPTERS:
        raise ProtocolError("InvalidAdapter")
    if value["status"] not in ("succeeded", "failed", "timed_out"):
        raise ProtocolError("InvalidStatus")
    if type(value["exit_code"]) is not int:
        raise ProtocolError("InvalidExitCode")
    for key in ("stop_reason", "error_type"):
        item = value[key]
        if item is not None and (not isinstance(item, str) or not IDENTIFIER_PATTERN.fullmatch(item)):
            raise ProtocolError("InvalidIdentifier")
    usage = value["usage"]
    if usage is not None and (not isinstance(usage, dict) or not usage or any(
        not isinstance(key, str) or not IDENTIFIER_PATTERN.fullmatch(key) or not is_nonnegative_number(number)
        for key, number in usage.items()
    )):
        raise ProtocolError("InvalidUsage")
    if value["estimated_usd"] is not None and not is_nonnegative_number(value["estimated_usd"]):
        raise ProtocolError("InvalidEstimate")
    artifact = value["artifact"]
    if artifact is not None:
        if not isinstance(artifact, dict) or set(artifact) != {"name", "size_bytes", "sha256"}:
            raise ProtocolError("InvalidArtifact")
        validate_name(artifact["name"])
        if type(artifact["size_bytes"]) is not int or not 0 <= artifact["size_bytes"] <= MAX_ARTIFACT_BYTES:
            raise ProtocolError("InvalidArtifactSize")
        if not isinstance(artifact["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]):
            raise ProtocolError("InvalidArtifactHash")
    if value["status"] == "succeeded" and (
        value["exit_code"] != 0 or value["error_type"] is not None or usage is None
        or value["estimated_usd"] is None or artifact is None
    ):
        raise ProtocolError("IncompleteSuccess")
    if value["status"] == "succeeded":
        if value["adapter"] == "offline":
            if value["stop_reason"] != "OFFLINE" or value["estimated_usd"] != 0 or any(usage.values()):
                raise ProtocolError("InvalidOfflineUsage")
        elif value["stop_reason"] != "UNSPECIFIED" or usage.get("prompt_token_count", 0) <= 0 or usage.get("total_token_count", 0) <= 0:
            raise ProtocolError("IncompleteModelUsage")
    if value["status"] != "succeeded" and value["exit_code"] == 0:
        raise ProtocolError("InvalidFailureExitCode")
    return value
