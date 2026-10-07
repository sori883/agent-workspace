import argparse
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


async def propose(url, context):
    from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy
    from google.antigravity.models import ModelTarget
    from google.antigravity.types import AgentBehavior, BudgetConfig, GeminiAPIEndpoint, ModelAPIRetryConfig, ModelOutputRetryConfig, RetryConfig

    logging.disable(logging.CRITICAL)
    with tempfile.TemporaryDirectory(prefix="sdk-proposal-") as directory:
        config = LocalAgentConfig(
            model="gemini-3.1-flash-lite", vertex=False, api_key="offline-only",
            save_dir=directory, app_data_dir=directory,
            system_instructions="Return exactly one JSON operation proposal. Never execute a tool. Use the supplied skill and confirmed history.",
            tools=[], policies=[policy.deny_all()],
            capabilities=CapabilitiesConfig(enable_subagents=False, agent_behavior=AgentBehavior.MINIMAL, enabled_tools=[]),
            budget_config=BudgetConfig(max_model_calls=3, max_tool_calls=2, max_input_tokens=6000, max_output_tokens=512, max_total_tokens=6512),
            retry_config=RetryConfig(api_retry=ModelAPIRetryConfig(max_retries=0), model_output_retry=ModelOutputRetryConfig(max_retries=0)),
        )
        config.models = [ModelTarget(name="gemini-3.1-flash-lite", endpoint=GeminiAPIEndpoint(base_url=url, api_key="offline-only"))]
        async with Agent(config) as agent:
            response = await agent.chat(json.dumps(context))
            raw = await response.text()
            tool_calls = [call async for call in response.tool_calls]
            return {"proposal": json.loads(raw), "stop_reason": response.stop_reason.value,
                    "usage": response.usage_metadata.model_dump(mode="json"), "sdk_tool_calls": len(tool_calls)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--url")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.child:
        print(json.dumps(asyncio.run(propose(args.url, json.load(sys.stdin)))))
        return

    requests = []
    proposals = [{"kind": "ask_user", "question": "What is the code word?"},
                 {"kind": "write_output", "content": "SDK_CONTRACT_OK\n"}]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if len(requests) > len(proposals):
                self.send_response(409)
                self.end_headers()
                return
            response = {"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(proposals[len(requests)-1])}]}, "finishReason": "STOP", "index": 0}],
                        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120}}
            payload = ("data: " + json.dumps(response) + "\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    skill = {"id": "fixed-code-word", "version": 1, "instruction": "Ask for a missing code word; write the supplied word with a newline."}
    history = [{"role": "user", "text": "Prepare the code-word artifact."}]
    reports = []
    try:
        for phase in ("question", "answer"):
            context = {"skill": skill, "confirmed_history": history, "phase": phase}
            before = len(requests)
            process = subprocess.run([sys.executable, __file__, "--child", "--url", f"http://127.0.0.1:{server.server_port}"],
                                     input=json.dumps(context), text=True, capture_output=True, timeout=30)
            if process.returncode != 0:
                raise RuntimeError(process.stderr)
            report = json.loads(process.stdout)
            assert report["stop_reason"] == "UNSPECIFIED", report
            assert report["sdk_tool_calls"] == 0, report
            assert len(requests)-before == 1
            assert report["proposal"] == proposals[len(reports)]
            assert not requests[-1].get("tools"), requests[-1].get("tools")
            reports.append(report)
            if phase == "question":
                history += [{"role": "assistant", "operation": report["proposal"], "operation_id": "operation-1", "status": "confirmed"},
                            {"role": "user", "question_id": "q1", "text": "SDK_CONTRACT_OK"}]
    finally:
        server.shutdown()
        server.server_close()
    assert "operation-1" in json.dumps(requests[1]) and "SDK_CONTRACT_OK" in json.dumps(requests[1])
    artifact = reports[1]["proposal"]["content"].encode()
    result = {"sdk_version": "0.1.20", "image_id": "sha256:1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5",
              "external_model_requests": 0, "local_model_requests": len(requests), "sdk_tool_calls": 0,
              "planned_runtime_tool_count": 2, "sdk_limits": {"model_calls": 3, "tool_calls": 2},
              "total_synthetic_tokens": sum(r["usage"]["total_token_count"] for r in reports),
              "sdk_state_reused": False, "reports": reports, "confirmed_history_reconstructed": True,
              "scope": "Actual SDK text-JSON proposals only. Runtime fixed-tool dispatch, root budget gateway, DB and AX not implemented or verified here.",
              "proposed_artifact": {"bytes": len(artifact), "sha256": hashlib.sha256(artifact).hexdigest()},
              "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "assertions_passed": True}
    Path(args.out).write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
