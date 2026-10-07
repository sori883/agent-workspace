import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_runtime import runner
from task_runtime.adapters.interactive import ModelProxy, SKILL_SHA256, load_skill, make_config
from task_runtime.adapters.gemini_meter import MODEL_PATH
from task_runtime.interactive_protocol import MAX_WIRE_BYTES, json_bytes, load_json, validate_context, validate_proposal
from task_runtime.mailbox import Mailbox
from task_runtime.protocol import ProtocolError, encode_request, validate_request


ROOT_ID = "01925adc-a00f-4000-8000-000000000001"


def request(phase="request", **changes):
    runtime = {"version": 1, "root_id": ROOT_ID, "phase": phase, "question_id": ROOT_ID if phase == "answer" else None,
               "skill_id": "brief-v1", "remaining_ms": 30000}
    conversation = [] if phase == "request" else [{"role": "user", "content": "本文を作ってください。"},
                                                {"role": "assistant", "content": "本文に含める内容は？"}]
    value = {"schema_version": 1, "run_id": "ax-run-0123456789abcdef", "adapter": "interactive", "instruction": "確認済みの内容です。",
             "inputs": {"runtime.json": json.dumps(runtime), "conversation.json": json.dumps(conversation, ensure_ascii=False)}, "output_name": "reply.txt"}
    value.update(changes)
    return value


def model_response(proposal=None):
    if proposal is None:
        proposal = {"kind": "question", "text": "成果物に含めたい内容を教えてください。"}
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps(proposal, ensure_ascii=False)}]}, "finishReason": "STOP", "index": 0}],
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120}}


def reply_for(pending, body=None, status="ok"):
    value = load_json(base64.b64decode(pending["request_base64"]))
    if body is None:
        body = {"response": model_response()} if value["kind"] == "model" else {"accepted": True}
    return {"version": 1, "run_id": value["run_id"], "sequence": value["sequence"], "request_sha256": pending["sha256"], "status": status, "body": body}


def encoded(value):
    return base64.b64encode(json_bytes(value)).decode("ascii")


class ContextTests(unittest.TestCase):
    def test_both_contexts_and_skill_digest(self):
        for phase in ("request", "answer"):
            self.assertEqual(validate_context(validate_request(request(phase)))[0]["phase"], phase)
        self.assertEqual(hashlib.sha256(load_skill().encode()).hexdigest(), SKILL_SHA256)

    def test_invalid_runtime_and_history_have_no_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "task"
            changes = [{"version": True}, {"version": 2}, {"remaining_ms": 0}, {"remaining_ms": 90001}, {"remaining_ms": True},
                       {"root_id": "../bad"}, {"root_id": ROOT_ID.upper()}, {"phase": "other"}, {"question_id": ROOT_ID},
                       {"skill_id": "../other"}, {"extra": True}]
            for change in changes:
                value = request()
                runtime = json.loads(value["inputs"]["runtime.json"])
                runtime.update(change)
                value["inputs"]["runtime.json"] = json.dumps(runtime)
                with self.subTest(change=change), self.assertRaises(ProtocolError):
                    runner.stage(root, encoded(value))
                self.assertFalse(root.exists())
            for conversation in ({}, ["text"], [{"role": "assistant", "content": "wrong"}],
                                 [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b", "operation": "run"}]):
                value = request("answer")
                value["inputs"]["conversation.json"] = json.dumps(conversation)
                with self.assertRaises(ProtocolError):
                    validate_request(value)

    def test_fixed_output_inputs_and_duplicate_json(self):
        cases = [request(output_name="other.txt"), request(inputs={}), request(inputs={"runtime.json": "{}", "conversation.json": "[]", "extra": ""})]
        for value in cases:
            with self.assertRaises(ProtocolError):
                validate_request(value)
        for raw in ('{"version":1,"version":1}', '{"number":NaN}', '{"number":Infinity}', '"\ud800"', "[" * 2000):
            with self.assertRaises(ProtocolError):
                load_json(raw)

    def test_proposal_kind_size_path_and_answer_rules(self):
        for proposal in ({"kind": "output", "text": "ok", "path": "../escape"}, {"kind": "shell", "text": "echo"},
                         {"kind": "output", "text": " "}, {"kind": "output", "text": "\x00"},
                         {"kind": "output", "text": "あ" * 683}, {"kind": "output", "text": False}):
            with self.subTest(proposal=str(proposal)[:80]), self.assertRaises(ProtocolError):
                validate_proposal(proposal, "request")
        with self.assertRaises(ProtocolError):
            validate_proposal({"kind": "question", "text": "again?"}, "answer")
        self.assertEqual(validate_proposal({"kind": "output", "text": "x" * 2048}, "answer")["kind"], "output")


class MailboxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "task"
        self.value = request()
        runner.stage(self.root, encode_request(self.value))
        self.box = Mailbox(self.root, self.value["run_id"])

    def start(self):
        runner.start(self.root, self.value["run_id"])
        (self.root / "attempted").touch()

    def model(self):
        self.start()
        self.box.publish("model", {"contents": [{"role": "user", "parts": [{"text": "fixed input"}]}]})
        return self.box.pending()

    def test_read_before_start_has_no_files_or_requests(self):
        before = set(self.root.iterdir())
        self.assertIsNone(runner.mailbox(self.root, self.value["run_id"]))
        self.assertEqual(set(self.root.iterdir()), before)
        with self.assertRaises(OSError):
            self.box.publish("model", {})
        self.assertEqual(set(self.root.iterdir()), before)

    def test_exact_bytes_digest_ack_replay_and_two_operations(self):
        pending = self.model()
        raw = base64.b64decode(pending["request_base64"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), pending["sha256"])
        response = reply_for(pending)
        first = runner.reply(self.root, encoded(response))
        self.assertEqual(first, runner.reply(self.root, encoded(response)))
        self.assertEqual(first, {"run_id": self.value["run_id"], "sequence": 1, "state": "replied"})
        self.assertIsNone(self.box.pending())
        self.assertEqual(self.box.wait_reply(1, time.monotonic()+1), response["body"])
        self.box.publish("tool", {"kind": "question", "text": "Question?"})
        self.assertEqual(load_json(base64.b64decode(self.box.pending()["request_base64"]))["sequence"], 2)
        self.box.respond(encoded(reply_for(self.box.pending())))
        self.assertIsNone(self.box.pending())
        self.assertFalse((self.root / "output").exists())

    def test_reply_identity_conflicts_and_replay_do_not_overwrite(self):
        pending = self.model()
        response = reply_for(pending)
        for change in ({"run_id": "ax-run-ffffffffffffffff"}, {"sequence": 2}, {"sequence": True}, {"request_sha256": "0"*64},
                       {"version": True}, {"version": 2}, {"status": "other"}, {"body": {"accepted": True}}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises((ProtocolError, OSError)):
                runner.reply(self.root, encoded({**response, **change}))
        self.box.respond(encoded(response))
        with self.assertRaises(ProtocolError):
            self.box.respond(encoded({**response, "status": "denied", "body": {}}))
        self.assertEqual(self.box.wait_reply(1, time.monotonic()+1), response["body"])

    def test_no_second_model_or_tool_before_model_acceptance(self):
        self.start()
        with self.assertRaises(OSError):
            self.box.publish("tool", {"kind": "output", "text": "no"})
        self.box.publish("model", {})
        with self.assertRaises(FileExistsError):
            self.box.publish("model", {})
        with self.assertRaises(OSError):
            self.box.publish("tool", {"kind": "output", "text": "no"})
        self.box.respond(encoded(reply_for(self.box.pending(), {}, "denied")))
        with self.assertRaises(ProtocolError):
            self.box.publish("tool", {"kind": "output", "text": "no"})
        with self.assertRaises(ProtocolError):
            self.box.wait_reply(1, time.monotonic()+1)

    def test_reply_size_duplicates_and_nan_rejected(self):
        self.model()
        for payload in ("!", "A" * (4*((MAX_WIRE_BYTES+2)//3)+1), base64.b64encode(b'{"sequence":1,"sequence":1}').decode(),
                        base64.b64encode(b'{"sequence":1,"body":{"n":NaN}}').decode()):
            with self.assertRaises((ProtocolError, ValueError)):
                runner.reply(self.root, payload)
        self.assertIsNotNone(self.box.pending())

    def test_atomic_concurrent_ack_same_reply(self):
        response = encoded(reply_for(self.model()))
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: self.box.respond(response), range(8)))
        self.assertTrue(all(value == replies[0] for value in replies))
        self.assertEqual(list((self.root / "mailbox").glob("*.pending")), [])

    def test_symlink_mailbox_and_reply_are_rejected(self):
        self.start()
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (self.root / "mailbox").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.box.publish("model", {})
        self.assertEqual(list(outside.iterdir()), [])
        (self.root / "mailbox").unlink()
        self.box.publish("model", {})
        response = encoded(reply_for(self.box.pending()))
        outside_file = outside / "reply"
        outside_file.write_text("unchanged")
        (self.root / "mailbox/1.reply.json").symlink_to(outside_file)
        with self.assertRaises(OSError):
            self.box.respond(response)
        self.assertEqual(outside_file.read_text(), "unchanged")

    def test_tool_ack_requires_exact_boolean_and_deadline(self):
        self.box.respond(encoded(reply_for(self.model())))
        self.box.publish("tool", {"kind": "output", "text": "text"})
        response = reply_for(self.box.pending())
        for body in ({"accepted": 1}, {"accepted": False}, {"accepted": True, "extra": 1}):
            with self.assertRaises(ProtocolError):
                self.box.respond(encoded({**response, "body": body}))
        with self.assertRaises(TimeoutError):
            self.box.wait_reply(2, time.monotonic()+0.03)
        self.assertIsNotNone(self.box.pending())

    def test_mailbox_reply_commands_match_wire(self):
        self.model()
        command = [sys.executable, runner.__file__, "--root", str(self.root)]
        result = subprocess.run(command+["mailbox", self.value["run_id"]], check=True, capture_output=True, text=True)
        pending = json.loads(result.stdout)
        response = encoded(reply_for(pending))
        result = subprocess.run(command+["reply", response], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["state"], "replied")


class FakeMailbox:
    def __init__(self, response=None):
        self.calls = []
        self.response = model_response() if response is None else response

    def publish(self, kind, body):
        self.calls.append((kind, body))
        return 1

    def wait_reply(self, sequence, deadline, cancelled=None):
        return {"response": self.response}


class ProxyTests(unittest.TestCase):
    def test_one_model_then_no_second_mailbox(self):
        mailbox = FakeMailbox()
        with ModelProxy(mailbox, time.monotonic()+2) as proxy:
            self.assertIn(b"usageMetadata", proxy.forward({"contents": [{"parts": [{"text": "input"}]}]}))
            self.assertEqual(proxy.usage()["total_token_count"], 120)
            with self.assertRaises(ProtocolError):
                proxy.forward({"contents": [{}]})
            self.assertEqual(len(mailbox.calls), 1)
            self.assertIsNone(proxy.usage())

    def test_bad_model_response_never_gets_known_usage(self):
        cases = []
        missing = model_response(); missing.pop("usageMetadata"); cases.append(missing)
        truncated = model_response(); truncated["candidates"][0]["finishReason"] = "MAX_TOKENS"; cases.append(truncated)
        tool = model_response(); tool["candidates"][0]["content"]["parts"] = [{"functionCall": {"name": "write_output", "args": {"content": "no"}}}]; cases.append(tool)
        large = model_response(); large["usageMetadata"]["candidatesTokenCount"] = 513; large["usageMetadata"]["totalTokenCount"] = 613; cases.append(large)
        for response in cases:
            with self.subTest(response=response), ModelProxy(FakeMailbox(response), time.monotonic()+1) as proxy:
                with self.assertRaises((ValueError, ProtocolError)):
                    proxy.forward({"contents": [{}]})
                self.assertIsNone(proxy.usage())

    def test_http_exact_target_and_strict_json_before_mailbox(self):
        for path, body in (("/other?alt=sse", b'{"contents":[{}]}'), (MODEL_PATH+"?alt=sse&key=bad", b'{"contents":[{}]}'),
                           (MODEL_PATH+"?alt=sse", b'{"contents":[{}],"contents":[{}]}')):
            mailbox = FakeMailbox()
            with ModelProxy(mailbox, time.monotonic()+2) as proxy:
                connection = http.client.HTTPConnection("127.0.0.1", proxy._server.server_port, timeout=2)
                connection.request("POST", path, body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 502)
                response.read(); connection.close()
                self.assertEqual(mailbox.calls, [])


def sdk_available():
    try:
        return importlib.util.find_spec("google.antigravity") is not None
    except ModuleNotFoundError:
        return False


@unittest.skipUnless(sdk_available(), "fixed SDK image required")
class InteractiveSdkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def run_case(self, case, phase="request", proposal=None):
        root = self.base / case
        value = request(phase)
        runner.stage(root, encode_request(value))
        self.assertIsNone(runner.mailbox(root, value["run_id"]))
        self.assertFalse((root / "attempted").exists())
        runner.start(root, value["run_id"])
        replies = []
        requests = []
        failures = []
        stopped = threading.Event()

        def controller():
            try:
                while not stopped.is_set():
                    pending = runner.mailbox(root, value["run_id"])
                    if pending is None:
                        time.sleep(.01)
                        continue
                    operation = load_json(base64.b64decode(pending["request_base64"]))
                    requests.append(operation)
                    if operation["kind"] == "model":
                        self.assertFalse(operation["body"].get("tools"))
                        response = model_response(proposal)
                        if case == "malformed":
                            response["candidates"][0]["content"]["parts"][0]["text"] = '{"kind":"output","kind":"question","text":"no"}'
                        elif case == "function-call":
                            response["candidates"][0]["content"]["parts"] = [{"functionCall": {"name": "write_output", "args": {"content": "no"}}}]
                        elif case == "missing-usage":
                            response.pop("usageMetadata")
                        body = {"response": response}
                        if case == "model-billing":
                            body["billing"] = {"profile_id": "gemini-3.1-flash-lite-standard-2026-10-07-v1", "estimated_usd": .000055}
                    else:
                        self.assertFalse((root / "output/reply.txt").exists())
                        body = {"accepted": True}
                    denied = case == "model-denied" and operation["kind"] == "model" or case == "tool-denied" and operation["kind"] == "tool"
                    ack = reply_for(pending, {} if denied else body, "denied" if denied else "ok")
                    replies.append(ack)
                    runner.reply(root, encoded(ack))
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=controller, daemon=True)
        thread.start()
        try:
            result = runner.execute(root)
        finally:
            stopped.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(sum(op["kind"] == "model" for op in requests), 1)
        for ack in replies:
            self.assertEqual(runner.reply(root, encoded(ack))["state"], "replied")
        return root, result, requests

    def test_question_then_answer_separate_sdk_processes(self):
        for phase, proposal in (("request", {"kind": "question", "text": "何を含めますか？"}),
                                ("answer", {"kind": "output", "text": "確認済みの成果物\n"})):
            root, result, requests = self.run_case(phase, phase, proposal)
            self.assertEqual(result["status"], "succeeded", result)
            self.assertEqual(result["stop_reason"], "UNSPECIFIED")
            self.assertEqual(result["usage"], {"prompt_token_count": 100, "candidates_token_count": 20, "thoughts_token_count": 0, "total_token_count": 120, "model_call_count": 1})
            self.assertEqual(result["estimated_usd"], 0)
            self.assertEqual([op["kind"] for op in requests], ["model", "tool"])
            self.assertEqual(requests[1]["body"], proposal)
            self.assertEqual((root / "output/reply.txt").read_bytes(), proposal["text"].encode())
            collected = runner.collect(root, result["run_id"])
            self.assertEqual(base64.b64decode(collected["artifact_base64"]), proposal["text"].encode())
            if phase == "answer":
                self.assertIn("本文に含める内容は？", json.dumps(requests[0], ensure_ascii=False))

    def test_direct_output_and_unsupported(self):
        for kind in ("output", "unsupported"):
            _, result, _ = self.run_case(kind, proposal={"kind": kind, "text": "固定本文"})
            self.assertEqual(result["status"], "succeeded", result)

    def test_malformed_duplicate_proposal_and_repeated_question_no_tool(self):
        for case, phase in (("malformed", "request"), ("repeat-question", "answer")):
            root, result, requests = self.run_case(case, phase)
            self.assertEqual(result["status"], "failed", result)
            self.assertEqual([op["kind"] for op in requests], ["model"])
            self.assertFalse((root / "output/reply.txt").exists())

    def test_denied_model_tool_and_unknown_usage_do_not_write(self):
        for case in ("model-denied", "tool-denied", "missing-usage", "function-call"):
            root, result, requests = self.run_case(case)
            self.assertEqual(result["status"], "failed", result)
            self.assertFalse((root / "output/reply.txt").exists())
            self.assertEqual(len(requests), 2 if case == "tool-denied" else 1)

    def test_sdk_caps_and_fixed_skill(self):
        config = make_config(self.base, load_skill())
        self.assertEqual(config.budget_config.max_model_calls, 3)
        self.assertEqual(config.budget_config.max_tool_calls, 2)
        self.assertEqual(config.retry_config.api_retry.max_retries, 0)
        self.assertEqual(config.retry_config.model_output_retry.max_retries, 0)
        self.assertFalse(config.tools)


if __name__ == "__main__":
    unittest.main()
