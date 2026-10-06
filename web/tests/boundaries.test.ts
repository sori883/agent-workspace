import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createCookieSessionStorage } from "react-router";
import { createApi } from "../api/app";
import { readConfig } from "../server/config";
import { apiClient, ApiUnavailable } from "../app/lib/api.server";
import { loadSession, verifySubmission } from "../app/lib/security.server";
import { readLimitedText } from "../shared/http";

process.env.INTERNAL_API_TOKEN = "test-api-".repeat(8);
process.env.LOCAL_SESSION_SECRET = "test-session-".repeat(8);
process.env.WEB_PORT = "3310";
process.env.API_PORT = "3311";
const config = readConfig();

test("local configuration rejects invalid ports and missing credentials", () => {
  for (const value of ["0", "-1", "1023", "65536", "3100x", ""]) {
    assert.throws(() => readConfig({ ...process.env, WEB_PORT: value }));
  }
  assert.throws(() => readConfig({ ...process.env, API_PORT: "3310" }));
  assert.throws(() => readConfig({ ...process.env, INTERNAL_API_TOKEN: "" }));
});

test("API authenticates before processing and only POST accepts messages", async () => {
  const accepted: string[] = [];
  const app = createApi(config, (id) => accepted.push(id));
  const headers = { host: "127.0.0.1:3311", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" };
  const call = (path: string, method = "GET", body?: string, extra = {}) => app.request(`${config.apiOrigin}${path}`, { method, headers: { ...headers, ...extra }, body });
  assert.equal((await call("/v1/status")).status, 200);
  assert.equal((await call("/v1/connection-check")).status, 404);
  assert.deepEqual(accepted, []);
  const response = await call("/v1/connection-check", "POST", JSON.stringify({ message: "  はじめの一歩  " }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.receivedText, "はじめの一歩");
  assert.equal(result.mode, "mock");
  assert.deepEqual(accepted, [result.requestId]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const extra of [{ authorization: "" }, { authorization: "Bearer wrong" }]) {
    assert.equal((await call("/v1/connection-check", "POST", '{"message":"x"}', extra)).status, 401);
  }
  for (const extra of [{ host: "attacker.example:3311" }, { origin: config.webOrigin }, { origin: "null" }]) {
    assert.equal((await call("/v1/connection-check", "POST", '{"message":"x"}', extra)).status, 403);
  }
  for (const body of ['{', '{"message":""}', '{"message":"   "}', '{"message":"x","extra":1}', JSON.stringify({ message: "x".repeat(201) })]) {
    assert.equal((await call("/v1/connection-check", "POST", body)).status, 400);
  }
  assert.equal((await call("/v1/connection-check", "POST", "x", { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/v1/connection-check", "POST", "x".repeat(16385))).status, 413);
  assert.equal(accepted.length, 1);
});

test("session, CSRF, Origin and Host must agree, including expiry and restart", async () => {
  const request = (extra: HeadersInit = {}, method = "POST") => new Request(config.webOrigin, { method, headers: { host: "127.0.0.1:3310", origin: config.webOrigin, ...extra } });
  const initial = await loadSession(request({}, "GET"));
  assert.ok(initial.cookie?.includes("HttpOnly"));
  assert.ok(initial.cookie?.includes("SameSite=Strict"));
  const cookie = initial.cookie!.split(";")[0];
  await verifySubmission(request({ cookie }), initial.csrf);
  assert.equal((await loadSession(request({ cookie }, "GET"))).cookie, null);
  const forbidden = (error: unknown) => error instanceof Response && error.status === 403;
  await assert.rejects(verifySubmission(request(), initial.csrf), forbidden);
  await assert.rejects(verifySubmission(request({ cookie }), "wrong"), forbidden);
  await assert.rejects(verifySubmission(request({ cookie, origin: "null" }), initial.csrf), forbidden);
  await assert.rejects(verifySubmission(request({ cookie, origin: "" }), initial.csrf), forbidden);
  await assert.rejects(verifySubmission(request({ cookie, host: "attacker.example" }), initial.csrf), forbidden);
  await assert.rejects(verifySubmission(request({ cookie }, "GET"), initial.csrf), forbidden);
  const storage = createCookieSessionStorage({ cookie: { name: "ax_local_session_3310", secrets: [config.sessionSecret] } });
  const expired = await storage.getSession();
  expired.set("csrf", initial.csrf);
  expired.set("expiresAt", Date.now() - 1000);
  await assert.rejects(verifySubmission(request({ cookie: (await storage.commitSession(expired)).split(";")[0] }), initial.csrf), forbidden);
  process.env.LOCAL_SESSION_SECRET = "replacement-secret-".repeat(8);
  await assert.rejects(verifySubmission(request({ cookie }), initial.csrf), forbidden);
  process.env.LOCAL_SESSION_SECRET = config.sessionSecret;
});

test("body limits apply without Content-Length and invalid UTF-8 is rejected", async () => {
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10000)); controller.enqueue(new Uint8Array(10000)); controller.close(); } }));
  await assert.rejects(readLimitedText(streamed), (error: unknown) => error instanceof Response && error.status === 413);
  await assert.rejects(readLimitedText(new Response(new Uint8Array([0xff]))), (error: unknown) => error instanceof Response && error.status === 400);
});

test("HTTP client checks responses, never retries, and times out while reading the body", async (t) => {
  let mode = "success";
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Bearer ${config.apiToken}`);
    assert.equal(request.headers.origin, undefined);
    response.setHeader("Content-Type", "application/json");
    if (mode === "success") response.end(JSON.stringify({ service: "ax-common-api", mode: "mock" }));
    else if (mode === "shape") response.end('{}');
    else if (mode === "oversize") response.end('x'.repeat(16385));
    else if (mode === "redirect") { response.writeHead(302, { location: "/v1/status" }); response.end(); }
    else if (mode === "status") { response.writeHead(500); response.end('{}'); }
    else { response.writeHead(200); response.flushHeaders(); response.write('{'); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = apiClient({ ...config, apiOrigin: `http://127.0.0.1:${address.port}` }, 150);
  assert.equal((await client.status()).mode, "mock");
  for (const next of ["shape", "oversize", "redirect", "status", "stalled-body"]) {
    mode = next;
    const before = requests;
    const started = Date.now();
    await assert.rejects(client.status(), ApiUnavailable);
    assert.equal(requests, before + 1);
    assert.ok(Date.now() - started < 1500);
  }
});
