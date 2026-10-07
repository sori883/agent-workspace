import json
import re

if __package__:
    from .protocol import ProtocolError, _text_size, _unique_object
else:
    from protocol import ProtocolError, _text_size, _unique_object


MAX_WIRE_BYTES = 65536
MAX_PROPOSAL_BYTES = 2048
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")


def _invalid_constant(value):
    raise ProtocolError("InvalidJsonNumber")


def load_json(data, limit=MAX_WIRE_BYTES):
    try:
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, bytes) or len(data) > limit:
            raise ProtocolError("JsonTooLarge")
        return json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except ProtocolError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise ProtocolError("InvalidJson") from None


def json_bytes(value, limit=MAX_WIRE_BYTES):
    try:
        data = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (UnicodeError, ValueError, TypeError, RecursionError):
        raise ProtocolError("InvalidJson") from None
    if len(data) > limit:
        raise ProtocolError("JsonTooLarge")
    return data


def _text(value):
    size = _text_size(value)
    if not size or size > MAX_PROPOSAL_BYTES or not value.strip():
        raise ProtocolError("InvalidInteractiveText")
    return value


def validate_proposal(value, phase):
    if not isinstance(value, dict) or set(value) != {"kind", "text"}:
        raise ProtocolError("InvalidProposalFields")
    if value["kind"] not in ("question", "output", "unsupported"):
        raise ProtocolError("InvalidProposalKind")
    if phase == "answer" and value["kind"] == "question":
        raise ProtocolError("RepeatedQuestion")
    _text(value["text"])
    return value


def validate_context(request):
    if request["output_name"] != "reply.txt" or set(request["inputs"]) != {"runtime.json", "conversation.json"}:
        raise ProtocolError("InvalidInteractiveInputs")
    runtime = load_json(request["inputs"]["runtime.json"], 4096)
    if not isinstance(runtime, dict) or set(runtime) != {"version", "root_id", "phase", "question_id", "skill_id", "remaining_ms"}:
        raise ProtocolError("InvalidRuntimeFields")
    if type(runtime["version"]) is not int or runtime["version"] != 1:
        raise ProtocolError("InvalidRuntimeVersion")
    if not isinstance(runtime["root_id"], str) or not UUID_PATTERN.fullmatch(runtime["root_id"]):
        raise ProtocolError("InvalidRootId")
    if runtime["phase"] not in ("request", "answer") or runtime["skill_id"] != "brief-v1":
        raise ProtocolError("InvalidRuntimeMode")
    expected_question = runtime["root_id"] if runtime["phase"] == "answer" else None
    if runtime["question_id"] != expected_question:
        raise ProtocolError("InvalidQuestionId")
    if type(runtime["remaining_ms"]) is not int or not 1 <= runtime["remaining_ms"] <= 90000:
        raise ProtocolError("InvalidRemainingTime")
    conversation = load_json(request["inputs"]["conversation.json"], 4096)
    roles = [] if runtime["phase"] == "request" else ["user", "assistant"]
    if not isinstance(conversation, list) or len(conversation) != len(roles):
        raise ProtocolError("InvalidConversation")
    for message, role in zip(conversation, roles):
        if not isinstance(message, dict) or set(message) != {"role", "content"} or message["role"] != role:
            raise ProtocolError("InvalidConversationMessage")
        _text(message["content"])
    return runtime, conversation
