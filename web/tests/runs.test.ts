import { TEST_OWNER, TEST_ACCESS_TOKEN, testAuthenticate } from "./helpers/api-auth";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createApi } from "../api/app";
import { invokeBridge, pythonRunService, RunServiceError, type RunService } from "../api/run-service";
import { runsClient, RunApiError } from "../app/lib/runs.server";
import { readConfig } from "../server/config";
import { artifactResultSchema, MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES, runDetailSchema, runInputSchema, type RunDetail, type RunInput } from "../shared/run-contracts";

const runId = "ax-run-0123456789abcdef";
const input: RunInput = { key: "019a1aaa-1234-4567-8765-0123456789ab", mode: "offline", instruction: "本文を保存してください。", input_text: "はじめの一歩", output_name: "answer.txt", allow_model: false };
const config = readConfig({ WEB_PORT: "3410", API_PORT: "3411", INTERNAL_API_TOKEN: "test-api-token-".repeat(4), LOCAL_SESSION_SECRET: "test-session-secret-".repeat(4) });
const detail: RunDetail = {
  summary: { run_id: runId, adapter: "offline", accepted_at: "2026-10-06T01:00:00Z", state: "accepted", phase: "accepted", resolved: false, active: false, can_recover: true, error_type: null },
  request: { schema_version: 1, run_id: runId, adapter: "offline", instruction: input.instruction, inputs: { "input.txt": input.input_text }, output_name: input.output_name },
  result: null,
  cleanup: { egress_denied: false, suspended: false },
  cleanup_errors: [],
};
function fakeService(calls: string[] = []): RunService {
  return {
    async list(owner) { assert.equal(owner, TEST_OWNER); calls.push("list"); return { runs: [detail.summary] }; },
    async get(owner, id) { assert.equal(owner, TEST_OWNER); calls.push(`get:${id}`); return detail; },
    async submit(owner, value) { assert.equal(owner, TEST_OWNER); calls.push(`submit:${value.key}`); return { run_id: runId, replayed: false }; },
    async artifact(owner, id) { assert.equal(owner, TEST_OWNER); calls.push(`artifact:${id}`); return { name: "answer.txt", content: "a".repeat(32768) }; },
    async recover(owner, id) { assert.equal(owner, TEST_OWNER); calls.push(`recover:${id}`); return { run_id: id }; },
  };
}
const isServiceError = (code: string, status = 503) => (error: unknown) => error instanceof RunServiceError && error.code === code && error.status === status;
const isApiError = (code: string, status = 503) => (error: unknown) => error instanceof RunApiError && error.code === code && error.status === status;

test("run schemas retain exact UTF-8 limits, model consent and response identity", () => {
  assert.equal(runInputSchema.safeParse(input).success, true);
  assert.equal(runInputSchema.safeParse({ ...input, mode: "model", allow_model: true }).success, true);
  for (const changes of [
    { mode: "model" }, { allow_model: "true" }, { key: "not-a-uuid" }, { instruction: "   " },
    { instruction: "あ".repeat(683) }, { instruction: "\ud800" }, { input_text: "a\0b" },
    { input_text: "あ".repeat(1366) }, { output_name: "../secret" }, { image: "external-image" },
  ]) assert.equal(runInputSchema.safeParse({ ...input, ...changes }).success, false);
  assert.equal(runInputSchema.safeParse({ ...input, instruction: "a".repeat(2048), input_text: "a".repeat(4096) }).success, true);
  assert.equal(runDetailSchema.safeParse(detail).success, true);
  assert.equal(runDetailSchema.safeParse({ ...detail, request: { ...detail.request, run_id: "ax-run-1111111111111111" } }).success, false);
  assert.equal(artifactResultSchema.safeParse({ name: "answer.txt", content: "a".repeat(65536) }).success, true);
  assert.equal(artifactResultSchema.safeParse({ name: "answer.txt", content: "a".repeat(65537) }).success, false);
});

test("API validates authentication and all run operations before reaching the service", async () => {
  const calls: string[] = [];
  const app = createApi(config, undefined, fakeService(calls), undefined, testAuthenticate);
  const headers = { host: "127.0.0.1:3411", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", "x-ax-access-token": TEST_ACCESS_TOKEN, "x-ax-owner-id": "attacker-selected-owner" };
  const call = (path: string, method = "GET", body?: string, extra = {}) => app.request(`${config.apiOrigin}${path}`, { method, headers: { ...headers, ...extra }, body });
  assert.equal((await call("/v1/runs")).status, 200);
  assert.equal((await call(`/v1/runs/${runId}`)).status, 200);
  assert.equal((await call(`/v1/runs/${runId}/artifact`)).status, 200);
  assert.equal((await call(`/v1/runs/${runId}/recover`)).status, 404);
  assert.deepEqual(calls, ["list", `get:${runId}`, `artifact:${runId}`]);
  assert.equal((await call("/v1/runs", "POST", JSON.stringify(input))).status, 202);
  assert.equal((await call(`/v1/runs/${runId}/recover`, "POST", "{}")).status, 202);
  const accepted = calls.length;
  for (const [extra, expected] of [[{ authorization: "Bearer wrong" }, 401], [{ "x-ax-access-token": "" }, 401], [{ "x-ax-access-token": "invalid" }, 401], [{ origin: config.webOrigin }, 403], [{ host: "attacker.example" }, 403]] as const) {
    assert.equal((await call("/v1/runs", "POST", JSON.stringify(input), extra)).status, expected);
  }
  for (const changes of [{ mode: "model" }, { output_name: "../../secret" }, { instruction: "a".repeat(2049) }, { command: "rm" }, { owner_user_id: "attacker-selected-owner" }]) {
    assert.equal((await call("/v1/runs", "POST", JSON.stringify({ ...input, ...changes }))).status, 400);
  }
  assert.equal((await call("/v1/runs", "POST", "{")).status, 400);
  assert.equal((await call("/v1/runs", "POST", JSON.stringify(input), { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("/v1/runs", "POST", "x".repeat(MAX_RUN_REQUEST_BYTES + 1))).status, 413);
  assert.equal((await call("/v1/runs/not-a-run")).status, 400);
  assert.equal((await call(`/v1/runs/${runId}/recover`, "POST", '{"restart":true}')).status, 400);
  assert.equal(calls.length, accepted);
});

test("API rejects malformed service responses and never publishes unexpected errors", async () => {
  const service = fakeService();
  service.list = async () => ({ runs: [{ ...detail.summary, private_key: "do-not-publish" }] });
  service.submit = async () => { throw new RunServiceError("idempotency_conflict", 409); };
  service.get = async () => { throw new Error("SECRET from stderr"); };
  const app = createApi(config, undefined, service, undefined, testAuthenticate);
  const headers = { host: "127.0.0.1:3411", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", "x-ax-access-token": TEST_ACCESS_TOKEN };
  const invalid = await app.request(`${config.apiOrigin}/v1/runs`, { headers });
  assert.equal(invalid.status, 503);
  assert.deepEqual(await invalid.json(), { error: "invalid_bridge_response" });
  const conflict = await app.request(`${config.apiOrigin}/v1/runs`, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
  const failure = await app.request(`${config.apiOrigin}/v1/runs/${runId}`, { headers });
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "bridge_unavailable" });
});

test("Python service validates envelopes and does not dispatch retries", async () => {
  const calls: unknown[] = [];
  const service = pythonRunService(async (operation, value) => {
    calls.push({ operation, value });
    return { ok: true, data: { run_id: runId, replayed: true } };
  });
  assert.deepEqual(await service.submit(TEST_OWNER, input), { run_id: runId, replayed: true });
  assert.deepEqual(calls, [{ operation: "submit", value: { owner_user_id: TEST_OWNER, input } }]);
  await assert.rejects(pythonRunService(async () => ({ ok: false, error: { code: "unresolved_run", status: 409 } })).list(TEST_OWNER), isServiceError("unresolved_run", 409));
  for (const value of [{ ok: true, data: {} }, { ok: false, error: { code: "secret token", status: 503 } }, { ok: true, data: { runs: [] }, extra: "secret" }]) {
    await assert.rejects(pythonRunService(async () => value).list(TEST_OWNER), isServiceError("invalid_bridge_response"));
  }
});

test("bridge subprocess uses fixed arguments, bounded output and a deadline without leaking stderr", async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const launchWith = (source: string) => (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    assert.equal(command, "python3");
    assert.ok(args[0].endsWith("/ax-local/web_bridge.py"));
    assert.equal(args[1], "list");
    assert.equal(options?.shell, undefined);
    const child = spawn(process.execPath, ["-e", source], options);
    children.push(child);
    return child;
  };
  const result = await invokeBridge("list", {}, launchWith('let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({ok:true,data:{runs:[],input:JSON.parse(text)}}));});'));
  assert.deepEqual(result, { ok: true, data: { runs: [], input: {} } });
  assert.deepEqual(await invokeBridge("list", {}, launchWith('process.stdin.resume();process.stdout.write(JSON.stringify({ok:false,error:{code:"unresolved_run",status:409}}));process.exitCode=1;')), { ok: false, error: { code: "unresolved_run", status: 409 } });
  await assert.rejects(invokeBridge("list", {}, launchWith('process.stderr.write("PRIVATE CREDENTIAL");process.stdout.write("invalid");')), isServiceError("invalid_bridge_response"));
  await assert.rejects(invokeBridge("list", {}, launchWith(`process.stdout.write("x".repeat(${MAX_RUN_RESPONSE_BYTES + 1}));`)), isServiceError("invalid_bridge_response"));
  const started = Date.now();
  await assert.rejects(invokeBridge("list", {}, launchWith('setInterval(()=>{},1000);'), 100), isServiceError("bridge_timeout"));
  assert.ok(Date.now() - started < 1500);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, "close");
});

test("BFF client traverses real HTTP and preserves typed operations, status and artifacts above 16 KiB", async (t) => {
  const calls: string[] = [];
  const service = fakeService(calls);
  const server = serve({ fetch: (request) => createApi({ ...config, apiOrigin: new URL(request.url).origin }, undefined, service, undefined, testAuthenticate).fetch(request), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  t.after(() => { if ("closeAllConnections" in server) server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = runsClient(TEST_ACCESS_TOKEN, { ...config, apiOrigin: `http://127.0.0.1:${address.port}` });
  assert.deepEqual(await client.list(), { runs: [detail.summary] });
  assert.deepEqual(await client.get(runId), detail);
  assert.deepEqual(await client.submit(input), { run_id: runId, replayed: false });
  assert.equal((await client.artifact(runId)).content.length, 32768);
  assert.deepEqual(await client.recover(runId), { run_id: runId });
  assert.deepEqual(calls, ["list", `get:${runId}`, `submit:${input.key}`, `artifact:${runId}`, `recover:${runId}`]);
  await assert.rejects(runsClient("invalid-token", { ...config, apiOrigin: `http://127.0.0.1:${address.port}` }).list(), isApiError("unauthorized", 401));
  assert.equal(calls.length, 5);
  service.submit = async () => { calls.push("conflict"); throw new RunServiceError("idempotency_conflict", 409); };
  await assert.rejects(client.submit(input), isApiError("idempotency_conflict", 409));
  assert.equal(calls.filter((value) => value === "conflict").length, 1);
});

test("BFF rejects invalid bodies, redirects and body stalls without retries", async (t) => {
  let mode = "shape";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("Content-Type", "application/json");
    if (mode === "shape") response.end('{"runs":[],"extra":"secret"}');
    else if (mode === "redirect") { response.writeHead(302, { location: "/v1/runs" }); response.end(); }
    else if (mode === "oversize") response.end("x".repeat(MAX_RUN_RESPONSE_BYTES + 1));
    else { response.writeHead(200); response.flushHeaders(); response.write("{"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = runsClient(TEST_ACCESS_TOKEN, { ...config, apiOrigin: `http://127.0.0.1:${address.port}` }, 100);
  for (const next of ["shape", "redirect", "oversize", "stalled-body"]) {
    mode = next;
    const before = requests;
    await assert.rejects(client.list(), (error: unknown) => error instanceof RunApiError && error.status === 503);
    assert.equal(requests, before + 1);
  }
});
