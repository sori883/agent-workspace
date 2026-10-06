import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, fingerprint, historyJson, payloadHash, submissionKey } from "../data/canonical";

test("Python canonical golden vectors preserve separators, integer-looking keys and Unicode", async () => {
  const image = `localhost:5001/runner@sha256:${"a".repeat(64)}`;
  const request = { schema_version: 1, run_id: "ax-run-0123456789abcdef", adapter: "antigravity", instruction: "行\n青空😀", inputs: { "2": "two", "10": "ten", b: "\x01" }, output_name: "reply.txt" };
  assert.equal(await fingerprint(request, image), "f9f8a899e37db0038f675af226f596cab8345ceb527dd8a02ea8f1ebd8fc4e68");
  assert.equal(await submissionKey("019a1aaa-1234-4567-8765-0123456789ab", "019a1aaa-1234-4567-8765-0123456789ac"), "86f434948905c74fb64495b074ea633be2f8a59e6eba1ba43b2f1cbd12d56f18");
  const payload = { mode: "offline", instruction: "行\n青空😀", input_text: "\x01", output_name: "x.txt", allow_model: false };
  assert.equal(await payloadHash(payload), "6dbd1d8b26d5f7c937ccca4a2afa0506ab0c7d296db9e05d5c8df319e7dc53c4");
  assert.equal(await payloadHash(payload, true), "8c065c968d8c1106594827713ccdad4ee2a4d01dc583049fb8f75f9fa7b2ee7f");
  assert.equal(canonical({ "2": true, "10": false }), '{"10": false, "2": true}');
  assert.equal(canonical({ "😀": 1, "\ue000": 2 }), '{"": 2, "😀": 1}');
  assert.equal(historyJson([{ role: "assistant", content: "\0\b\f\n\r\t\x01青😀" }]), '[{"role":"assistant","content":"\\u0000\\b\\f\\n\\r\\t\\u0001青😀"}]');
});
