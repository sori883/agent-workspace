import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import ssl
import threading
import time
from urllib.parse import parse_qsl, urlsplit


UPSTREAM_ORIGIN = "https://generativelanguage.googleapis.com"
MODEL_PATH = "/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent"
MAX_CALLS = 3
MAX_REQUEST_BYTES = 131072
MAX_RESPONSE_BYTES = 524288
REQUEST_TIMEOUT = 25
MAX_TOKENS = 1000000
TOKEN_FIELDS = {
    "promptTokenCount": "prompt_token_count",
    "candidatesTokenCount": "candidates_token_count",
    "thoughtsTokenCount": "thoughts_token_count",
    "totalTokenCount": "total_token_count",
    "cachedContentTokenCount": "cached_content_token_count",
}


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DuplicateKey")
        result[key] = value
    return result


def _token(value):
    if type(value) is not int or not 0 <= value <= MAX_TOKENS:
        raise ValueError("InvalidTokenCount")
    return value


def parse_usage(body):
    text = body.decode("utf-8").replace("\r\n", "\n")
    if not text.endswith("\n\n"):
        raise ValueError("IncompleteEventStream")
    last = None
    maxima = {}
    finished = False
    done = False
    for block in text.split("\n\n"):
        data = []
        for line in block.split("\n"):
            if not line or line.startswith(":"):
                continue
            field, separator, value = line.partition(":")
            if not separator or field not in ("data", "event", "id", "retry"):
                raise ValueError("InvalidEventStream")
            if field == "data":
                data.append(value.removeprefix(" "))
        if not data:
            continue
        payload = "\n".join(data)
        if done:
            raise ValueError("TrailingEvent")
        if payload == "[DONE]":
            done = True
            continue
        value = json.loads(payload, object_pairs_hook=_object)
        if not isinstance(value, dict) or "error" in value:
            raise ValueError("InvalidModelResponse")
        candidates = value.get("candidates", [])
        if not isinstance(candidates, list) or len(candidates) > 1:
            raise ValueError("InvalidCandidates")
        for candidate in candidates:
            if not isinstance(candidate, dict) or candidate.get("index", 0) != 0:
                raise ValueError("InvalidCandidate")
            reason = candidate.get("finishReason")
            if reason:
                if reason != "STOP":
                    raise ValueError("IncompleteGeneration")
                finished = True
        metadata = value.get("usageMetadata")
        if metadata is not None:
            if not isinstance(metadata, dict):
                raise ValueError("InvalidUsage")
            for name in TOKEN_FIELDS:
                if name in metadata:
                    maxima[name] = max(maxima.get(name, 0), _token(metadata[name]))
        last = value
    if last is None or not finished:
        raise ValueError("MissingFinalResponse")
    metadata = last.get("usageMetadata")
    if not isinstance(metadata, dict):
        raise ValueError("MissingFinalUsage")
    required = ("promptTokenCount", "candidatesTokenCount", "totalTokenCount")
    if any(name not in metadata for name in required):
        raise ValueError("MissingTokenCount")
    usage = {target: _token(metadata.get(source, 0)) for source, target in TOKEN_FIELDS.items()}
    if usage["prompt_token_count"] == 0 or usage["total_token_count"] == 0:
        raise ValueError("EmptyUsage")
    if usage["cached_content_token_count"] > usage["prompt_token_count"]:
        raise ValueError("InvalidCachedUsage")
    if usage["total_token_count"] != sum(usage[name] for name in ("prompt_token_count", "candidates_token_count", "thoughts_token_count")):
        raise ValueError("InconsistentUsage")
    if _token(metadata.get("toolUsePromptTokenCount", 0)) != 0:
        raise ValueError("UnsupportedToolUsage")
    if any(metadata.get(name, 0) < count for name, count in maxima.items()):
        raise ValueError("DecreasingUsage")
    return usage


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(3)
        return connection, address

    def handle_error(self, request, client_address):
        self.meter.invalidate()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, payload, content_type="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def do_POST(self):
        meter = self.server.meter
        try:
            target = urlsplit(self.path)
            if (len(self.path) > 256 or target.scheme or target.netloc or target.fragment
                or target.path != MODEL_PATH or parse_qsl(target.query, keep_blank_values=True) != [("alt", "sse")]):
                raise ValueError("InvalidTarget")
            if self.headers.get("Transfer-Encoding") is not None:
                raise ValueError("UnsupportedTransferEncoding")
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                raise ValueError("InvalidContentLength")
            length = int(lengths[0])
            if not 0 < length <= MAX_REQUEST_BYTES:
                raise ValueError("RequestTooLarge")
            body = self.rfile.read(length)
            if len(body) != length or not isinstance(json.loads(body, object_pairs_hook=_object), dict):
                raise ValueError("InvalidRequest")
            payload = meter.forward(body)
            self._send(200, payload, "text/event-stream")
        except Exception:
            meter.invalidate()
            try:
                self._send(502, b'{"error":{"code":502,"message":"Model usage could not be verified"}}')
            except (OSError, ValueError):
                pass

    def do_GET(self):
        self.server.meter.invalidate()
        self._send(405, b'{"error":{"code":405,"message":"Method not allowed"}}')

    do_HEAD = do_GET
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET
    do_OPTIONS = do_GET


class GeminiMeter:
    def __init__(self, api_key, *, upstream_origin=UPSTREAM_ORIGIN):
        origin = urlsplit(upstream_origin)
        production = upstream_origin == UPSTREAM_ORIGIN
        testing = origin.scheme == "http" and origin.hostname == "127.0.0.1" and origin.port is not None
        if not (production or testing) or origin.username or origin.password or origin.path or origin.query or origin.fragment:
            raise ValueError("InvalidUpstream")
        if not isinstance(api_key, str) or not api_key or "\r" in api_key or "\n" in api_key:
            raise ValueError("InvalidApiKey")
        self._key = api_key
        self._origin = origin
        self._lock = threading.Lock()
        self._unknown = False
        self._closed = False
        self._active = set()
        self._sockets = set()
        self._responses = set()
        self._usages = []
        self.request_count = 0
        self.base_url = None
        self._server = None
        self._thread = None

    def __enter__(self):
        self._server = _Server(("127.0.0.1", 0), _Handler)
        self._server.meter = self
        self.base_url = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *args):
        with self._lock:
            self._closed = True
            active = tuple(self._active)
            sockets = tuple(self._sockets)
            responses = tuple(self._responses)
            if active:
                self._unknown = True
        for upstream_socket in sockets:
            try:
                upstream_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for response in responses:
            response.close()
        for connection in active:
            connection.close()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=1)
        self._key = ""

    def invalidate(self):
        with self._lock:
            self._unknown = True

    def forward(self, body):
        with self._lock:
            if self._closed or self._unknown or self.request_count >= MAX_CALLS or self._active:
                self._unknown = True
                raise ValueError("MeterStopped")
            self.request_count += 1
            try:
                if self._origin.scheme == "https":
                    connection = http.client.HTTPSConnection(self._origin.hostname, timeout=REQUEST_TIMEOUT, context=ssl.create_default_context())
                else:
                    connection = http.client.HTTPConnection(self._origin.hostname, self._origin.port, timeout=REQUEST_TIMEOUT)
            except Exception:
                self._unknown = True
                raise
            self._active.add(connection)
        deadline = time.monotonic() + REQUEST_TIMEOUT
        upstream_socket = None
        response = None
        try:
            connection.connect()
            connection.auto_open = 0
            upstream_socket = connection.sock
            with self._lock:
                if self._closed or self._unknown:
                    raise ValueError("MeterStopped")
                self._sockets.add(upstream_socket)
            connection.request("POST", MODEL_PATH + "?alt=sse", body=body, headers={
                "Content-Type": "application/json", "Accept": "text/event-stream",
                "x-goog-api-key": self._key, "Connection": "close",
            })
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("UpstreamTimeout")
            upstream_socket.settimeout(remaining)
            response = connection.getresponse()
            with self._lock:
                if self._closed or self._unknown:
                    raise ValueError("MeterStopped")
                self._responses.add(response)
            if response.status != 200 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "text/event-stream":
                raise ValueError("UpstreamFailed")
            declared = response.getheader("Content-Length")
            if declared is not None and (not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                raise ValueError("ResponseTooLarge")
            chunks = []
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("UpstreamTimeout")
                upstream_socket.settimeout(remaining)
                chunk = response.read1(min(65536, MAX_RESPONSE_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise ValueError("ResponseTooLarge")
                if response.isclosed():
                    break
            if declared is not None and size != int(declared):
                raise ValueError("IncompleteResponse")
            payload = b"".join(chunks)
            usage = parse_usage(payload)
            with self._lock:
                if self._unknown:
                    raise ValueError("MeterStopped")
                self._usages.append(usage)
            return payload
        except Exception:
            self.invalidate()
            raise
        finally:
            if response is not None:
                response.close()
            connection.close()
            with self._lock:
                self._active.discard(connection)
                self._sockets.discard(upstream_socket)
                self._responses.discard(response)

    def usage(self):
        with self._lock:
            if self._unknown or self._active or not self.request_count or len(self._usages) != self.request_count:
                return None
            return {name: sum(value[name] for value in self._usages) for name in TOKEN_FIELDS.values()}
