import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_runtime import runner
from task_runtime.adapters.antigravity import make_write_output
from task_runtime.protocol import MAX_ARTIFACT_BYTES, MAX_ENCODED_REQUEST_BYTES, ProtocolError, decode_request, encode_request, validate_request, validate_result


def request(run_id="ax-run-0123456789abcdef", **changes):
    value = {"schema_version": 1, "run_id": run_id, "adapter": "offline", "instruction": "入力をまとめてください。", "inputs": {"a.txt": "一つ目\n", "b.txt": "二つ目\n"}, "output_name": "answer.txt"}
    value.update(changes)
    return value


class ProtocolTests(unittest.TestCase):
    def test_utf8_roundtrip(self):
        original = request()
        self.assertEqual(decode_request(encode_request(original)), original)

    def test_request_boundaries(self):
        cases = [
            {"extra": True}, {"adapter": "untrusted"}, {"run_id": "../id"},
            {"schema_version": True}, {"instruction": " "},
            {"instruction": "あ" * 683}, {"instruction": "\x00"},
            {"inputs": {"../x": "text"}}, {"inputs": {"a": "a" * 4097}},
            {"inputs": {str(i): "" for i in range(5)}},
            {"inputs": {"a": True}}, {"output_name": "/tmp/file"},
            {"output_name": "."}, {"output_name": "../file"},
        ]
        for change in cases:
            with self.subTest(change=change), self.assertRaises(ProtocolError):
                validate_request(request(**change))

    def test_encoded_request_is_bounded_and_duplicate_keys_rejected(self):
        for encoded in ("A" * (MAX_ENCODED_REQUEST_BYTES + 1), "not_base64", "あ", base64.b64encode(b'{"schema_version":1,"schema_version":2}').decode()):
            with self.assertRaises(ProtocolError):
                decode_request(encoded)

    def test_nonfinite_usage_rejected(self):
        result = {"schema_version": 1, "run_id": request()["run_id"], "adapter": "offline", "status": "failed", "exit_code": 1, "stop_reason": None, "usage": {"total": float("nan")}, "estimated_usd": None, "error_type": "Unavailable", "artifact": None}
        with self.assertRaises(ProtocolError):
            validate_result(result)


class WriteOutputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "output"
        self.workspace.mkdir()
        self.write_output = make_write_output(self.workspace, "answer.txt")

    def test_writes_utf8_once_to_fixed_output(self):
        self.assertEqual(self.write_output("日本語\n"), "Output saved.")
        self.assertEqual((self.workspace / "answer.txt").read_bytes(), "日本語\n".encode())
        with self.assertRaises(FileExistsError):
            self.write_output("replacement")
        self.assertEqual((self.workspace / "answer.txt").read_text(), "日本語\n")

    def test_content_is_the_only_argument(self):
        with self.assertRaises(TypeError):
            self.write_output(content="text", path="../outside.txt")
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_invalid_or_large_content_has_no_side_effect(self):
        for content in (None, True, "\ud800", "a" * (MAX_ARTIFACT_BYTES + 1), "あ" * (MAX_ARTIFACT_BYTES // 3 + 1)):
            with self.subTest(kind=type(content).__name__), self.assertRaises(ValueError):
                self.write_output(content)
            self.assertEqual(list(self.workspace.iterdir()), [])
        self.write_output("a" * MAX_ARTIFACT_BYTES)
        self.assertEqual((self.workspace / "answer.txt").stat().st_size, MAX_ARTIFACT_BYTES)

    def test_existing_file_and_symlink_are_not_modified(self):
        target = self.workspace / "answer.txt"
        outside = self.root / "outside.txt"
        outside.write_text("unchanged")
        target.write_text("existing")
        with self.assertRaises(FileExistsError):
            self.write_output("replace")
        self.assertEqual(target.read_text(), "existing")
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaises(FileExistsError):
            self.write_output("escape")
        self.assertEqual(outside.read_text(), "unchanged")

    def test_symlink_output_directory_is_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.workspace, target_is_directory=True)
        with self.assertRaises(ValueError):
            make_write_output(alias, "answer.txt")

    def test_replaced_output_directory_is_rejected(self):
        self.workspace.rename(self.root / "original")
        self.workspace.mkdir()
        with self.assertRaises(ValueError):
            self.write_output("escape")
        self.assertEqual(list(self.workspace.iterdir()), [])

    def test_output_name_cannot_escape(self):
        for name in ("../outside.txt", "/tmp/outside.txt", ".hidden"):
            with self.subTest(name=name), self.assertRaises(ProtocolError):
                make_write_output(self.workspace, name)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "run"

    def prepare(self, value=None):
        value = value or request()
        runner.stage(self.root, encode_request(value))
        runner.start(self.root, value["run_id"])
        return value

    def fake_child(self, body):
        original = subprocess.Popen

        def launch(command, **kwargs):
            return original([sys.executable, "-c", "import json, pathlib, sys, time, subprocess\nroot=pathlib.Path(sys.argv[1])\n" + body, str(self.root)], **kwargs)

        return patch.object(runner.subprocess, "Popen", side_effect=launch)

    def receipt_code(self, usage=None, stop_reason="OFFLINE", estimate=0):
        if usage is None:
            usage = {"prompt_token_count": 0, "candidates_token_count": 0, "thoughts_token_count": 0, "total_token_count": 0}
        receipt = {"usage": usage, "estimated_usd": estimate, "stop_reason": stop_reason}
        return "(root/'receipt.json').write_text(" + repr(json.dumps(receipt)) + ")\n"

    def test_two_offline_runs_keep_separate_artifacts(self):
        for index, content in enumerate(("first\n", "second\n")):
            self.root = Path(self.temporary.name) / str(index)
            value = self.prepare(request(f"ax-run-{index:016x}", inputs={"a.txt": content}))
            result = runner.execute(self.root)
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["adapter"], "offline")
            self.assertEqual(result["estimated_usd"], 0)
            collected = runner.collect(self.root, value["run_id"])
            self.assertEqual(base64.b64decode(collected["artifact_base64"]), content.encode())
            self.assertEqual(runner.status(self.root, value["run_id"])["state"], "finished")
        self.assertEqual((Path(self.temporary.name) / "0/output/answer.txt").read_text(), "first\n")

    def test_offline_without_inputs_copies_instruction(self):
        value = self.prepare(request(inputs={}))
        self.assertEqual(runner.execute(self.root)["status"], "succeeded")
        self.assertEqual((self.root / "output/answer.txt").read_text(), value["instruction"])

    def test_invalid_stage_has_no_side_effect(self):
        with self.assertRaises(ProtocolError):
            runner.stage(self.root, "not_base64")
        self.assertFalse(self.root.exists())

    def test_stage_start_and_attempt_are_exclusive(self):
        value = self.prepare()
        for action in (lambda: runner.stage(self.root, encode_request(value)), lambda: runner.start(self.root, value["run_id"])):
            with self.assertRaises(FileExistsError):
                action()
        runner.execute(self.root)
        with self.assertRaises(FileExistsError):
            runner.execute(self.root)
        with self.assertRaises(ProtocolError):
            runner.start(self.root, value["run_id"])
        runner.wait(self.root)
        self.assertEqual((self.root / "output/answer.txt").read_text(), "一つ目\n二つ目\n")

    def test_concurrent_stage_has_one_winner(self):
        def attempt(_):
            try:
                runner.stage(self.root, encode_request(request()))
                return True
            except FileExistsError:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(attempt, range(2))), [False, True])

    def test_run_id_mismatch_does_not_start(self):
        runner.stage(self.root, encode_request(request()))
        with self.assertRaises(ProtocolError):
            runner.start(self.root, "ax-run-ffffffffffffffff")
        self.assertFalse((self.root / "start").exists())

    def test_status_and_collect_do_not_start(self):
        value = request()
        self.assertEqual(runner.status(self.root, value["run_id"])["state"], "waiting")
        runner.stage(self.root, encode_request(value))
        self.assertEqual(runner.status(self.root, value["run_id"])["state"], "staged")
        runner.start(self.root, value["run_id"])
        self.assertEqual(runner.status(self.root, value["run_id"])["state"], "started")
        self.assertFalse(runner.status(self.root, value["run_id"])["attempted"])
        with self.assertRaises(ProtocolError):
            runner.collect(self.root, value["run_id"])
        self.assertFalse((self.root / "attempted").exists())

    def test_symlink_root_is_rejected(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        self.root.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ProtocolError):
            runner.stage(self.root, encode_request(request()))
        self.assertEqual(list(outside.iterdir()), [])

    def test_invalid_artifacts_never_succeed(self):
        for index, body in enumerate((
            "(root/'output/answer.txt').symlink_to(root/'request.json')\n",
            f"(root/'output/answer.txt').write_bytes(b'x'*{MAX_ARTIFACT_BYTES + 1})\n",
            "(root/'output/answer.txt').mkdir()\n",
            "",
        )):
            with self.subTest(index=index):
                self.root = Path(self.temporary.name) / str(index)
                self.prepare()
                with self.fake_child(body + self.receipt_code()):
                    result = runner.execute(self.root)
                self.assertEqual(result["status"], "failed")
                self.assertIsNone(result["artifact"])

    def test_collect_rejects_modified_and_symlink_artifacts(self):
        value = self.prepare()
        runner.execute(self.root)
        artifact = self.root / "output/answer.txt"
        artifact.write_text("changed")
        with self.assertRaises(ProtocolError):
            runner.collect(self.root, value["run_id"])
        artifact.unlink()
        artifact.symlink_to(self.root / "request.json")
        with self.assertRaises(OSError):
            runner.collect(self.root, value["run_id"])

    def test_missing_usage_is_failure_even_with_artifact(self):
        self.prepare()
        with self.fake_child("(root/'output/answer.txt').write_text('done')\n"):
            result = runner.execute(self.root)
        self.assertEqual(result["error_type"], "UsageUnavailable")
        self.assertEqual(result["status"], "failed")

    def test_zero_model_usage_is_not_success(self):
        self.prepare(request(adapter="antigravity"))
        with self.fake_child("(root/'output/answer.txt').write_text('done')\n" + self.receipt_code(stop_reason="UNSPECIFIED")):
            result = runner.execute(self.root)
        self.assertEqual(result["error_type"], "UsageUnavailable")

    def test_budget_stop_is_not_success(self):
        self.prepare(request(adapter="antigravity"))
        usage = {"prompt_token_count": 100, "candidates_token_count": 20, "thoughts_token_count": 0, "total_token_count": 120}
        with self.fake_child("(root/'output/answer.txt').write_text('partial')\n" + self.receipt_code(usage, "MAX_MODEL_CALLS_EXCEEDED", 0.001)):
            result = runner.execute(self.root)
        self.assertEqual(result["error_type"], "AgentStopped")
        self.assertEqual(result["usage"], usage)
        self.assertIsNone(result["artifact"])

    def test_adapter_error_does_not_copy_secret(self):
        self.prepare()
        with self.fake_child("raise RuntimeError('fake-secret-that-must-not-be-logged')\n"):
            result = runner.execute(self.root)
        self.assertEqual(result["error_type"], "AdapterFailed")
        self.assertNotIn("fake-secret", (self.root / "result.json").read_text())

    def test_timeout_kills_descendants(self):
        self.prepare()
        body = "subprocess.Popen([sys.executable, '-c', \"import pathlib,sys,time; time.sleep(0.5); pathlib.Path(sys.argv[1]).write_text('leaked')\", str(root/'late-write')])\ntime.sleep(5)\n"
        with self.fake_child(body):
            result = runner.execute(self.root, timeout=0.2)
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["exit_code"], 124)
        time.sleep(0.5)
        self.assertFalse((self.root / "late-write").exists())

    def test_cli_wait_and_collection(self):
        executable = [sys.executable, str(Path(runner.__file__)), "--root", str(self.root)]
        process = subprocess.Popen(executable + ["wait"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        value = request()
        staged = subprocess.run(executable + ["stage", encode_request(value)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(staged.stdout)["state"], "staged")
        subprocess.run(executable + ["start", value["run_id"]], capture_output=True, text=True, check=True)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual((process.returncode, stdout, stderr), (0, "", ""))
        collected = subprocess.run(executable + ["collect", value["run_id"]], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(collected.stdout)["result"]["status"], "succeeded")
        rejected = subprocess.run(executable + ["stage", "secret-invalid-base64"], capture_output=True, text=True)
        self.assertEqual(rejected.returncode, 1)
        self.assertNotIn("secret", rejected.stdout + rejected.stderr)


if __name__ == "__main__":
    unittest.main()
