import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from task_runtime.adapters import gemini_meter


def event(metadata=None, finish="STOP", text="done"):
    value = {"candidates": [{"index": 0, "content": {"role": "model", "parts": [{"text": text}]}}]}
    if finish is not None:
        value["candidates"][0]["finishReason"] = finish
    if metadata is not None:
        value["usageMetadata"] = metadata
    return ("data: " + json.dumps(value) + "\n\n").encode()


def usage(**changes):
    value = {"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120}
    value.update(changes)
    return value


class UsageTests(unittest.TestCase):
    def test_final_usage_and_omitted_zero_thoughts(self):
        metadata = usage()
        del metadata["thoughtsTokenCount"]
        actual = gemini_meter.parse_usage(event(None, finish=None, text="partial") + event(metadata))
        self.assertEqual(actual["thoughts_token_count"], 0)
        self.assertEqual(actual["total_token_count"], 120)

    def test_missing_or_inconsistent_usage_is_unknown(self):
        invalid = [
            None, {}, usage(promptTokenCount=0, totalTokenCount=20),
            usage(totalTokenCount=119), usage(thoughtsTokenCount=-1),
            usage(promptTokenCount=True), usage(candidatesTokenCount=20.0),
            usage(cachedContentTokenCount=101), usage(toolUsePromptTokenCount=1),
            usage(promptTokenCount=gemini_meter.MAX_TOKENS + 1),
        ]
        for metadata in invalid:
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                gemini_meter.parse_usage(event(metadata))

    def test_earlier_usage_does_not_cover_incomplete_final_response(self):
        good = event(usage())
        for body in (
            good + event(None), good[:-1], good + b"data: {", event(usage(), finish=None),
            event(usage(), finish="MAX_TOKENS"), good + b"data: [DONE]\n\n" + good,
            event(usage(promptTokenCount=200, totalTokenCount=220), finish=None) + good,
        ):
            with self.subTest(body=body), self.assertRaises(ValueError):
                gemini_meter.parse_usage(body)


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.responses = []
        self.started = threading.Event()
        self.release = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.seen.append({"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(int(self.headers["Content-Length"]))})
                response = owner.responses.pop(0) if owner.responses else {}
                payload = response.get("body", event(usage()))
                self.send_response(response.get("status", 200))
                self.send_header("Content-Type", response.get("content_type", "text/event-stream"))
                self.send_header("Content-Length", str(len(payload) + response.get("extra_length", 0)))
                self.send_header("Connection", "close")
                if response.get("status") == 302:
                    self.send_header("Location", "/redirected")
                self.end_headers()
                owner.started.set()
                if response.get("block"):
                    owner.release.wait(timeout=2)
                try:
                    self.wfile.write(payload)
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def meter(self):
        return gemini_meter.GeminiMeter("test-upstream-key", upstream_origin=f"http://127.0.0.1:{self.server.server_port}")

    def post(self, meter, *, path=None, headers=None, body=b"{}", method="POST"):
        target = urlsplit(meter.base_url)
        client = http.client.HTTPConnection(target.hostname, target.port, timeout=2)
        try:
            client.request(method, path or gemini_meter.MODEL_PATH + "?alt=sse", body=body, headers=headers or {})
            response = client.getresponse()
            return response.status, response.read()
        finally:
            client.close()

    def test_usage_is_sum_of_every_verified_request(self):
        with self.meter() as meter:
            self.assertEqual(self.post(meter)[0], 200)
            self.assertEqual(self.post(meter)[0], 200)
            self.assertEqual(meter.usage()["total_token_count"], 240)
        self.assertEqual(meter.usage()["prompt_token_count"], 200)
        self.assertEqual(len(self.seen), 2)

    def test_late_missing_usage_blocks_all_later_requests(self):
        self.responses = [{}, {"body": event(None)}]
        with self.meter() as meter:
            self.assertEqual(self.post(meter)[0], 200)
            self.assertEqual(self.post(meter)[0], 502)
            self.assertEqual(self.post(meter)[0], 502)
            self.assertIsNone(meter.usage())
        self.assertEqual(len(self.seen), 2)

    def test_http_errors_and_redirects_are_not_retried(self):
        for status in (302, 503):
            with self.subTest(status=status):
                before = len(self.seen)
                self.responses = [{"status": status}]
                with self.meter() as meter:
                    self.assertEqual(self.post(meter)[0], 502)
                    self.assertEqual(self.post(meter)[0], 502)
                    self.assertIsNone(meter.usage())
                self.assertEqual(len(self.seen), before + 1)

    def test_truncated_and_large_responses_are_unknown(self):
        for response in ({"extra_length": 10}, {"body": b"x" * (gemini_meter.MAX_RESPONSE_BYTES + 1)}, {"content_type": "application/json"}):
            with self.subTest(response_size=len(response.get("body", b""))):
                self.responses = [response]
                with self.meter() as meter:
                    self.assertEqual(self.post(meter)[0], 502)
                    self.assertIsNone(meter.usage())

    def test_fourth_request_is_never_forwarded(self):
        with self.meter() as meter:
            for _ in range(3):
                self.assertEqual(self.post(meter)[0], 200)
            self.assertEqual(self.post(meter)[0], 502)
            self.assertIsNone(meter.usage())
            self.assertEqual(meter.request_count, 3)
        self.assertEqual(len(self.seen), 3)

    def test_target_and_method_cannot_change_upstream(self):
        cases = (
            {"path": "/v1beta/models/expensive:streamGenerateContent?alt=sse"},
            {"path": gemini_meter.MODEL_PATH + "?alt=sse&key=untrusted"},
            {"path": "https://example.invalid" + gemini_meter.MODEL_PATH + "?alt=sse"},
            {"method": "GET"}, {"method": "PUT"},
            {"body": b"x" * (gemini_meter.MAX_REQUEST_BYTES + 1)},
        )
        for arguments in cases:
            with self.subTest(arguments=list(arguments)), self.meter() as meter:
                self.assertIn(self.post(meter, **arguments)[0], (405, 502))
                self.assertEqual(self.post(meter)[0], 502)
                self.assertIsNone(meter.usage())
        self.assertEqual(self.seen, [])

    def test_only_meter_key_is_injected_upstream(self):
        with self.meter() as meter:
            status, payload = self.post(meter, headers={"x-goog-api-key": "incoming-key", "Authorization": "incoming-secret", "Host": "example.invalid", "X-Forwarded-Host": "example.invalid"})
            self.assertEqual(status, 200)
            self.assertNotIn(b"key", payload)
        headers = {key.lower(): value for key, value in self.seen[0]["headers"].items()}
        self.assertEqual(headers["x-goog-api-key"], "test-upstream-key")
        self.assertNotIn("authorization", headers)
        self.assertNotIn("x-forwarded-host", headers)
        self.assertEqual(headers["host"], f"127.0.0.1:{self.server.server_port}")

    def test_timeout_with_connection_close_body_pending(self):
        self.responses = [{"block": True}]
        with patch.object(gemini_meter, "REQUEST_TIMEOUT", 0.1), self.meter() as meter:
            started = time.monotonic()
            self.assertEqual(self.post(meter)[0], 502)
            self.assertLess(time.monotonic() - started, 1)
            self.assertIsNone(meter.usage())

    def test_exit_closes_pending_response_and_rejects_late_forward(self):
        self.responses = [{"block": True}]
        meter = self.meter().__enter__()
        outcomes = []
        caller = threading.Thread(target=lambda: outcomes.append(self.post(meter)), daemon=True)
        caller.start()
        self.assertTrue(self.started.wait(timeout=1))
        started = time.monotonic()
        meter.__exit__(None, None, None)
        caller.join(timeout=1)
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(caller.is_alive())
        self.assertIsNone(meter.usage())
        with self.assertRaises(ValueError):
            meter.forward(b"{}")
        self.assertEqual(len(self.seen), 1)
        target = urlsplit(meter.base_url)
        with self.assertRaises(OSError):
            socket.create_connection((target.hostname, target.port), timeout=0.1)


if __name__ == "__main__":
    unittest.main()
