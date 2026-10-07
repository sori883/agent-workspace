import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


async def child(args):
    from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy, post_tool_call
    from google.antigravity.models import ModelTarget
    from google.antigravity.types import (
        AgentBehavior, BudgetConfig, BudgetScope, GeminiAPIEndpoint,
        ModelAPIRetryConfig, ModelOutputRetryConfig, RetryConfig,
        SessionContinuationMode,
    )

    logging.disable(logging.CRITICAL)
    root = Path(args.root)
    workspace = root / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    save = root / "sdk-save"
    app = root / "sdk-app"
    calls = root / "tool-calls.jsonl"

    def event(name, value):
        with calls.open("a") as stream:
            stream.write(json.dumps({"tool": name, "value": value, "phase": args.phase}) + "\n")

    def ask_user(question: str) -> str:
        """Record one question and return its ID; do not answer it on behalf of the user."""
        event("ask_user", question)
        return json.dumps({"question_id": "q1", "question": question, "state": "waiting_for_user"})

    def write_output(content: str) -> str:
        """Write the final small output once to the task's fixed output path."""
        event("write_output", content)
        if len(content.encode()) > 1024:
            raise ValueError("OutputTooLarge")
        with (workspace / "answer.txt").open("x") as stream:
            stream.write(content)
        return "Output saved."

    @post_tool_call
    async def cancel_after_tool(result):
        await agent.conversation.cancel()

    resume = args.phase in ("answer", "missing")
    conversation_id = None
    if resume:
        conversation_id = json.loads((root / "question-report.json").read_text())["conversation_id"]
        if args.phase == "missing":
            conversation_id = "00000000-0000-4000-8000-000000000001"
    config = LocalAgentConfig(
        model="gemini-3.1-flash-lite", vertex=False, api_key="offline-stub-only",
        workspaces=[str(workspace)], save_dir=str(save), app_data_dir=str(app),
        conversation_id=conversation_id,
        session_continuation_mode=SessionContinuationMode.RESUME if resume else SessionContinuationMode.CREATE_ONLY,
        system_instructions="Ask the user for the code word, wait for their next message, then write the output.",
        tools=[ask_user, write_output],
        hooks=[cancel_after_tool] if args.mode == "hook_stop" else [],
        capabilities=CapabilitiesConfig(enable_subagents=False, agent_behavior=AgentBehavior.MINIMAL, enabled_tools=[]),
        policies=[policy.allow("ask_user"), policy.allow("write_output")],
        budget_config=BudgetConfig(max_model_calls=args.model_cap, max_tool_calls=args.tool_cap,
                                   max_input_tokens=6000, max_output_tokens=512, max_total_tokens=6512,
                                   scope=BudgetScope.LIFETIME),
        retry_config=RetryConfig(api_retry=ModelAPIRetryConfig(max_retries=0),
                                model_output_retry=ModelOutputRetryConfig(max_retries=0)),
    )
    if args.mode == "terminal":
        config.tools = []
        config.policies = [policy.allow("finish")]
        config.response_schema = json.dumps({
            "type": "object", "properties": {
                "kind": {"type": "string", "enum": ["question", "output"]},
                "question_id": {"type": "string"}, "value": {"type": "string"},
            }, "required": ["kind", "question_id", "value"], "additionalProperties": False,
        })
    config.models = [ModelTarget(name="gemini-3.1-flash-lite", endpoint=GeminiAPIEndpoint(base_url=args.url, api_key="offline-stub-only"))]
    report = {"phase": args.phase, "pid": os.getpid(), "sdk_version": importlib.metadata.version("google-antigravity")}
    try:
        async with Agent(config) as agent:
            await asyncio.sleep(0.3)
            report["before_chat"] = {
                "history": [item.model_dump(mode="json") for item in agent.conversation.history],
                "usage": agent.conversation.total_usage.model_dump(mode="json"),
                "tool_file_exists": calls.exists(),
            }
            if args.phase != "idle":
                prompt = "Please ask me for the missing code word." if args.phase == "question" else "Answer to q1: the code word is SDK_RESUME_OK. Write it with a newline."
                response = await agent.chat(prompt)
                try:
                    report["text"] = await response.text()
                    report["stop_reason"] = response.stop_reason.value
                    report["response_usage"] = response.usage_metadata.model_dump(mode="json")
                    report["structured_output"] = await response.structured_output()
                except BaseException as error:
                    report["error"] = {"type": type(error).__name__, "message": str(error)[:300]}
                if args.mode == "terminal" and report["structured_output"]:
                    value = report["structured_output"]
                    if value["kind"] == "question":
                        report["application_dispatch_result"] = ask_user(value["value"])
                    else:
                        report["application_dispatch_result"] = write_output(value["value"])
            report["conversation_id"] = agent.conversation_id
            report["history"] = [item.model_dump(mode="json") for item in agent.conversation.history]
            report["total_usage"] = agent.conversation.total_usage.model_dump(mode="json")
    except BaseException as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)[:300]}
    write_json(root / f"{args.phase}-report.json", report)
    return report


def run_case(root, name, model_cap, tool_cap=3):
    case = root / name
    case.mkdir()
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            number = len(requests)
            if name == "provider_error":
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b'{"error":{"code":503,"message":"offline failure"}}')
                return
            if name == "terminal":
                part = {"functionCall": {"name": "finish", "args": {"kind": "question" if number == 1 else "output",
                         "question_id": "q1", "value": "What is the code word?" if number == 1 else "SDK_RESUME_OK\n"}}}
            elif name == "hook_stop" and number == 2:
                part = {"functionCall": {"name": "write_output", "args": {"content": "SDK_RESUME_OK\n"}}}
            elif number == 1:
                part = {"functionCall": {"name": "ask_user", "args": {"question": "What is the code word?"}}}
            elif number == 2:
                part = {"text": "What is the code word? [q1]"}
            elif number == 3:
                part = {"functionCall": {"name": "write_output", "args": {"content": "SDK_RESUME_OK\n"}}}
            else:
                part = {"text": "The output has been saved."}
            response = {
                "candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP", "index": 0}],
                "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120},
            }
            payload = ("data: " + json.dumps(response) + "\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    phases = []
    resume_root = case
    try:
        for phase in ("idle", "question", "missing" if name == "missing_session" else "answer"):
            if phase in ("answer", "missing") and name == "provider_error":
                break
            if phase in ("answer", "missing") and name == "copied_save":
                resume_root = case / "fresh-process-state"
                resume_root.mkdir()
                shutil.copytree(case / "sdk-save", resume_root / "sdk-save")
                shutil.copyfile(case / "question-report.json", resume_root / "question-report.json")
                shutil.copyfile(case / "tool-calls.jsonl", resume_root / "tool-calls.jsonl")
            before = len(requests)
            invocation = [sys.executable, __file__, "--child", "--root", str(resume_root), "--phase", phase,
                          "--url", f"http://127.0.0.1:{server.server_port}", "--model-cap", str(model_cap), "--tool-cap", str(tool_cap), "--mode", name]
            process = subprocess.run(invocation, capture_output=True, text=True, timeout=35)
            (case / f"{phase}-stderr.txt").write_text(process.stderr)
            report = json.loads((resume_root / f"{phase}-report.json").read_text())
            phases.append({"phase": phase, "exit": process.returncode, "provider_requests": len(requests) - before,
                           "stop_reason": report.get("stop_reason"), "error": report.get("error"), "pid": report["pid"]})
            if phase == "question" and "conversation_id" in report:
                function_parts = [part for request in requests for content in request.get("contents", []) for part in content.get("parts", [])
                                  if "functionCall" in part or "functionResponse" in part]
                write_json(case / "inspectable-checkpoint.json", {
                    "schema_version": 1, "sdk_version": "0.1.20", "conversation_id": report["conversation_id"],
                    "question_id": "q1", "state": "waiting_for_user",
                    "usage": report["total_usage"], "sdk_history": report["history"],
                    "observed_provider_function_parts": function_parts,
                    "note": "Inspection evidence, not a standalone SDK import format. SDK save files are also required.",
                })
                if name == "hook_stop":
                    if not any(step["status"] == "DONE" and step["type"] == "TOOL_CALL" for step in report["history"]):
                        call_file = resume_root / "tool-calls.jsonl"
                        tool_calls = [json.loads(line) for line in call_file.read_text().splitlines()] if call_file.exists() else None
                        summary = {"case": name, "note": "SDK tool completion not confirmed; resume was not attempted. Recorded tool effects are separate evidence.",
                                   "phases": phases, "tool_calls": tool_calls, "sdk_tool_completion_confirmed": False}
                        write_json(case / "summary.json", summary)
                        return summary
            if report.get("error") and name != "hook_stop":
                break
    finally:
        server.shutdown()
        server.server_close()
    write_json(case / "provider-requests.json", requests)
    call_file = resume_root / "tool-calls.jsonl"
    tool_calls = [json.loads(line) for line in call_file.read_text().splitlines()] if call_file.exists() else []
    summary = {"case": name, "model_cap": model_cap, "tool_cap": tool_cap, "phases": phases,
               "total_model_requests": len(requests), "tool_calls": tool_calls,
               "artifact": (resume_root / "workspace" / "answer.txt").read_text() if (resume_root / "workspace" / "answer.txt").exists() else None,
               "saved_files": [{"path": str(p.relative_to(case)), "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                               for p in sorted((case / "sdk-save").rglob("*")) if p.is_file()]}
    write_json(case / "summary.json", summary)
    assert phases[0]["provider_requests"] == 0
    assert len({phase["pid"] for phase in phases}) == len(phases)
    assert all(phase["exit"] == 0 for phase in phases)
    if name in ("happy", "copied_save"):
        assert len(requests) == 4, summary
        assert summary["artifact"] == "SDK_RESUME_OK\n"
        assert [call["tool"] for call in tool_calls] == ["ask_user", "write_output"]
        assert phases[-1]["stop_reason"] == "UNSPECIFIED", summary
        contents = requests[2]["contents"]
        parts = [part for content in contents for part in content["parts"]]
        call = next(part["functionCall"] for part in parts if part.get("functionCall", {}).get("name") == "ask_user")
        response = next(part["functionResponse"] for part in parts if part.get("functionResponse", {}).get("name") == "ask_user")
        assert call["id"] == response["id"] and "waiting_for_user" in json.dumps(response)
        assert "SDK_RESUME_OK" in json.dumps(contents)
        resumed = json.loads((resume_root / "answer-report.json").read_text())
        assert resumed["before_chat"]["usage"]["total_token_count"] == 240
        assert resumed["total_usage"]["total_token_count"] == 480
        assert resumed["before_chat"]["history"][1]["status"] == "DONE"
    elif name == "model_limit":
        summary["expected_no_send_after_exhaustion"] = phases[-1]["provider_requests"] == 0
        summary["budget_boundary_passed"] = summary["expected_no_send_after_exhaustion"]
    elif name == "tool_limit":
        summary["expected_no_send_after_exhaustion"] = phases[-1]["provider_requests"] == 0
        summary["budget_boundary_passed"] = summary["expected_no_send_after_exhaustion"]
    elif name == "current_limits":
        assert len(requests) <= 3 and len(tool_calls) <= 2, summary
        assert phases[-1]["stop_reason"] in ("MAX_MODEL_CALLS_EXCEEDED", "MAX_TOOL_CALLS_EXCEEDED"), summary
    elif name == "missing_session":
        assert phases[-1]["error"] and phases[-1]["provider_requests"] == 0, summary
        assert len(tool_calls) == 1
    elif name == "provider_error":
        assert len(requests) == 1 and tool_calls == [], summary
    elif name in ("hook_stop", "terminal"):
        summary["exactly_one_model_request_per_segment"] = [phase["provider_requests"] for phase in phases] == [0, 1, 1]
        summary["artifact_created"] = summary["artifact"] == "SDK_RESUME_OK\n"
    summary["harness_assertions_passed"] = True
    write_json(case / "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--root", required=True)
    parser.add_argument("--phase")
    parser.add_argument("--url")
    parser.add_argument("--model-cap", type=int, default=4)
    parser.add_argument("--tool-cap", type=int, default=2)
    parser.add_argument("--cases", default="happy,copied_save,model_limit,tool_limit,current_limits,missing_session,provider_error,hook_stop,terminal")
    parser.add_argument("--mode", default="happy")
    args = parser.parse_args()
    if args.child:
        asyncio.run(asyncio.wait_for(child(args), 30))
    else:
        root = Path(args.root)
        root.mkdir(parents=True, exist_ok=False)
        summaries = []
        for name, model_cap, tool_cap in (("happy", 5, 3), ("copied_save", 5, 3), ("model_limit", 2, 3),
                                           ("tool_limit", 5, 1), ("current_limits", 3, 2),
                                           ("missing_session", 5, 3), ("provider_error", 5, 3),
                                           ("hook_stop", 3, 2), ("terminal", 3, 2)):
            if name not in args.cases.split(","):
                continue
            summary = run_case(root, name, model_cap, tool_cap)
            summaries.append(summary)
            write_json(root / "summary.json", summaries)
            print(json.dumps({k: v for k, v in summary.items() if k not in ("saved_files", "tool_calls")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
