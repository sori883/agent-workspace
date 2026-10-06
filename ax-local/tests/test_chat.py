import base64
import hashlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chat import history_json
from task_cli import TaskCLI, TaskError, fingerprint, read_json, save_json
from web_bridge import MAX_CHAT_RESPONSE_BYTES, WebBridge, error_response, main
from test_task_cli import FakeTransport, IMAGE, request


OWNER = "10000000-0000-4000-8000-000000000001"


def turn(cid=None, **changes):
    return {"id": cid or str(uuid.uuid4()), "key": str(uuid.uuid4()), "parent_run_id": None,
            "text": "合言葉は白い猫です。", "allow_model": True, **changes}


class ChatTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.reply = b"A remembered reply"
        self.replies = {}

    def result(self, run_id):
        result = super().result(run_id)
        content = self.replies.setdefault(run_id, self.reply)
        result["artifact"] = {"name": "reply.txt", "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        return result

    def guest(self, run_id, operation, argument=None):
        if operation == "collect":
            self.calls.append((operation, run_id))
            result = self.result(run_id)
            return {"result": result, "artifact_base64": base64.b64encode(self.replies[run_id]).decode()}
        return super().guest(run_id, operation, argument)


def concurrent_chat(root, value, gate, queue):
    bridge = WebBridge(TaskCLI(root, ChatTransport()), launch=lambda *_: None, owner_user_id=OWNER)
    gate.wait(5)
    try:
        queue.put(bridge.chat(value))
    except Exception as error:
        queue.put(error_response(error))


def crash_chat(root, value, after):
    bridge = WebBridge(TaskCLI(root, ChatTransport()), launch=lambda *_: None, owner_user_id=OWNER)
    original = os.rename
    def rename(source, target):
        assert read_json(Path(source) / "receipt.json")["owner_user_id"] == OWNER
        if after:
            original(source, target)
        os.kill(os.getpid(), signal.SIGKILL)
    with patch("task_cli.os.rename", side_effect=rename):
        bridge.chat(value)


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        save_json(self.root / "versions.json", {"runner_task": IMAGE})
        self.transport = ChatTransport()
        self.cli = TaskCLI(self.root, self.transport)
        self.launches = []
        self.bridge = WebBridge(self.cli, launch=lambda *args: self.launches.append(args), owner_user_id=OWNER)
        self.context = multiprocessing.get_context("spawn")

    def tearDown(self):
        self.temporary.cleanup()

    def finish(self, child):
        child.join(7)
        if child.is_alive():
            child.kill()
            child.join()
            self.fail("chat subprocess did not finish")

    def complete(self, value):
        accepted = self.bridge.chat(value)
        receipt = self.cli.execute_accepted(accepted["run_id"])
        self.assertTrue(receipt["resolved"])
        return accepted

    def test_two_turns_reconstruct_history_after_reload_and_replay_original_body(self):
        first = turn(text="合言葉は白い猫です。\n覚えてね。")
        accepted = self.complete(first)
        first_run = accepted["run_id"]
        self.assertEqual(read_json(self.cli.directory(first_run) / "request.json")["inputs"], {"conversation.json": "[]"})
        self.bridge = WebBridge(TaskCLI(self.root, self.transport), launch=lambda *args: self.launches.append(args), owner_user_id=OWNER)
        details = self.bridge.conversation({"id": first["id"].upper()})
        self.assertTrue(details["can_send"])
        self.assertEqual(details["conversation"]["title"], first["text"].replace("\n", " "))
        self.assertEqual(details["turns"][0]["assistant"], self.transport.reply.decode())
        second = turn(first["id"], parent_run_id=first_run, text="合言葉は何？")
        second_run = self.complete(second)["run_id"]
        stored = read_json(self.cli.directory(second_run) / "request.json")
        self.assertEqual(stored["instruction"], second["text"])
        self.assertEqual(json.loads(stored["inputs"]["conversation.json"]), [
            {"role": "user", "content": first["text"]}, {"role": "assistant", "content": self.transport.reply.decode()}])
        with self.cli.locked():
            replay = self.bridge.chat(dict(reversed(list(first.items()))))
        self.assertEqual(replay, {**accepted, "replayed": True})
        self.assertEqual(len(self.launches), 2)
        self.assertEqual(self.bridge.conversations({})["conversations"][0]["head_run_id"], second_run)
        self.assertEqual(self.bridge.get({"run_id": second_run})["summary"]["state"], "succeeded")
        self.assertEqual(self.bridge.artifact({"run_id": second_run})["name"], "reply.txt")

    def test_unknown_conversation_and_invalid_inputs_have_no_persistence(self):
        self.assertEqual(self.bridge.conversations({}), {"conversations": []})
        with self.assertRaisesRegex(TaskError, "conversation_not_found"):
            self.bridge.conversation({"id": str(uuid.uuid4())})
        for changes in ({"id": "bad"}, {"key": "bad"}, {"text": " "}, {"text": "\x00"},
                        {"text": "あ" * 683}, {"parent_run_id": "other"}, {"allow_model": False},
                        {"allow_model": 1}, {"history": []}):
            with self.subTest(changes=changes), self.assertRaises(Exception):
                self.bridge.chat(turn(**changes))
        self.assertFalse(self.cli.runs.exists())
        self.assertEqual(self.transport.calls, [])

    def test_uuid_normalization_and_key_body_conflicts(self):
        value = turn()
        accepted = self.bridge.chat({**value, "id": value["id"].upper(), "key": value["key"].upper()})
        self.assertEqual(accepted["conversation_id"], value["id"])
        self.assertTrue(self.bridge.chat(value)["replayed"])
        for changes in ({"text": "changed"}, {"id": str(uuid.uuid4())}, {"parent_run_id": accepted["run_id"]}):
            with self.subTest(changes=changes), self.assertRaisesRegex(TaskError, "idempotency_conflict"):
                self.bridge.chat({**value, **changes})
        self.assertEqual(len(self.launches), 1)

    def test_list_is_latest_fifty_and_title_counts_unicode_codepoints(self):
        ids = []
        text = "猫\n" + "🐈" * 70
        for _ in range(51):
            value = turn(text=text)
            accepted = self.bridge.chat(value)
            self.cli.recover(accepted["run_id"])
            ids.append(value["id"])
        summaries = self.bridge.conversations({})["conversations"]
        self.assertEqual([row["id"] for row in summaries], list(reversed(ids[1:])))
        self.assertTrue(all(row["title"] == "猫 " + "🐈" * 58 for row in summaries))
        self.assertTrue(all(row["updated_at"].endswith("Z") for row in summaries))
        self.assertEqual(self.transport.calls, [])

    def test_busy_and_stale_parent_do_not_create_turns_or_bypass_legacy_guard(self):
        value = turn()
        accepted = self.bridge.chat(value)
        with self.assertRaisesRegex(TaskError, "conversation_busy"):
            self.bridge.chat(turn(value["id"], parent_run_id=accepted["run_id"]))
        with self.assertRaisesRegex(TaskError, "conversation_conflict"):
            self.bridge.chat(turn(value["id"]))
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.cli.run(request())
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.bridge.chat(turn())
        self.cli.execute_accepted(accepted["run_id"])
        with self.assertRaisesRegex(TaskError, "conversation_conflict"):
            self.bridge.chat(turn(value["id"]))
        self.assertEqual(self.bridge.conversation({"id": value["id"]})["conversation"]["turn_count"], 1)

    def test_failed_spawn_recovers_without_start_and_does_not_enter_context(self):
        value = turn()
        bridge = WebBridge(self.cli, launch=lambda *_: (_ for _ in ()).throw(OSError("private")), owner_user_id=OWNER)
        accepted = bridge.chat(value)
        self.assertEqual(self.cli.inspect(accepted["run_id"])["error_type"], "worker_spawn_failed")
        self.assertTrue(bridge.chat(value)["replayed"])
        self.cli.recover(accepted["run_id"])
        with self.assertRaisesRegex(TaskError, "execution_already_claimed"):
            self.cli.execute_accepted(accepted["run_id"])
        detail = bridge.conversation({"id": value["id"]})
        self.assertEqual(detail["turns"][0]["summary"]["state"], "not_started")
        self.assertIsNone(detail["turns"][0]["assistant"])
        second = self.bridge.chat(turn(value["id"], parent_run_id=accepted["run_id"], text="続き"))
        self.assertEqual(read_json(self.cli.directory(second["run_id"]) / "request.json")["inputs"], {"conversation.json": "[]"})
        self.assertEqual(self.transport.calls, [])

    def test_response_is_hidden_until_cleanup_and_recovery_are_verified(self):
        self.transport.fail_close = True
        value = turn()
        accepted = self.bridge.chat(value)
        self.cli.execute_accepted(accepted["run_id"])
        detail = self.bridge.conversation({"id": value["id"]})
        self.assertIsNone(detail["turns"][0]["assistant"])
        self.assertFalse(detail["can_send"])
        self.transport.fail_close = False
        before = list(self.transport.calls)
        self.cli.recover(accepted["run_id"])
        self.assertFalse(any(name in {"start", "resume", "apply"} for name, _ in self.transport.calls[len(before):]))
        detail = self.bridge.conversation({"id": value["id"]})
        self.assertEqual(detail["turns"][0]["assistant"], self.transport.reply.decode())
        self.assertTrue(detail["can_send"])

    def test_paid_failure_review_fingerprint_unknown_usage_and_spending_guards(self):
        value = turn()
        self.transport.result_status = "failed"
        accepted = self.complete(value)
        follow = turn(value["id"], parent_run_id=accepted["run_id"], text="訂正した依頼")
        with self.assertRaisesRegex(TaskError, "paid_failure_requires_review"):
            self.bridge.chat(follow)
        self.cli.acknowledge_failure(accepted["run_id"], "Fake failure diagnosed and corrected")
        with self.assertRaisesRegex(TaskError, "failed_request_already_attempted"):
            self.bridge.chat({**follow, "text": value["text"]})
        self.transport.result_status = "succeeded"
        self.transport.cost = 0.01
        next_run = self.complete(follow)["run_id"]
        with self.assertRaisesRegex(TaskError, "pilot_estimate_limit_reached"):
            self.bridge.chat(turn(value["id"], parent_run_id=next_run, text="もっと"))
        stored = self.cli.inspect(next_run)
        stored["result"].update(status="failed", exit_code=1, usage=None, estimated_usd=None, error_type="UnknownUsage")
        self.cli.store(self.cli.directory(next_run), stored, outcome="failed")
        with self.assertRaisesRegex(TaskError, "unknown_paid_usage"):
            self.bridge.chat(turn(value["id"], parent_run_id=next_run, text="もっと"))

    def test_context_limit_is_exact_and_replay_precedes_limit(self):
        value = turn(text="x")
        overhead = len(history_json([{"role": "user", "content": "x"}, {"role": "assistant", "content": ""}]).encode())
        self.transport.reply = b"x" * (4096 - overhead)
        first = self.complete(value)
        detail = self.bridge.conversation({"id": value["id"]})
        self.assertFalse(detail["context_full"])
        second = self.bridge.chat(turn(value["id"], parent_run_id=first["run_id"], text="y"))
        self.assertEqual(len(read_json(self.cli.directory(second["run_id"]) / "request.json")["inputs"]["conversation.json"].encode()), 4096)
        self.transport.reply = b"z"
        self.cli.execute_accepted(second["run_id"])
        detail = self.bridge.conversation({"id": value["id"]})
        self.assertTrue(detail["context_full"])
        self.assertFalse(detail["can_send"])
        self.assertTrue(self.bridge.chat(value)["replayed"])
        with self.assertRaisesRegex(TaskError, "conversation_context_full"):
            self.bridge.chat(turn(value["id"], parent_run_id=second["run_id"]))

    def test_broken_parent_sequence_fork_and_cycle_fail_closed(self):
        value = turn()
        first = self.complete(value)
        second = self.bridge.chat(turn(value["id"], parent_run_id=first["run_id"], text="続き"))
        directory = self.cli.directory(second["run_id"])
        original = self.cli.inspect(second["run_id"])
        for changes in ({"parent_run_id": None}, {"parent_run_id": second["run_id"]},
                        {"parent_run_id": "ax-run-ffffffffffffffff"}, {"sequence": 1}, {"sequence": True}):
            with self.subTest(changes=changes):
                receipt = {**original, "conversation": {**original["conversation"], **changes}}
                self.cli.store(directory, receipt)
                with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
                    self.bridge.conversation({"id": value["id"]})
                with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
                    self.cli.execute_accepted(second["run_id"])
        self.cli.store(directory, original)
        shutil.rmtree(self.cli.directory(first["run_id"]))
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.bridge.chat(turn(value["id"], parent_run_id=second["run_id"]))
        self.assertEqual(sum(name == "start" for name, _ in self.transport.calls), 1)

    def test_corrupt_history_artifact_and_success_conditions_fail_closed(self):
        value = turn()
        first = self.complete(value)
        first_directory = self.cli.directory(first["run_id"])
        second = self.bridge.chat(turn(value["id"], parent_run_id=first["run_id"], text="続き"))
        second_directory = self.cli.directory(second["run_id"])
        stored = read_json(second_directory / "request.json")
        stored["inputs"] = {"conversation.json": "[]"}
        save_json(second_directory / "request.json", stored)
        receipt = self.cli.inspect(second["run_id"])
        self.cli.store(second_directory, receipt, fingerprint=fingerprint(stored, IMAGE))
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.bridge.conversation({"id": value["id"]})
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.bridge.chat(value)
        shutil.rmtree(second_directory)
        output = first_directory / "artifacts/reply.txt"
        output.write_text("changed")
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.bridge.conversation({"id": value["id"]})
        output.write_bytes(self.transport.reply)
        receipt = self.cli.inspect(first["run_id"])
        self.cli.store(first_directory, receipt, cleanup={"egress_denied": False, "suspended": True})
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.bridge.conversation({"id": value["id"]})

    def test_concurrent_same_key_has_one_run_and_different_key_one_head(self):
        for same_key in (True, False):
            with self.subTest(same_key=same_key), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                save_json(root / "versions.json", {"runner_task": IMAGE})
                value = turn()
                values = [value, value if same_key else {**value, "key": str(uuid.uuid4())}]
                gate, queue = self.context.Event(), self.context.Queue()
                children = [self.context.Process(target=concurrent_chat, args=(str(root), item, gate, queue)) for item in values]
                for child in children:
                    child.start()
                gate.set()
                for child in children:
                    self.finish(child)
                    self.assertEqual(child.exitcode, 0)
                results = [queue.get(timeout=2) for _ in children]
                if same_key:
                    self.assertEqual(len({result["run_id"] for result in results}), 1)
                    self.assertEqual(sum(not result["replayed"] for result in results), 1)
                else:
                    self.assertEqual(sum("run_id" in result for result in results), 1)
                    self.assertEqual([result["error"]["code"] for result in results if "error" in result], ["conversation_conflict"])
                queue.close()

    def test_kill_around_atomic_publication_retains_one_recoverable_turn(self):
        for after in (False, True):
            with self.subTest(after=after), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                save_json(root / "versions.json", {"runner_task": IMAGE})
                value = turn()
                child = self.context.Process(target=crash_chat, args=(str(root), value, after))
                child.start()
                self.finish(child)
                self.assertEqual(child.exitcode, -signal.SIGKILL)
                bridge = WebBridge(TaskCLI(root, ChatTransport()), launch=lambda *_: None, owner_user_id=OWNER)
                accepted = bridge.chat(value)
                self.assertEqual(accepted["replayed"], after)
                bridge.cli.recover(accepted["run_id"])
                detail = bridge.conversation({"id": value["id"]})
                self.assertEqual(len(detail["turns"]), 1)
                self.assertEqual(detail["turns"][0]["summary"]["state"], "not_started")

    def test_32_turn_control_character_response_fits_new_cli_limit(self):
        cid, parent = str(uuid.uuid4()), None
        self.transport.reply = b"\x01" * 65536
        for index in range(32):
            accepted = self.bridge.chat(turn(cid, parent_run_id=parent, text="\x01" * 2048))
            parent = accepted["run_id"]
            if index < 31:
                self.cli.recover(parent)
            else:
                self.cli.execute_accepted(parent)
        detail = self.bridge.conversation({"id": cid})
        self.assertTrue(detail["context_full"])
        self.assertFalse(detail["can_send"])
        self.assertEqual(detail["turns"][-1]["assistant"], self.transport.reply.decode())
        with self.assertRaisesRegex(TaskError, "conversation_context_full"):
            self.bridge.chat(turn(cid, parent_run_id=parent))
        source = Path(__file__).resolve().parents[1]
        for name in ("web_bridge.py", "task_cli.py", "chat.py"):
            shutil.copyfile(source / name, self.root / name)
        shutil.copytree(source / "task_runtime", self.root / "task_runtime", ignore=shutil.ignore_patterns("__pycache__"))
        completed = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "conversation"],
                                   input=json.dumps({"owner_user_id": OWNER, "input": {"id": cid}}).encode(), capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stdout[:200])
        self.assertEqual(json.loads(completed.stdout)["data"], detail)
        self.assertGreater(len(completed.stdout), 512 * 1024)
        self.assertLessEqual(len(completed.stdout), MAX_CHAT_RESPONSE_BYTES)
        self.assertEqual(completed.stderr, b"")

    def test_encoded_response_limits_are_operation_specific(self):
        for operation, size, success in (("get", 600000, False), ("conversation", 600000, True),
                                         ("conversation", MAX_CHAT_RESPONSE_BYTES, False)):
            with self.subTest(operation=operation, size=size):
                output = io.BytesIO()
                with patch("web_bridge.WebBridge.dispatch", return_value={"ok": True, "data": "x" * size}), \
                     patch("web_bridge.ROOT", self.root), \
                     patch("web_bridge.sys.stdin", SimpleNamespace(buffer=io.BytesIO(b"{}"))), \
                     patch("web_bridge.sys.stdout", SimpleNamespace(buffer=output)):
                    exit_code = main([operation])
                response = json.loads(output.getvalue())
                self.assertEqual(response["ok"], success)
                self.assertEqual(exit_code, 0 if success else 1)
                if not success:
                    self.assertEqual(response["error"]["code"], "response_too_large")


if __name__ == "__main__":
    unittest.main()
