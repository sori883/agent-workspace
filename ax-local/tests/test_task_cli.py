import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_cli import TaskCLI, TaskError, Transport, make_request, read_json, save_json


IMAGE = "localhost:5001/ax-task-runner@sha256:" + "a" * 64


def request(number=1, offline=True):
    return {"schema_version": 1, "run_id": f"ax-run-{number:016x}",
            "adapter": "offline" if offline else "antigravity", "instruction": "Create a summary",
            "inputs": {"input.txt": "A small input"}, "output_name": "answer.txt"}


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.requests = {}
        self.started = set()
        self.fail_start = False
        self.fail_close = False
        self.fail_suspend = False
        self.fail_stage = False
        self.artifact_mismatch = False
        self.result_status = "succeeded"
        self.unknown_usage = False
        self.always_running = False
        self.cost = 0.0004
        self.on_start = None
        self.phases = {}
        self.status_failures_after_start = 0

    def apply(self, path):
        manifest = read_json(path)
        self.calls.append(("apply", manifest["metadata"]["name"]))

    def resume(self, run_id):
        self.calls.append(("resume", run_id))
        self.phases[run_id] = "Running"

    def suspend(self, run_id):
        self.calls.append(("suspend", run_id))
        if self.fail_suspend:
            raise TaskError("suspend_failed")
        self.phases[run_id] = "Suspended"

    def actor(self, run_id):
        self.calls.append(("actor", run_id))
        return run_id

    def task_state(self, run_id):
        self.calls.append(("task_state", run_id))
        return {"phase": self.phases[run_id], "actor": run_id}

    def egress(self, actor, allow):
        self.calls.append(("allow" if allow else "deny", actor))
        if not allow and self.fail_close:
            raise TaskError("deny_failed")

    def result(self, run_id):
        data = (run_id + "\n").encode()
        offline = self.requests[run_id]["adapter"] == "offline"
        return {
            "schema_version": 1, "run_id": run_id, "adapter": self.requests[run_id]["adapter"],
            "status": "failed" if self.unknown_usage else self.result_status,
            "exit_code": 1 if self.unknown_usage or self.result_status != "succeeded" else 0,
            "stop_reason": ("OFFLINE" if offline else "UNSPECIFIED") if self.result_status == "succeeded" else "adapter_failed",
            "usage": None if self.unknown_usage else {"prompt_token_count": 0 if offline else 30,
                "candidates_token_count": 0 if offline else 10, "thoughts_token_count": 0,
                "total_token_count": 0 if offline else 40},
            "estimated_usd": None if self.unknown_usage else (0.0 if offline else self.cost),
            "error_type": "unknown_usage" if self.unknown_usage else None,
            "artifact": {"name": "answer.txt", "size_bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest()},
        }

    def guest(self, run_id, operation, argument=None):
        self.calls.append((operation, run_id))
        if operation == "stage":
            if self.fail_stage:
                raise RuntimeError("PRIVATE_INPUT_MUST_NOT_PRINT")
            self.requests[run_id] = json.loads(base64.b64decode(argument))
            return {"run_id": run_id, "state": "staged"}
        if operation == "start":
            if self.on_start:
                self.on_start(run_id)
            self.started.add(run_id)
            if self.fail_start:
                raise TaskError("start_transport_lost")
            return {"run_id": run_id, "state": "started"}
        if operation == "status":
            if run_id in self.started and self.status_failures_after_start:
                self.status_failures_after_start -= 1
                raise TaskError("transport_command_failed")
            state = "waiting" if run_id not in self.started else "finished"
            if self.always_running and run_id in self.started:
                state = "running"
            return {"run_id": run_id, "state": state,
                    "result": self.result(run_id) if state == "finished" else None}
        if operation == "collect":
            data = (run_id + "\n").encode()
            if self.artifact_mismatch:
                data += b"tampered"
            return {"result": self.result(run_id), "artifact_base64": base64.b64encode(data).decode()}
        raise AssertionError(operation)


class CLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        save_json(self.root / "versions.json", {"runner_task": IMAGE})
        self.transport = FakeTransport()
        self.now = 0
        self.cli = TaskCLI(self.root, self.transport, clock=lambda: self.now, sleep=self.advance)

    def tearDown(self):
        self.temporary.cleanup()

    def advance(self, seconds):
        self.now += seconds

    def test_two_offline_runs_have_separate_artifacts_and_no_allow(self):
        for number in (1, 2):
            data = request(number)
            receipt = self.cli.run(data)
            self.assertEqual(receipt["outcome"], "succeeded")
            self.assertTrue(receipt["resolved"])
            output = self.cli.runs / data["run_id"] / "artifacts/answer.txt"
            self.assertEqual(output.read_text(), data["run_id"] + "\n")
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.cli.inspect(data["run_id"]), receipt)
        self.assertFalse(any(name == "allow" for name, _ in self.transport.calls))

    def test_dry_run_does_not_call_transport(self):
        receipt = self.cli.run(request(offline=False), dry_run=True)
        self.assertEqual(receipt["outcome"], "dry_run")
        self.assertEqual(self.transport.calls, [])
        manifest = read_json(self.cli.runs / receipt["run_id"] / "manifest.json")
        self.assertEqual(manifest["spec"]["command"], ["python3", "/opt/ax-task/runner.py", "wait"])

    def test_wrapper_dry_run_and_inspect_work_without_ax_binary(self):
        source = Path(__file__).resolve().parents[1]
        for name in ("task", "task_cli.py"):
            shutil.copyfile(source / name, self.root / name)
        (self.root / "task_runtime").mkdir()
        for name in ("__init__.py", "protocol.py"):
            shutil.copyfile(source / "task_runtime" / name, self.root / "task_runtime" / name)
        instruction = self.root / "instruction.txt"
        instruction.write_text("作業結果を出力してください。")
        instruction_input = self.root / "input.txt"
        instruction_input.write_text("小さな入力")
        result = subprocess.run(["bash", str(self.root / "task"), "run", "--instruction-file", str(instruction),
                                 "--input", str(instruction_input), "--output", "answer.txt", "--offline", "--dry-run"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["outcome"], "dry_run")
        run_id = receipt["run_id"]
        saved_request = read_json(self.cli.runs / run_id / "request.json")
        self.assertEqual(saved_request["inputs"], {"input.txt": "小さな入力"})
        inspected = subprocess.run(["bash", str(self.root / "task"), "inspect", run_id],
                                   capture_output=True, text=True, timeout=5)
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertEqual(json.loads(inspected.stdout), receipt)

    def test_start_intent_is_durable_before_transport(self):
        def check(run_id):
            receipt = self.cli.inspect(run_id)
            self.assertTrue(receipt["start_attempted"])
            self.assertEqual(receipt["phase"], "start_attempted")
        self.transport.on_start = check
        self.cli.run(request(offline=False))
        names = [name for name, _ in self.transport.calls]
        self.assertLess(names.index("allow"), names.index("start"))
        self.assertLess(names.index("deny"), names.index("suspend"))

    def test_ambiguous_start_blocks_new_paid_run_and_recover_never_resends(self):
        self.transport.fail_start = True
        receipt = self.cli.run(request(offline=False))
        self.assertEqual(receipt["outcome"], "failed")
        self.assertFalse(receipt["resolved"])
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.cli.run(request(2, offline=False))
        recovered = self.cli.recover(receipt["run_id"])
        self.assertFalse(recovered["resolved"])
        self.assertEqual(recovered["error_type"], "suspended_result_unavailable_manual_inspection")
        self.assertEqual(sum(name == "start" for name, _ in self.transport.calls), 1)
        self.assertEqual(sum(name == "apply" for name, _ in self.transport.calls), 1)
        self.assertEqual(sum(name == "resume" for name, _ in self.transport.calls), 1)

    def test_running_recovery_collects_without_resume_or_start(self):
        self.transport.fail_start = True
        self.transport.fail_suspend = True
        receipt = self.cli.run(request(offline=False))
        self.transport.fail_suspend = False
        before = len(self.transport.calls)
        recovered = self.cli.recover(receipt["run_id"])
        self.assertTrue(recovered["resolved"])
        names = [name for name, _ in self.transport.calls[before:]]
        self.assertIn("collect", names)
        self.assertNotIn("resume", names)
        self.assertNotIn("start", names)
        self.assertNotIn("apply", names)

    def test_deny_failure_keeps_receipt_unresolved_and_suspend_is_attempted(self):
        self.transport.fail_close = True
        receipt = self.cli.run(request(offline=False))
        self.assertEqual(receipt["result"]["status"], "succeeded")
        self.assertEqual(receipt["outcome"], "failed")
        self.assertFalse(receipt["resolved"])
        self.assertTrue(receipt["cleanup"]["suspended"])
        self.transport.fail_close = False
        self.assertTrue(self.cli.recover(receipt["run_id"])["resolved"])

    def test_suspend_failure_is_not_success(self):
        self.transport.fail_suspend = True
        receipt = self.cli.run(request())
        self.assertEqual(receipt["outcome"], "failed")
        self.assertTrue(receipt["cleanup"]["egress_denied"])
        self.assertFalse(receipt["resolved"])

    def test_failed_paid_fingerprint_refuses_repeat_even_with_new_id(self):
        self.transport.result_status = "failed"
        self.assertTrue(self.cli.run(request(offline=False))["resolved"])
        with self.assertRaisesRegex(TaskError, "failed_request_already_attempted"):
            self.cli.run(request(2, offline=False))
        changed = request(3, offline=False)
        changed["instruction"] = "Changed after diagnosis"
        self.transport.result_status = "succeeded"
        with self.assertRaisesRegex(TaskError, "paid_failure_requires_review"):
            self.cli.run(changed)
        original = self.cli.inspect(request()["run_id"])
        calls_before = len(self.transport.calls)
        acknowledged = self.cli.acknowledge_failure(request()["run_id"], "原因: 指示の出力名が不明確。修正: 出力名を明示した。")
        self.assertEqual(len(self.transport.calls), calls_before)
        self.assertEqual(acknowledged["result"], original["result"])
        self.assertEqual(acknowledged["fingerprint"], original["fingerprint"])
        with self.assertRaisesRegex(TaskError, "failed_request_already_attempted"):
            self.cli.run(request(2, offline=False))
        self.assertEqual(self.cli.run(changed)["outcome"], "succeeded")

    def test_paid_failure_allows_offline_diagnosis_without_acknowledgement(self):
        self.transport.result_status = "failed"
        self.cli.run(request(offline=False))
        self.transport.result_status = "succeeded"
        self.assertEqual(self.cli.run(request(2))["outcome"], "succeeded")

    def test_acknowledgement_requires_known_usage_and_verified_cleanup(self):
        for defect in ("unknown_usage", "fail_close", "fail_suspend"):
            with self.subTest(defect=defect):
                isolated = self.root / defect
                isolated.mkdir()
                save_json(isolated / "versions.json", {"runner_task": IMAGE})
                transport = FakeTransport()
                transport.result_status = "failed"
                setattr(transport, defect, True)
                cli = TaskCLI(isolated, transport)
                receipt = cli.run(request(offline=False))
                calls_before = len(transport.calls)
                with self.assertRaisesRegex(TaskError, "failure_review_unresolved"):
                    cli.acknowledge_failure(receipt["run_id"], "原因調査と修正の記録")
                self.assertEqual(len(transport.calls), calls_before)
                self.assertNotIn("failure_review", cli.inspect(receipt["run_id"]))

    def test_acknowledgement_rejects_empty_oversized_and_nonfailed_records(self):
        self.transport.result_status = "failed"
        self.cli.run(request(offline=False))
        for note in ("", "  \n", "あ" * 683, "contains\x00nul"):
            with self.subTest(note_size=len(note)):
                with self.assertRaisesRegex(TaskError, "invalid_review_note"):
                    self.cli.acknowledge_failure(request()["run_id"], note)
        self.transport.result_status = "succeeded"
        self.cli.run(request(2))
        with self.assertRaisesRegex(TaskError, "not_failed_paid_run"):
            self.cli.acknowledge_failure(request(2)["run_id"], "確認済み")

    def test_acknowledgement_allows_corrected_image_and_retains_review_note(self):
        self.transport.result_status = "failed"
        failed = self.cli.run(request(offline=False))
        save_json(self.root / "versions.json", {"runner_task": IMAGE[:-64] + "b" * 64})
        with self.assertRaisesRegex(TaskError, "paid_failure_requires_review"):
            self.cli.run(request(2, offline=False))
        note = "原因: adapter設定誤り。修正済みimageをオフライン検証した。"
        self.cli.acknowledge_failure(failed["run_id"], note)
        self.assertEqual(self.cli.inspect(failed["run_id"])["failure_review"]["note"], note)
        self.transport.result_status = "succeeded"
        self.assertEqual(self.cli.run(request(2, offline=False))["outcome"], "succeeded")

    def test_wrapper_acknowledges_failure_locally_and_preserves_review(self):
        self.transport.result_status = "failed"
        failed = self.cli.run(request(offline=False))
        source = Path(__file__).resolve().parents[1]
        for name in ("task", "task_cli.py"):
            shutil.copyfile(source / name, self.root / name)
        (self.root / "task_runtime").mkdir()
        for name in ("__init__.py", "protocol.py"):
            shutil.copyfile(source / "task_runtime" / name, self.root / "task_runtime" / name)
        command = ["bash", str(self.root / "task"), "acknowledge-failure", failed["run_id"]]
        missing = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(missing.returncode, 2)
        blank = subprocess.run([*command, "--note", " \n"], capture_output=True, text=True, timeout=5)
        self.assertEqual(blank.returncode, 1)
        self.assertEqual(json.loads(blank.stderr), {"error_type": "invalid_review_note"})
        note = "原因は出力名の指定不足。明示した指示でオフライン検証済み。"
        for _ in range(2):
            acknowledged = subprocess.run([*command, "--note", note], capture_output=True, text=True, timeout=5)
            self.assertEqual(acknowledged.returncode, 0, acknowledged.stderr)
            saved = json.loads(acknowledged.stdout)
            self.assertEqual(saved["failure_review"]["note"], note)
            self.assertEqual(saved["result"], failed["result"])
            self.assertEqual(saved["outcome"], "failed")
        overwrite = subprocess.run([*command, "--note", "別の理由で上書き"], capture_output=True, text=True, timeout=5)
        self.assertEqual(overwrite.returncode, 1)
        self.assertEqual(json.loads(overwrite.stderr), {"error_type": "failure_already_reviewed"})
        self.assertEqual(self.cli.inspect(failed["run_id"])["failure_review"]["note"], note)

    def test_unknown_usage_blocks_future_paid_run(self):
        self.transport.unknown_usage = True
        receipt = self.cli.run(request(offline=False))
        self.assertFalse(receipt["resolved"])
        with self.assertRaisesRegex(TaskError, "unresolved_run"):
            self.cli.run(request(2, offline=False))

    def test_cumulative_pilot_limit_blocks_paid_but_not_offline(self):
        self.transport.cost = 0.01
        self.cli.run(request(offline=False))
        with self.assertRaisesRegex(TaskError, "pilot_estimate_limit"):
            self.cli.run(request(2, offline=False))
        self.assertEqual(self.cli.run(request(3))["outcome"], "succeeded")

    def test_collection_rejects_tampered_artifact(self):
        self.transport.artifact_mismatch = True
        receipt = self.cli.run(request(offline=False))
        self.assertEqual(receipt["error_type"], "artifact_verification_failed")
        self.assertFalse((self.cli.runs / receipt["run_id"] / "artifacts").exists())
        self.assertFalse(receipt["resolved"])

    def test_timeout_is_bounded_and_cleanup_runs(self):
        self.transport.always_running = True
        receipt = self.cli.run(request(offline=False))
        self.assertEqual(receipt["error_type"], "result_timeout")
        self.assertEqual(self.now, 120)
        self.assertFalse(receipt["resolved"])
        self.assertTrue(receipt["cleanup"]["egress_denied"])

    def test_transient_status_transport_failure_retries_reads_only(self):
        self.transport.status_failures_after_start = 2
        receipt = self.cli.run(request(offline=False))
        self.assertEqual(receipt["outcome"], "succeeded")
        self.assertEqual(self.now, 4)
        self.assertEqual(sum(name == "start" for name, _ in self.transport.calls), 1)
        self.assertEqual(sum(name == "apply" for name, _ in self.transport.calls), 1)

    def test_exception_payload_is_not_persisted(self):
        self.transport.fail_stage = True
        receipt = self.cli.run(request())
        self.assertEqual(receipt["error_type"], "RuntimeError")
        self.assertNotIn("PRIVATE_INPUT", json.dumps(receipt))

    def test_concurrent_invocation_is_rejected(self):
        with self.cli.locked():
            other = TaskCLI(self.root, self.transport)
            with self.assertRaisesRegex(TaskError, "another_cli_running"):
                other.run(request())
        self.assertEqual(self.transport.calls, [])

    def test_duplicate_id_never_applies_twice(self):
        self.cli.run(request())
        with self.assertRaises(FileExistsError):
            self.cli.run(request())
        self.assertEqual(sum(name == "apply" for name, _ in self.transport.calls), 1)

    def test_corrupt_ledger_blocks_new_run(self):
        self.cli.runs.mkdir(parents=True)
        (self.cli.runs / request()["run_id"]).mkdir()
        with self.assertRaisesRegex(TaskError, "file_unreadable"):
            self.cli.run(request(2))

    def test_input_validation_rejects_symlinks_binary_and_size(self):
        source = self.root / "instruction.txt"
        source.write_text("Do a small task")
        linked = self.root / "linked.txt"
        linked.symlink_to(source)
        with self.assertRaisesRegex(TaskError, "symlink"):
            make_request(linked, [], "answer.txt")
        source.write_bytes(b"a" * 2049)
        with self.assertRaisesRegex(TaskError, "size"):
            make_request(source, [], "answer.txt")
        source.write_bytes(b"\xff")
        with self.assertRaises(UnicodeDecodeError):
            make_request(source, [], "answer.txt")

    def test_unknown_and_path_inputs_rejected_without_transport(self):
        invalid = request()
        invalid["output_name"] = "../escape"
        with self.assertRaises(Exception):
            self.cli.run(invalid)
        invalid = request()
        invalid["extra"] = "unsupported"
        with self.assertRaises(Exception):
            self.cli.run(invalid)
        self.assertEqual(self.transport.calls, [])

    def test_transport_uses_argv_and_does_not_expose_stderr(self):
        transport = Transport(self.root)
        with self.assertRaisesRegex(TaskError, "transport_command_failed"):
            transport.command([sys.executable, "-c", "import sys; print('SECRET', file=sys.stderr); sys.exit(1)"])
        with patch.object(transport, "command", return_value='{"run_id":"id","state":"staged"}') as command:
            transport.guest(request()["run_id"], "stage", "dGVzdA==")
        arguments = command.call_args.args[0]
        self.assertEqual(arguments[-2:], ["stage", "dGVzdA=="])
        self.assertNotIn("-c", arguments)


if __name__ == "__main__":
    unittest.main()
