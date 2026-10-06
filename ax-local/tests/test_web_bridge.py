import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_cli import TaskCLI, TaskError, Transport, read_json, save_json
from web_bridge import WebBridge, error_response, parse_submission
from test_task_cli import FakeTransport, IMAGE, request


OWNER = "10000000-0000-4000-8000-000000000001"


def submission(**changes):
    value = {"key": str(uuid.uuid4()), "mode": "offline", "instruction": "入力を成果物へ保存する",
             "input_text": "hello", "output_name": "answer.txt", "allow_model": False}
    return {**value, **changes}


def concurrent_submit(root, value, gate, queue):
    bridge = WebBridge(TaskCLI(Path(root), FakeTransport()), launch=lambda *_: None, owner_user_id=OWNER)
    gate.wait(5)
    try:
        queue.put(bridge.submit(value))
    except Exception as error:
        queue.put(error_response(error))


def crash_publish(root, value, after):
    bridge = WebBridge(TaskCLI(Path(root), FakeTransport()), launch=lambda *_: None, owner_user_id=OWNER)
    original = os.rename
    def rename(source, target):
        for name in ("request.json", "manifest.json", "receipt.json"):
            read_json(Path(source) / name)
        assert read_json(Path(source) / "receipt.json")["owner_user_id"] == OWNER
        if after:
            original(source, target)
        os.kill(os.getpid(), signal.SIGKILL)
    with patch("task_cli.os.rename", side_effect=rename):
        bridge.submit(value)


def execute_process(root, run_id, gate, queue, kill_at_start=False):
    transport = FakeTransport()
    if kill_at_start:
        transport.on_start = lambda _: os.kill(os.getpid(), signal.SIGKILL)
    cli = TaskCLI(Path(root), transport)
    gate.wait(5)
    try:
        receipt = cli.execute_accepted(run_id)
        queue.put({"outcome": receipt["outcome"], "calls": transport.calls})
    except Exception as error:
        queue.put(error_response(error))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        save_json(self.root / "versions.json", {"runner_task": IMAGE})
        self.transport = FakeTransport()
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
            self.fail("diagnostic subprocess did not finish")

    def test_accept_replay_and_legacy_cli_share_one_reservation(self):
        value = submission()
        first = self.bridge.submit(value)
        self.assertFalse(first["replayed"])
        with self.cli.locked():
            replay = self.bridge.submit(value)
        self.assertEqual(replay, {"run_id": first["run_id"], "replayed": True})
        self.assertEqual(self.launches, [("execute", first["run_id"])])
        self.assertEqual(self.transport.calls, [])
        with self.assertRaisesRegex(TaskError, "idempotency_conflict"):
            self.bridge.submit({**value, "input_text": "different"})
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.cli.run(request())
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.bridge.submit(submission())
        details = self.bridge.get({"run_id": first["run_id"]})
        self.assertEqual(details["summary"]["state"], "accepted")
        self.assertTrue(details["summary"]["can_recover"])

    def test_single_execution_result_and_verified_artifact(self):
        accepted = self.bridge.submit(submission())
        run_id = accepted["run_id"]
        self.assertEqual(self.cli.execute_accepted(run_id)["outcome"], "succeeded")
        with self.assertRaisesRegex(TaskError, "execution_already_claimed"):
            self.cli.execute_accepted(run_id)
        details = self.bridge.get({"run_id": run_id})
        self.assertEqual(details["summary"]["state"], "succeeded")
        self.assertEqual(details["result"]["usage"]["total_token_count"], 0)
        self.assertEqual(details["cleanup"], {"egress_denied": True, "suspended": True})
        self.assertEqual(self.bridge.artifact({"run_id": run_id}), {"name": "answer.txt", "content": run_id + "\n"})
        self.assertEqual(sum(name == "start" for name, _ in self.transport.calls), 1)
        self.assertFalse(any(name == "allow" for name, _ in self.transport.calls))
        path = self.cli.directory(run_id) / "artifacts/answer.txt"
        path.write_text("tampered")
        with self.assertRaisesRegex(TaskError, "artifact_verification_failed"):
            self.bridge.artifact({"run_id": run_id})

    def test_artifact_size_hash_utf8_and_symlink_are_checked(self):
        run_id = self.bridge.submit(submission())["run_id"]
        self.cli.execute_accepted(run_id)
        directory = self.cli.directory(run_id)
        output = directory / "artifacts/answer.txt"
        receipt = self.cli.inspect(run_id)
        for content in (b"\x01" * 65536, b"\xff"):
            output.write_bytes(content)
            receipt["result"]["artifact"].update(size_bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
            self.cli.store(directory, receipt)
            if content == b"\xff":
                with self.assertRaises(UnicodeDecodeError):
                    self.bridge.artifact({"run_id": run_id})
            else:
                response = WebBridge.dispatch("artifact", {"owner_user_id": OWNER, "input": {"run_id": run_id}}, cli=self.cli)
                self.assertEqual(response["data"]["content"].encode(), content)
                self.assertLess(len(json.dumps(response).encode()), 512 * 1024)
        output.unlink()
        output.symlink_to(self.root / "versions.json")
        with self.assertRaisesRegex(TaskError, "symlink_rejected"):
            self.bridge.artifact({"run_id": run_id})

    def test_parent_directory_is_fsynced_before_accept_returns(self):
        synced = []
        original = os.fsync
        def fsync(fd):
            synced.append(os.fstat(fd).st_ino)
            return original(fd)
        with patch("task_cli.os.fsync", side_effect=fsync):
            self.bridge.submit(submission())
        self.assertEqual(synced[-1], self.cli.runs.stat().st_ino)

    def test_failed_spawn_and_delayed_worker_can_only_finish_unstarted(self):
        bridge = WebBridge(self.cli, launch=lambda *_: (_ for _ in ()).throw(OSError("PRIVATE PATH")), owner_user_id=OWNER)
        accepted = bridge.submit(submission())
        self.assertEqual(self.cli.inspect(accepted["run_id"])["error_type"], "worker_spawn_failed")
        self.cli.recover(accepted["run_id"])
        details = bridge.get({"run_id": accepted["run_id"]})
        self.assertEqual(details["summary"]["state"], "not_started")
        self.assertTrue(details["summary"]["resolved"])
        self.assertEqual(details["cleanup"], {"egress_denied": False, "suspended": False})
        with self.assertRaisesRegex(TaskError, "execution_already_claimed"):
            self.cli.execute_accepted(accepted["run_id"])
        self.assertEqual(self.transport.calls, [])
        self.assertEqual(self.cli.run(request())["outcome"], "succeeded")

    def test_recover_does_not_launch_for_resolved_run_and_rejects_busy(self):
        run_id = self.bridge.submit(submission())["run_id"]
        with self.cli.locked():
            with self.assertRaisesRegex(TaskError, "another_cli_running"):
                self.bridge.recover({"run_id": run_id})
        self.assertEqual(self.bridge.recover({"run_id": run_id}), {"run_id": run_id})
        self.assertEqual(self.launches[-1], ("recover", run_id))
        self.cli.recover(run_id)
        before = len(self.launches)
        self.bridge.recover({"run_id": run_id})
        self.assertEqual(len(self.launches), before)

    def test_model_opt_in_and_existing_paid_guards_remain_effective(self):
        with self.assertRaisesRegex(TaskError, "model_not_allowed"):
            self.bridge.submit(submission(mode="model"))
        value = submission(mode="model", allow_model=True)
        run_id = self.bridge.submit(value)["run_id"]
        self.transport.unknown_usage = True
        receipt = self.cli.execute_accepted(run_id)
        self.assertFalse(receipt["resolved"])
        self.assertEqual(self.bridge.get({"run_id": run_id})["summary"]["state"], "needs_recovery")
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.bridge.submit(submission(mode="model", allow_model=True))
        self.assertEqual(self.bridge.submit(value)["run_id"], run_id)
        self.assertEqual(len(self.launches), 1)

    def test_boundaries_and_safe_errors(self):
        invalid = [submission(key="bad"), submission(mode="shell"), submission(allow_model="true"),
                   submission(instruction=" "), submission(instruction="あ" * 683),
                   submission(input_text="あ" * 1366), submission(input_text="\x00"),
                   submission(output_name="../secret"), {**submission(), "path": "/tmp"}]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(Exception):
                    parse_submission(value, OWNER)
        parse_submission(submission(instruction="a" * 2048, input_text="b" * 4096), OWNER)
        self.assertEqual(error_response(RuntimeError("SECRET /private/path")), {"ok": False, "error": {"code": "backend_unavailable", "status": 503}})
        self.assertEqual(error_response(TaskError("unresolved_run:ax-run-0000000000000001"))["error"], {"code": "unresolved_run", "status": 409})
        self.assertEqual(self.bridge.list({}), {"runs": []})
        self.assertFalse(self.cli.runs.exists())

    def test_legacy_receipts_and_active_observation(self):
        receipt = self.cli.run(request(), dry_run=True)
        self.assertEqual(self.bridge.list({}), {"runs": []})
        self.assertEqual(self.cli.inspect(receipt["run_id"]), receipt)
        run_id = self.bridge.submit(submission())["run_id"]
        with self.cli.locked():
            details = self.bridge.get({"run_id": run_id})
            self.assertTrue(details["summary"]["active"])
            self.assertFalse(details["summary"]["can_recover"])

    def test_completion_during_get_does_not_stop_polling_as_recovery(self):
        run_id = self.bridge.submit(submission())["run_id"]
        completed = self.cli.execute_accepted(run_id)
        directory = self.cli.directory(run_id)
        self.cli.store(directory, dict(completed), phase="collecting", resolved=False, outcome=None)
        worker = TaskCLI(self.root, FakeTransport())
        lock = worker.locked()
        lock.__enter__()
        original = self.cli.inspect
        def inspect(value):
            receipt = original(value)
            worker.store(directory, dict(completed))
            lock.__exit__(None, None, None)
            return receipt
        with patch.object(self.cli, "inspect", side_effect=inspect):
            summary = self.bridge.get({"run_id": run_id})["summary"]
        self.assertIn(summary["state"], ("running", "succeeded"))
        self.assertFalse(summary["can_recover"])
        self.assertEqual(self.bridge.get({"run_id": run_id})["summary"]["state"], "succeeded")

    def test_start_during_list_cannot_mix_running_receipt_with_inactive_probe(self):
        run_id = self.bridge.submit(submission())["run_id"]
        worker = TaskCLI(self.root, FakeTransport())
        locks = []
        original = self.cli.inspect
        def inspect(value):
            lock = worker.locked()
            try:
                lock.__enter__()
            except TaskError as error:
                self.assertEqual(str(error), "another_cli_running")
            else:
                locks.append(lock)
                worker.store(worker.directory(value), original(value), phase="apply_attempted", apply_attempted=True)
            return original(value)
        try:
            with patch.object(self.cli, "inspect", side_effect=inspect):
                summary = self.bridge.list({})["runs"][0]
            self.assertIn(summary["state"], ("accepted", "running"))
        finally:
            for lock in locks:
                lock.__exit__(None, None, None)

    def test_parallel_same_key_publishes_exactly_one_run(self):
        gate = self.context.Event()
        queue = self.context.Queue()
        value = submission()
        children = [self.context.Process(target=concurrent_submit, args=(str(self.root), value, gate, queue)) for _ in range(3)]
        for child in children:
            child.start()
        gate.set()
        for child in children:
            self.finish(child)
            self.assertEqual(child.exitcode, 0)
        results = [queue.get(timeout=2) for _ in children]
        self.assertTrue(all("run_id" in result for result in results), results)
        self.assertEqual(len({result["run_id"] for result in results}), 1)
        self.assertEqual(sum(not result["replayed"] for result in results), 1)
        self.assertEqual(len(self.bridge.list({})["runs"]), 1)
        queue.close()

    def test_parallel_changed_payload_conflicts_for_same_key(self):
        gate = self.context.Event()
        queue = self.context.Queue()
        value = submission()
        children = [self.context.Process(target=concurrent_submit, args=(str(self.root), {**value, "input_text": text}, gate, queue)) for text in ("first", "second")]
        for child in children:
            child.start()
        gate.set()
        for child in children:
            self.finish(child)
        results = [queue.get(timeout=2) for _ in children]
        self.assertEqual(sum("run_id" in result for result in results), 1)
        self.assertEqual([result["error"]["code"] for result in results if "error" in result], ["idempotency_conflict"])
        queue.close()

    def test_kill_before_and_after_directory_publication(self):
        for after in (False, True):
            with self.subTest(after=after), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                save_json(root / "versions.json", {"runner_task": IMAGE})
                value = submission()
                child = self.context.Process(target=crash_publish, args=(str(root), value, after))
                child.start()
                self.finish(child)
                self.assertEqual(child.exitcode, -signal.SIGKILL)
                bridge = WebBridge(TaskCLI(root, FakeTransport()), launch=lambda *_: None, owner_user_id=OWNER)
                rows = bridge.list({})["runs"]
                self.assertEqual(len(rows), int(after))
                replay = bridge.submit(value)
                self.assertEqual(replay["replayed"], after)
                bridge.cli.recover(replay["run_id"])
                self.assertEqual(bridge.get({"run_id": replay["run_id"]})["summary"]["state"], "not_started")

    def test_duplicate_workers_claim_once(self):
        run_id = self.bridge.submit(submission())["run_id"]
        gate = self.context.Event()
        queue = self.context.Queue()
        children = [self.context.Process(target=execute_process, args=(str(self.root), run_id, gate, queue)) for _ in range(2)]
        for child in children:
            child.start()
        gate.set()
        for child in children:
            self.finish(child)
        results = [queue.get(timeout=2) for _ in children]
        self.assertEqual(sum(result.get("outcome") == "succeeded" for result in results), 1)
        self.assertEqual(sum(name == "start" for result in results for name, _ in result.get("calls", [])), 1)
        self.assertEqual(self.bridge.get({"run_id": run_id})["summary"]["state"], "succeeded")
        queue.close()

    def test_worker_waits_for_short_local_lock_without_repeating_start(self):
        run_id = self.bridge.submit(submission())["run_id"]
        gate = self.context.Event()
        queue = self.context.Queue()
        child = self.context.Process(target=execute_process, args=(str(self.root), run_id, gate, queue))
        with self.cli.locked():
            child.start()
            gate.set()
            time.sleep(0.3)
        self.finish(child)
        result = queue.get(timeout=2)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual(sum(name == "start" for name, _ in result["calls"]), 1)
        queue.close()

    def test_kill_after_start_intent_never_reexecutes(self):
        run_id = self.bridge.submit(submission())["run_id"]
        gate = self.context.Event()
        queue = self.context.Queue()
        child = self.context.Process(target=execute_process, args=(str(self.root), run_id, gate, queue, True))
        child.start()
        gate.set()
        self.finish(child)
        self.assertEqual(child.exitcode, -signal.SIGKILL)
        receipt = self.cli.inspect(run_id)
        self.assertTrue(receipt["start_attempted"])
        with self.assertRaisesRegex(TaskError, "execution_already_claimed"):
            self.cli.execute_accepted(run_id)
        self.transport.phases[run_id] = "Running"
        self.transport.started.add(run_id)
        self.transport.always_running = True
        self.cli.recover(run_id)
        self.assertFalse(self.cli.inspect(run_id)["resolved"])
        self.assertFalse(any(name in {"start", "resume", "apply"} for name, _ in self.transport.calls))
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.bridge.submit(submission())
        queue.close()

    def test_transport_keeps_lock_after_owning_process_is_killed(self):
        marker = self.root / "command.pid"
        source = str(Path(__file__).resolve().parents[1])
        command = "import os,pathlib,time;pathlib.Path(" + repr(str(marker)) + ").write_text(str(os.getpid()));time.sleep(2)"
        script = "import sys;sys.path.insert(0," + repr(source) + ");from task_cli import TaskCLI;cli=TaskCLI(" + repr(str(self.root)) + ")\nwith cli.locked():cli.transport.command([sys.executable,'-c'," + repr(command) + "])"
        child = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists())
            child.kill()
            child.wait(timeout=3)
            self.assertTrue(self.cli.is_active())
            with self.assertRaisesRegex(TaskError, "another_cli_running"):
                with self.cli.locked():
                    pass
            deadline = time.monotonic() + 5
            while self.cli.is_active() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertFalse(self.cli.is_active())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_cli_envelope_bounds_and_no_filesystem_leak(self):
        source = Path(__file__).resolve().parents[1]
        for name in ("web_bridge.py", "task_cli.py"):
            shutil.copyfile(source / name, self.root / name)
        shutil.copytree(source / "task_runtime", self.root / "task_runtime", ignore=shutil.ignore_patterns("__pycache__"))
        for payload, code in [(b"x" * 65537, "request_too_large"), (b'{"key":1,"key":2}', "invalid_request"), (b"\xff", "invalid_request")]:
            completed = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "submit"], input=payload, capture_output=True, timeout=3)
            self.assertEqual(json.loads(completed.stdout)["error"]["code"], code)
            self.assertEqual(completed.stderr, b"")
        completed = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "list"], input=json.dumps({"owner_user_id": OWNER, "input": {}}).encode(), capture_output=True, timeout=3)
        self.assertEqual(json.loads(completed.stdout), {"ok": True, "data": {"runs": []}})
        self.assertFalse(self.cli.runs.exists())

    def test_real_submit_process_exits_while_finite_worker_owns_receipt(self):
        source = Path(__file__).resolve().parents[1]
        for name in ("web_bridge.py", "task_cli.py"):
            shutil.copyfile(source / name, self.root / name)
        shutil.copytree(source / "task_runtime", self.root / "task_runtime", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "ax").write_text("exit 7\n")
        value = submission()
        completed = subprocess.run([sys.executable, str(self.root / "web_bridge.py"), "submit"],
                                   input=json.dumps({"owner_user_id": OWNER, "input": value}).encode(), capture_output=True, timeout=3)
        self.assertEqual(completed.returncode, 0)
        accepted = json.loads(completed.stdout)
        self.assertTrue(accepted["ok"])
        self.assertEqual(completed.stderr, b"")
        run_id = accepted["data"]["run_id"]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            receipt = self.cli.inspect(run_id)
            if receipt["phase"] == "needs_recovery" and not self.cli.is_active():
                break
            time.sleep(0.02)
        self.assertEqual(receipt["phase"], "needs_recovery")
        self.assertFalse(self.cli.is_active())
        self.assertFalse(receipt["start_attempted"])
        self.assertTrue(self.bridge.submit(value)["replayed"])
        self.assertEqual(self.launches, [])


if __name__ == "__main__":
    unittest.main()
