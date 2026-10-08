import assert from "node:assert/strict";
import { test } from "node:test";
import { skillStorageSettingsSchema } from "../api/settings";

const settings = { endpoint: "https://storage.example.test", bucket: "app-skills", region: "us-east-1", forcePathStyle: true,
  accessKeyId: "access", secretAccessKey: "secret", storeId: "primary-skills" };
test("skill storage requires TLS except for an explicit local endpoint", () => {
  assert.equal(skillStorageSettingsSchema.parse(settings).allowInsecureHttp, false);
  for (const endpoint of ["http://storage.example.test", "https://storage.example.test/path", "https://user:password@storage.example.test", "https://storage.example.test?x=1"]) {
    assert.equal(skillStorageSettingsSchema.safeParse({ ...settings, endpoint, allowInsecureHttp: true }).success, false);
  }
  assert.equal(skillStorageSettingsSchema.safeParse({ ...settings, endpoint: "http://127.0.0.1:19000" }).success, false);
  assert.equal(skillStorageSettingsSchema.safeParse({ ...settings, endpoint: "http://127.0.0.1:19000", allowInsecureHttp: true }).success, true);
});
