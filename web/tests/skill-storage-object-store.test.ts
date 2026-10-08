import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3SkillObjectStore, type SkillObjectStoreConfig } from "../api/skill-object-store";
import { RunServiceError } from "../api/run-service";
import { sha256, utf8 } from "../data/canonical";
import { skillRevisionPrefix } from "../shared/skill-storage-contracts";

const config: SkillObjectStoreConfig = { endpoint: "https://objects.example.test", bucket: "app-skills", region: "us-east-1", forcePathStyle: true, storeId: "test-skills", accessKeyId: "test-access", secretAccessKey: "test-secret" };
const path = skillRevisionPrefix(randomUUID(), randomUUID(), randomUUID()) + "SKILL.md";
const denied = (code: string) => (error: unknown) => error instanceof RunServiceError && error.code === code;

test("S3 adapter signs conditional immutable PUT and verifies actual stored bytes", async () => {
  const objects = new Map<string, Uint8Array>(); const requests: Request[] = [];
  const fetcher: typeof fetch = async input => {
    const request = input as Request; requests.push(request);
    assert.equal(new URL(request.url).origin, config.endpoint);
    assert.equal(request.redirect, "manual");
    assert.match(request.headers.get("authorization")!, /^AWS4-HMAC-SHA256 Credential=test-access\/.*\/us-east-1\/s3\/aws4_request/);
    if (request.method === "PUT") {
      assert.equal(request.headers.get("if-none-match"), "*");
      assert.match(request.headers.get("authorization")!, /if-none-match/);
      if (objects.has(request.url)) return new Response(null, { status: 412 });
      const bytes = new Uint8Array(await request.arrayBuffer());
      assert.equal(request.headers.get("x-amz-content-sha256"), await sha256(bytes));
      objects.set(request.url, bytes); return new Response(null, { status: 200 });
    }
    const bytes = objects.get(request.url); return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  };
  const store = new S3SkillObjectStore(config, fetcher);
  const bytes = utf8("original 日本語\n");
  await store.putImmutable(path, bytes, "text/plain; charset=utf-8");
  await store.putImmutable(path, bytes, "text/plain; charset=utf-8");
  assert.equal(requests.length, 4);
  await assert.rejects(store.putImmutable(path, utf8("changed content\n"), "text/plain; charset=utf-8"), denied("skill_storage_integrity"));
  assert.deepEqual(await store.get(path, bytes.length), bytes);
});

test("S3 adapter rejects missing, oversized, truncated or invalid-key reads without unbounded buffering", async () => {
  const missing = new S3SkillObjectStore(config, async () => new Response(null, { status: 404 }));
  await assert.rejects(missing.get(path, 1), denied("skill_storage_integrity"));
  let cancelled = false;
  const oversized = new S3SkillObjectStore(config, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(utf8("too long")); }, cancel() { cancelled = true; } })));
  await assert.rejects(oversized.get(path, 2), denied("skill_storage_integrity")); assert.equal(cancelled, true);
  const truncated = new S3SkillObjectStore(config, async () => new Response(utf8("x")));
  await assert.rejects(truncated.get(path, 2), denied("skill_storage_integrity"));
  const badKey = new S3SkillObjectStore(config, async () => { throw new Error("must not fetch"); });
  await assert.rejects(badKey.get(path + "/../../other", 1), denied("skill_storage_unavailable"));
});

test("S3 failures do not retry and credentials are never sent to redirects", async () => {
  let calls = 0;
  const broken = new S3SkillObjectStore(config, async () => { calls++; throw new Error("connection lost"); });
  await assert.rejects(broken.putImmutable(path, utf8("x"), "text/plain"), denied("skill_storage_unavailable")); assert.equal(calls, 1);
  const redirect = new S3SkillObjectStore(config, async request => { assert.equal((request as Request).redirect, "manual"); return new Response(null, { status: 307, headers: { Location: "https://other.example.test/" } }); });
  await assert.rejects(redirect.get(path, 1), denied("skill_storage_unavailable"));
});

test("HTTPS is the default and local HTTP needs an explicit opt-in; virtual-host bucket URLs are supported", async () => {
  assert.throws(() => new S3SkillObjectStore({ ...config, endpoint: "http://localhost:19000" }));
  assert.throws(() => new S3SkillObjectStore({ ...config, endpoint: "http://objects.example.test", allowInsecureHttp: true }));
  assert.doesNotThrow(() => new S3SkillObjectStore({ ...config, endpoint: "http://localhost:19000", allowInsecureHttp: true }));
  const store = new S3SkillObjectStore({ ...config, forcePathStyle: false }, async request => {
    assert.equal(new URL((request as Request).url).hostname, "app-skills.objects.example.test"); return new Response(utf8("x"));
  });
  assert.deepEqual(await store.get(path, 1), utf8("x"));
});
