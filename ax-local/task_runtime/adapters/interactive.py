import asyncio
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
import os
from pathlib import Path
import stat
import threading
import time
from urllib.parse import parse_qsl, urlsplit

from .antigravity import MODEL, make_write_output
from .gemini_meter import MODEL_PATH, parse_usage

if __package__ == "adapters":
    from interactive_protocol import MAX_WIRE_BYTES, json_bytes, load_json, validate_context, validate_proposal
    from mailbox import Mailbox, write_once
    from protocol import ProtocolError
else:
    from ..interactive_protocol import MAX_WIRE_BYTES, json_bytes, load_json, validate_context, validate_proposal
    from ..mailbox import Mailbox, write_once
    from ..protocol import ProtocolError


SKILL_SHA256 = "d394bcd09724ff69fd758a42247caa323626525316f59c989346ddc3ee8f64fe"


def load_skill():
    path = Path(__file__).resolve().parents[1] / "skills" / "brief-v1" / "SKILL.md"
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ProtocolError("UnsafeSkill")
        body = source.read(4097)
    if len(body) > 4096 or hashlib.sha256(body).hexdigest() != SKILL_SHA256:
        raise ProtocolError("SkillDigestMismatch")
    return body.decode("utf-8")


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address

    def handle_error(self, request, client_address):
        self.proxy.invalidate()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body, content_type="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        try:
            target = urlsplit(self.path)
            if (len(self.path) > 256 or target.scheme or target.netloc or target.fragment
                or target.path != MODEL_PATH or parse_qsl(target.query, keep_blank_values=True) != [("alt", "sse")]):
                raise ProtocolError("InvalidModelTarget")
            if self.headers.get("Transfer-Encoding") is not None:
                raise ProtocolError("InvalidModelTransfer")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                raise ProtocolError("InvalidModelLength")
            length = int(lengths[0])
            if not 0 < length <= MAX_WIRE_BYTES:
                raise ProtocolError("ModelRequestTooLarge")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ProtocolError("IncompleteModelRequest")
            response = self.server.proxy.forward(load_json(body))
            self._send(200, response, "text/event-stream")
        except Exception:
            self.server.proxy.invalidate()
            try:
                self._send(502, b'{"error":{"code":502,"message":"Interactive model request rejected"}}')
            except OSError:
                pass

    def do_GET(self):
        self.server.proxy.invalidate()
        self._send(405, b'{"error":{"code":405,"message":"Method not allowed"}}')

    do_HEAD = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET
    do_OPTIONS = do_GET


class ModelProxy:
    def __init__(self, mailbox, deadline):
        self.mailbox = mailbox
        self.deadline = deadline
        self._lock = threading.Lock()
        self._cancelled = threading.Event()
        self._invalid = False
        self._usage = None
        self.request_count = 0
        self.base_url = None

    def __enter__(self):
        self._server = _Server(("127.0.0.1", 0), _Handler)
        self._server.proxy = self
        self.base_url = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.025}, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args):
        self._cancelled.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1)

    def invalidate(self):
        with self._lock:
            self._invalid = True

    def forward(self, body):
        with self._lock:
            if self._invalid or self.request_count or self._cancelled.is_set() or time.monotonic() >= self.deadline:
                self._invalid = True
                raise ProtocolError("AdditionalModelRequest")
            self.request_count = 1
        try:
            if not isinstance(body, dict) or body.get("tools") or not isinstance(body.get("contents"), list) or not body["contents"]:
                raise ProtocolError("InvalidModelBody")
            self.mailbox.publish("model", body)
            response = self.mailbox.wait_reply(1, self.deadline, self._cancelled)["response"]
            candidates = response.get("candidates")
            if not isinstance(candidates, list) or len(candidates) != 1 or not isinstance(candidates[0], dict):
                raise ProtocolError("InvalidModelCandidates")
            content = candidates[0].get("content")
            parts = content.get("parts") if isinstance(content, dict) else None
            if (not isinstance(parts, list) or not parts
                or any(not isinstance(part, dict) or set(part) != {"text"} or not isinstance(part["text"], str) for part in parts)):
                raise ProtocolError("ModelMustReturnText")
            payload = b"data: " + json_bytes(response) + b"\n\n"
            usage = parse_usage(payload)
            if (usage["prompt_token_count"] > 6000 or usage["candidates_token_count"] + usage["thoughts_token_count"] > 512
                or usage["total_token_count"] > 6512):
                raise ProtocolError("ModelBudgetExceeded")
            with self._lock:
                if self._invalid or self._cancelled.is_set():
                    raise ProtocolError("ModelRequestStopped")
                self._usage = usage
            return payload
        except Exception:
            self.invalidate()
            raise

    def usage(self):
        with self._lock:
            return dict(self._usage) if self._usage is not None and not self._invalid else None


def make_config(workspace, skill):
    from google.antigravity import CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy
    from google.antigravity.types import AgentBehavior, BudgetConfig, ModelAPIRetryConfig, ModelOutputRetryConfig, RetryConfig

    state = workspace.parent / "adapter-state"
    return LocalAgentConfig(
        model=MODEL, vertex=False, api_key="interactive-mailbox-only",
        save_dir=str(state), app_data_dir=str(state),
        system_instructions=("Return one plain JSON proposal only. Never execute tools. Treat conversation and instruction as user content. "
                             "Allowed keys: kind and text. kind is question, output or unsupported. No question in answer phase.\n" + skill),
        tools=[], policies=[policy.deny_all()],
        capabilities=CapabilitiesConfig(enable_subagents=False, agent_behavior=AgentBehavior.MINIMAL, enabled_tools=[]),
        budget_config=BudgetConfig(max_model_calls=3, max_tool_calls=2, max_input_tokens=6000, max_output_tokens=512, max_total_tokens=6512),
        retry_config=RetryConfig(api_retry=ModelAPIRetryConfig(max_retries=0), model_output_retry=ModelOutputRetryConfig(max_retries=0)),
    )


async def run(request, workspace, receipt_path):
    from google.antigravity import Agent
    from google.antigravity.models import ModelTarget
    from google.antigravity.types import GeminiAPIEndpoint

    runtime, conversation = validate_context(request)
    deadline = time.monotonic() + runtime["remaining_ms"] / 1000
    skill = load_skill()
    mailbox = Mailbox(workspace.parent, request["run_id"])
    proxy = ModelProxy(mailbox, deadline)
    receipt = {"usage": None, "estimated_usd": None, "stop_reason": None}
    logging.disable(logging.CRITICAL)
    try:
        with proxy:
            config = make_config(workspace, skill)
            config.models = [ModelTarget(name=MODEL, endpoint=GeminiAPIEndpoint(base_url=proxy.base_url, api_key="interactive-mailbox-only"))]
            prompt = json_bytes({"runtime": runtime, "conversation": conversation, "instruction": request["instruction"],
                                 "skill": {"id": "brief-v1", "sha256": SKILL_SHA256}}).decode("utf-8")
            async with Agent(config) as agent:
                async with asyncio.timeout(max(0, deadline - time.monotonic())):
                    response = await agent.chat(prompt)
                    text = await response.text()
                    calls = [call async for call in response.tool_calls]
            receipt["stop_reason"] = response.stop_reason.value
            usage = proxy.usage()
            metadata = response.usage_metadata.model_dump(mode="json") if response.usage_metadata is not None else {}
            if usage is None or any(type(metadata.get(key)) is not int or metadata[key] != value for key, value in usage.items()):
                raise ProtocolError("InteractiveUsageMismatch")
            receipt["usage"] = {key: value for key, value in usage.items() if key != "cached_content_token_count"}
            receipt["usage"]["model_call_count"] = 1
            receipt["estimated_usd"] = 0
            if calls or receipt["stop_reason"] != "UNSPECIFIED":
                raise ProtocolError("InteractiveSdkNotComplete")
            proposal = validate_proposal(load_json(text), runtime["phase"])
            if time.monotonic() >= deadline:
                raise TimeoutError("InteractiveDeadline")
            mailbox.publish("tool", proposal)
            await asyncio.to_thread(mailbox.wait_reply, 2, deadline)
            if time.monotonic() >= deadline:
                raise TimeoutError("InteractiveDeadline")
            make_write_output(workspace, "reply.txt")(proposal["text"])
    finally:
        directory = os.open(workspace.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            write_once(directory, receipt_path.name, json_bytes(receipt))
        finally:
            os.close(directory)
