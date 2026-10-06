import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chat import ChatService
from task_cli import TaskCLI, TaskError, read_json, save_json
from web_bridge import WebBridge, error_response, parse_submission
from test_chat import ChatTransport, turn
from test_task_cli import FakeTransport, IMAGE, request
from test_web_bridge import submission


ALICE = "a0000000-0000-4000-8000-000000000001"
BOB = "b0000000-0000-4000-8000-000000000002"
CAROL = "c0000000-0000-4000-8000-000000000003"
OPERATIONS = ("submit", "list", "get", "artifact", "recover", "conversations", "conversation", "chat")


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        save_json(self.root / "versions.json", {"runner_task": IMAGE})
        self.transport = FakeTransport()
        self.cli = TaskCLI(self.root, self.transport)
        self.launches = []
        self.alice = self.bridge(ALICE)
        self.bob = self.bridge(BOB)

    def tearDown(self):
        self.temporary.cleanup()

    def bridge(self, owner):
        return WebBridge(self.cli, lambda *args: self.launches.append((owner, *args)), owner_user_id=owner)

    def use_chat_transport(self):
        self.transport = ChatTransport()
        self.cli.transport = self.transport

    def rejects(self, code, operation, value):
        with self.assertRaisesRegex(TaskError, "^" + code + "$") as caught:
            operation(value)
        return error_response(caught.exception)["error"]["status"]

    def test_all_operations_require_strict_owner_envelope_before_dispatch(self):
        for operation in OPERATIONS:
            for value in ({}, {"input": {}}, {"owner_user_id": None, "input": {}},
                          {"owner_user_id": False, "input": {}}, {"owner_user_id": ALICE + "\n", "input": {}},
                          {"owner_user_id": "/private/user", "input": {}}, {"owner_user_id": {}, "input": {}}):
                with self.subTest(operation=operation, value=value):
                    self.assertEqual(self.rejects("invalid_owner_user_id", lambda data: WebBridge.dispatch(operation, data, cli=self.cli), value), 400)
            for value in ({"owner_user_id": ALICE}, {"owner_user_id": ALICE, "input": None},
                          {"owner_user_id": ALICE, "input": {}, "owner": BOB}):
                with self.subTest(operation=operation, value=value):
                    self.assertEqual(self.rejects("invalid_request", lambda data: WebBridge.dispatch(operation, data, cli=self.cli), value), 400)
        self.assertFalse(self.cli.runs.exists())
        self.assertEqual(self.launches, [])
        self.assertEqual(WebBridge.dispatch("list", {"owner_user_id": ALICE.upper(), "input": {}}, cli=self.cli),
                         {"ok": True, "data": {"runs": []}})
        for owner in (None, "", 1, ALICE.replace("-", "")):
            with self.assertRaisesRegex(TaskError, "invalid_owner_user_id"):
                self.bridge(owner)

    def test_owner_is_saved_before_atomic_publication_for_run_and_chat(self):
        original = os.rename
        published = []
        def rename(source, target):
            stored = read_json(Path(source) / "receipt.json")
            self.assertEqual(stored["owner_user_id"], ALICE)
            self.assertEqual(stored["phase"], "accepted")
            self.assertFalse(Path(target).exists())
            published.append(stored["run_id"])
            return original(source, target)
        with patch("task_cli.os.rename", side_effect=rename):
            first = self.alice.submit(submission())["run_id"]
            self.cli.recover(first)
            second = self.alice.chat(turn())["run_id"]
        self.cli.recover(second)
        self.assertEqual(published, [first, second])
        self.assertTrue(all(self.cli.inspect(run)["owner_user_id"] == ALICE for run in published))
        self.assertEqual(self.transport.calls, [])

    def test_foreign_run_is_hidden_including_artifact_and_recovery_while_busy(self):
        own = self.alice.submit(submission())["run_id"]
        self.cli.execute_accepted(own)
        self.assertEqual(self.alice.get({"run_id": own})["summary"]["run_id"], own)
        self.assertEqual(self.alice.artifact({"run_id": own})["content"], own + "\n")
        before = list(self.launches)
        for operation in (self.bob.get, self.bob.artifact, self.bob.recover):
            self.assertEqual(self.rejects("run_not_found", operation, {"run_id": own}), 404)
        with self.cli.locked():
            self.assertEqual(self.rejects("run_not_found", self.bob.recover, {"run_id": own}), 404)
        self.assertEqual(self.bob.list({}), {"runs": []})
        self.assertEqual(self.launches, before)
        self.assertEqual(self.cli.inspect(own)["owner_user_id"], ALICE)

    def test_idempotency_is_owner_scoped_and_replay_checks_owner_even_with_equal_hash(self):
        value = submission()
        first = self.alice.submit(value)["run_id"]
        with self.cli.locked():
            self.assertEqual(self.alice.submit(value), {"run_id": first, "replayed": True})
        self.rejects("idempotency_conflict", self.alice.submit, {**value, "instruction": "changed"})
        self.rejects("unresolved_run:" + first, self.bob.submit, value)
        self.cli.recover(first)
        receipt = self.cli.inspect(first)
        request_b, key_b, payload_b = parse_submission(value, BOB)
        self.assertNotEqual(receipt["submission"]["key_hash"], key_b)
        receipt["submission"]["key_hash"] = key_b
        self.cli.store(self.cli.directory(first), receipt)
        self.assertIsNone(self.cli.find_submission(key_b, payload_b, BOB))
        second, replayed = self.cli.accept(request_b, key_b, payload_b, BOB)
        self.assertFalse(replayed)
        self.assertNotEqual(second["run_id"], first)
        self.assertEqual(second["owner_user_id"], BOB)
        self.assertEqual(second["fingerprint"], receipt["fingerprint"])

    def test_chat_ids_are_globally_reserved_and_cross_owner_replay_never_succeeds(self):
        value = turn()
        first = self.alice.chat(value)
        with self.cli.locked():
            self.assertTrue(self.alice.chat(value)["replayed"])
            self.assertEqual(self.rejects("conversation_not_found", self.bob.chat, value), 404)
        self.cli.recover(first["run_id"])
        for owner in (self.bob, self.bridge(CAROL)):
            self.assertEqual(owner.conversations({}), {"conversations": []})
            self.assertEqual(self.rejects("conversation_not_found", owner.conversation, {"id": value["id"]}), 404)
            self.assertEqual(self.rejects("conversation_not_found", owner.chat, turn(value["id"])), 404)
        other = self.bob.chat({**value, "id": str(uuid.uuid4())})
        self.assertFalse(other["replayed"])
        self.assertNotEqual(other["run_id"], first["run_id"])
        self.assertEqual(self.rejects("conversation_not_found", self.bob.chat, value), 404)
        self.assertEqual(len(self.launches), 2)

    def test_mixed_owner_chain_is_rejected_from_chat_and_old_run_paths(self):
        self.use_chat_transport()
        value = turn()
        first = self.alice.chat(value)["run_id"]
        self.cli.execute_accepted(first)
        second = self.alice.chat(turn(value["id"], parent_run_id=first))["run_id"]
        receipt = self.cli.inspect(second)
        self.cli.store(self.cli.directory(second), receipt, owner_user_id=BOB)
        before = list(self.transport.calls)
        for owner, owned_run in ((self.alice, first), (self.bob, second)):
            for operation, argument in ((owner.list, {}), (owner.conversations, {}), (owner.conversation, {"id": value["id"]}),
                                        (owner.chat, turn(value["id"], parent_run_id=second)),
                                        (owner.get, {"run_id": owned_run}), (owner.artifact, {"run_id": owned_run}),
                                        (owner.recover, {"run_id": owned_run})):
                self.assertEqual(self.rejects("invalid_conversation_state", operation, argument), 409)
        self.assertEqual(self.rejects("conversation_not_found", self.bridge(CAROL).conversation, {"id": value["id"]}), 404)
        with self.assertRaisesRegex(TaskError, "invalid_conversation_state"):
            self.cli.execute_accepted(second)
        self.assertEqual(self.transport.calls, before)
        self.assertEqual(self.cli.inspect(second)["phase"], "accepted")

    def test_ownerless_legacy_run_and_chat_stay_admin_only(self):
        legacy = self.cli.run(request())
        self.assertNotIn("owner_user_id", legacy)
        for owner in (self.alice, self.bob):
            self.assertEqual(owner.list({}), {"runs": []})
            for operation in (owner.get, owner.artifact, owner.recover):
                self.assertEqual(self.rejects("run_not_found", operation, {"run_id": legacy["run_id"]}), 404)
        self.use_chat_transport()
        value = turn()
        old_chat, _ = ChatService(self.cli, owner_user_id=None).accept(value)
        self.cli.execute_accepted(old_chat["run_id"])
        self.assertTrue(self.cli.inspect(old_chat["run_id"])["resolved"])
        for owner in (self.alice, self.bob):
            self.assertEqual(owner.conversations({}), {"conversations": []})
            self.assertEqual(self.rejects("conversation_not_found", owner.conversation, {"id": value["id"]}), 404)
            self.assertEqual(self.rejects("conversation_not_found", owner.chat, value), 404)
        self.assertNotIn("owner_user_id", self.cli.recover(old_chat["run_id"]))

    def test_lists_filter_owners_before_fifty_row_limit(self):
        own = self.alice.chat(turn())
        self.cli.recover(own["run_id"])
        for _ in range(51):
            accepted = self.bob.chat(turn())
            self.cli.recover(accepted["run_id"])
        self.assertEqual([row["run_id"] for row in self.alice.list({})["runs"]], [own["run_id"]])
        self.assertEqual([row["id"] for row in self.alice.conversations({})["conversations"]], [own["conversation_id"]])
        self.assertEqual(len(self.bob.list({})["runs"]), 50)
        self.assertEqual(len(self.bob.conversations({})["conversations"]), 50)
        self.assertEqual(self.transport.calls, [])

    def test_global_guard_includes_other_owner_and_ownerless_unresolved_receipts(self):
        legacy, _ = self.cli.accept(request(), "legacy-key", "legacy-payload")
        for owner in (self.alice, self.bob):
            self.rejects("unresolved_run:" + legacy["run_id"], owner.submit, submission())
            self.rejects("unresolved_run:" + legacy["run_id"], owner.chat, turn())
        self.cli.recover(legacy["run_id"])
        pending = self.bob.submit(submission())["run_id"]
        self.rejects("unresolved_run:" + pending, self.alice.submit, submission())
        self.rejects("unresolved_run:" + pending, self.alice.chat, turn())
        self.assertEqual(self.transport.calls, [])

    def test_failed_paid_fingerprint_and_review_remain_global(self):
        value = submission(mode="model", allow_model=True)
        run = self.bob.submit(value)["run_id"]
        self.transport.result_status = "failed"
        self.cli.execute_accepted(run)
        self.rejects("failed_request_already_attempted:" + run, self.alice.submit, value)
        changed = {**value, "instruction": "Corrected input"}
        self.rejects("paid_failure_requires_review:" + run, self.alice.submit, changed)
        self.cli.acknowledge_failure(run, "Fake adapter diagnosed and corrected")
        self.rejects("failed_request_already_attempted:" + run, self.alice.submit, value)
        accepted = self.alice.submit(changed)["run_id"]
        self.assertEqual(self.cli.inspect(accepted)["owner_user_id"], ALICE)

    def test_unknown_paid_usage_and_cost_limit_still_cover_legacy(self):
        self.transport.cost = 0.01
        legacy = self.cli.run(request(offline=False))
        self.assertNotIn("owner_user_id", legacy)
        for owner in (self.alice, self.bob):
            self.rejects("pilot_estimate_limit_reached", owner.submit, submission(mode="model", allow_model=True))
            self.rejects("pilot_estimate_limit_reached", owner.chat, turn())
        offline = self.alice.submit(submission())["run_id"]
        self.cli.recover(offline)
        legacy["result"]["usage"] = None
        self.cli.store(self.cli.directory(legacy["run_id"]), legacy)
        for owner in (self.alice, self.bob):
            self.rejects("unknown_paid_usage:" + legacy["run_id"], owner.submit, submission())
            self.rejects("unknown_paid_usage:" + legacy["run_id"], owner.chat, turn())

    def test_owner_recovery_does_not_require_readable_artifact_and_never_changes_owner(self):
        self.use_chat_transport()
        value = turn()
        run = self.alice.chat(value)["run_id"]
        self.transport.fail_close = True
        self.cli.execute_accepted(run)
        (self.cli.directory(run) / "artifacts/reply.txt").write_text("tampered")
        self.assertEqual(self.alice.recover({"run_id": run}), {"run_id": run})
        self.assertEqual(self.launches[-1], (ALICE, "recover", run))
        self.transport.fail_close = False
        self.cli.recover(run)
        self.assertEqual(self.cli.inspect(run)["owner_user_id"], ALICE)
        self.assertTrue(self.cli.inspect(run)["resolved"])
        self.rejects("invalid_conversation_state", self.alice.conversation, {"id": value["id"]})

    def test_subprocess_envelope_rejects_legacy_shape_and_hides_ownerless_receipt(self):
        source = Path(__file__).resolve().parents[1]
        for name in ("task_cli.py", "web_bridge.py", "chat.py"):
            shutil.copyfile(source / name, self.root / name)
        shutil.copytree(source / "task_runtime", self.root / "task_runtime")
        legacy, _ = self.cli.accept(request(), "legacy-key", "legacy-payload")
        for operation in OPERATIONS:
            result = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), operation], input="{}", text=True,
                                    capture_output=True, timeout=5)
            self.assertEqual(json.loads(result.stdout), {"ok": False, "error": {"code": "invalid_owner_user_id", "status": 400}})
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr, "")
        result = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "list"],
                                input=json.dumps({"owner_user_id": ALICE.upper(), "input": {}}), text=True,
                                capture_output=True, timeout=5)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "data": {"runs": []}})
        result = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "_recover", legacy["run_id"]],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        saved = self.cli.inspect(legacy["run_id"])
        self.assertEqual(saved["outcome"], "not_started")
        self.assertNotIn("owner_user_id", saved)


if __name__ == "__main__":
    unittest.main()
