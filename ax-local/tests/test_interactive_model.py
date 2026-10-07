import math
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_runtime.adapters.interactive import MODEL_PROFILE, ModelProxy, billing_cost
from task_runtime.protocol import ProtocolError
from test_interactive import FakeMailbox, model_response
import test_interactive as fixtures


class ModelBillingTests(unittest.TestCase):
    def test_profile_price_and_preview_compatibility(self):
        usage = {"prompt_token_count": 101, "candidates_token_count": 20, "thoughts_token_count": 3}
        cost = (101 * .25 + 23 * 1.5) / 1000000
        self.assertEqual(billing_cost({"profile_id": MODEL_PROFILE, "estimated_usd": cost}, usage), cost)
        self.assertEqual(billing_cost(None, usage), 0)
        self.assertEqual(billing_cost({"profile_id": "preview-v1", "estimated_usd": 0}, usage), 0)
        for billing in ({"profile_id": MODEL_PROFILE, "estimated_usd": 0},
                        {"profile_id": MODEL_PROFILE, "estimated_usd": True},
                        {"profile_id": MODEL_PROFILE, "estimated_usd": math.nan},
                        {"profile_id": "other", "estimated_usd": cost}):
            with self.assertRaises(ProtocolError):
                billing_cost(billing, usage)

    def test_proxy_verifies_trusted_billing_before_accepting_usage(self):
        class BillingMailbox(FakeMailbox):
            def wait_reply(self, *args):
                result = super().wait_reply(*args)
                result["billing"] = {"profile_id": MODEL_PROFILE, "estimated_usd": .000055}
                return result
        with ModelProxy(BillingMailbox(model_response()), time.monotonic() + 2) as proxy:
            proxy.forward({"contents": [{}]})
            self.assertAlmostEqual(proxy.cost(), .000055)
            self.assertEqual(proxy.usage()["total_token_count"], 120)


@unittest.skipUnless(fixtures.sdk_available(), "fixed SDK image required")
class ModelSdkTests(unittest.TestCase):
    setUp = fixtures.InteractiveSdkTests.setUp
    run_case = fixtures.InteractiveSdkTests.run_case

    def test_sdk_normal_completion_preserves_gateway_cost(self):
        root, result, requests = self.run_case("model-billing", "answer", {"kind": "output", "text": "検証用の短い成果物"})
        self.assertEqual(result["status"], "succeeded", result)
        self.assertEqual(result["stop_reason"], "UNSPECIFIED")
        self.assertAlmostEqual(result["estimated_usd"], .000055)
        self.assertEqual(result["usage"]["model_call_count"], 1)
        self.assertEqual([operation["kind"] for operation in requests], ["model", "tool"])
        self.assertEqual((root / "output/reply.txt").read_text(), "検証用の短い成果物")


if __name__ == "__main__":
    unittest.main()
