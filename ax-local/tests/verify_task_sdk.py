import asyncio
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, "/opt/ax-task")

from adapters import antigravity
from adapters.gemini_meter import GeminiMeter


async def check_case(root, case):
    workspace = root / case / "output"
    workspace.mkdir(parents=True)
    target = workspace / "answer.txt"
    forbidden = case in ("outside", "traversal", "symlink")
    if case == "outside":
        target = root / "outside.txt"
    elif case == "traversal":
        target = workspace / ".." / "outside.txt"
    elif case == "symlink":
        target.symlink_to(root / "outside.txt")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            mode = request.get("toolConfig", {}).get("functionCallingConfig", {}).get("mode")
            if case == "api-error" or case == "late-api-error" and len(requests) > 1:
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b'{"error":{"code":503,"message":"offline failure"}}')
                return
            if (len(requests) == 1 or case in ("budget", "model-budget", "malformed")) and mode != "NONE":
                part = {"functionCall": {"name": "write_output", "args": {"content": "AX_INPUT_OK\n"}}}
                if case in ("outside", "traversal"):
                    part["functionCall"]["args"]["TargetFile"] = str(target)
                if case == "malformed":
                    part["functionCall"]["args"] = {}
            else:
                part = {"text": "Done."}
            response = {"candidates": [{"content": {"role": "model", "parts": [part]},
                                       "finishReason": "STOP", "index": 0}]}
            if case != "usage-missing" and not (case == "late-usage-missing" and len(requests) > 1):
                response["usageMetadata"] = {"promptTokenCount": 100, "candidatesTokenCount": 20,
                                             "thoughtsTokenCount": 0, "totalTokenCount": 120}
                if case == "usage-zero":
                    response["usageMetadata"] = {key: 0 for key in response["usageMetadata"]}
            payload = ("data: " + json.dumps(response) + "\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    original = antigravity.make_config
    original_meter = antigravity.make_meter

    def local_config(request, output, api_key):
        config = original(request, output, api_key)
        if case == "model-budget":
            config.budget_config.max_tool_calls = 10
        return config

    request = {
        "schema_version": 1, "run_id": "ax-run-0123456789abcdef", "adapter": "antigravity",
        "instruction": "Write the code word from the input, followed by a newline.",
        "inputs": {"notes.txt": "Code word: AX_INPUT_OK"}, "output_name": "answer.txt",
    }
    receipt_path = workspace.parent / "usage.json"
    antigravity.make_config = local_config
    antigravity.make_meter = lambda key: GeminiMeter(key, upstream_origin=f"http://127.0.0.1:{server.server_port}")
    error = None
    try:
        await asyncio.wait_for(antigravity.run(request, workspace, receipt_path, "offline-only"), 25)
    except Exception as exc:
        error = type(exc).__name__
    finally:
        antigravity.make_config = original
        antigravity.make_meter = original_meter
        server.shutdown()
        server.server_close()
    receipt = json.loads(receipt_path.read_text())
    assert 1 <= len(requests) <= 3, (case, len(requests))
    assert requests[0]["toolConfig"]["functionCallingConfig"]["mode"] != "NONE"
    assert "AX_INPUT_OK" in json.dumps(requests[0], ensure_ascii=False)
    declarations = [declaration for tool in requests[0]["tools"]
                    for declaration in tool.get("functionDeclarations", [])]
    assert [declaration["name"] for declaration in declarations] == ["write_output"], declarations
    schema = declarations[0].get("parameters", declarations[0].get("parametersJsonSchema", {}))
    assert set(schema["properties"]) == {"content"}, schema
    if case in ("api-error", "late-api-error"):
        assert len(requests) == (1 if case == "api-error" else 2), "API retry must remain disabled"
        assert receipt["estimated_usd"] is None, "Partial usage must not be reported as complete"
    elif case in ("usage-missing", "usage-zero", "late-usage-missing"):
        assert receipt["estimated_usd"] is None, "Unknown usage must not be priced as zero"
    elif case in ("budget", "model-budget"):
        expected = "MAX_TOOL_CALLS_EXCEEDED" if case == "budget" else "MAX_MODEL_CALLS_EXCEEDED"
        assert receipt["stop_reason"] == expected, receipt
        assert len(requests) == (2 if case == "budget" else 3)
    elif case == "malformed":
        assert len(requests) == 2, (case, len(requests), error, receipt)
        assert not target.exists()
    else:
        assert len(requests) == 2, (case, len(requests), error, receipt)
        assert receipt["usage"]["total_token_count"] == 240
        if forbidden:
            assert not target.exists(), "Output boundary bypass"
        else:
            assert error is None, error
            assert target.read_bytes() == b"AX_INPUT_OK\n"
    if receipt["usage"] is not None:
        assert receipt["usage"]["model_call_count"] == len(requests)
    print(json.dumps({"case": case, "local_stub_requests": len(requests), "passed": True}))


with tempfile.TemporaryDirectory(prefix="ax-sdk-offline-") as path:
    for case in ("allowed", "outside", "traversal", "symlink", "budget", "model-budget",
                 "malformed", "usage-missing", "usage-zero", "api-error", "late-api-error", "late-usage-missing"):
        asyncio.run(check_case(Path(path), case))
