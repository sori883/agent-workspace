import { TEST_OWNER, TEST_ACCESS_TOKEN, testAuthenticate } from "./helpers/api-auth";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createApi } from "../api/app";
import { pythonChatService, type ChatService } from "../api/chat-service";
import { invokeBridge, RunServiceError } from "../api/run-service";
import { chatsClient, RunApiError } from "../app/lib/chats.server";
import { readConfig } from "../server/config";
import { chatInputSchema, conversationDetailSchema, conversationListSchema, MAX_CHAT_RESPONSE_BYTES, type ChatInput, type ConversationDetail } from "../shared/chat-contracts";
import { MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES } from "../shared/run-contracts";

const id = "019a1aaa-1234-4567-8765-0123456789ab";
const otherId = "019a1aaa-1234-4567-8765-0123456789ac";
const runId = "ax-run-0123456789abcdef";
const input: ChatInput = { key: "019a1aaa-1234-4567-8765-0123456789ad", parent_run_id: null, text: "合言葉は青空です。", allow_model: true };
const config = readConfig({ WEB_PORT: "3410", API_PORT: "3411", INTERNAL_API_TOKEN: "test-api-token-".repeat(4), LOCAL_SESSION_SECRET: "test-session-secret-".repeat(4) });
const detail: ConversationDetail = {
  conversation: { id, title: input.text, updated_at: "2026-10-06T01:00:00Z", head_run_id: runId, turn_count: 1, state: "succeeded" },
  turns: [{ summary: { run_id: runId, adapter: "antigravity", accepted_at: "2026-10-06T01:00:00Z", state: "succeeded", phase: "finished", resolved: true, active: false, can_recover: false, error_type: null }, user: input.text, assistant: "覚えました。" }],
  can_send: true, context_full: false,
};
const accepted = { conversation_id: id, run_id: runId, replayed: true };
const isServiceError = (code: string, status = 503) => (error: unknown) => error instanceof RunServiceError && error.code === code && error.status === status;
const isApiError = (code: string, status = 503) => (error: unknown) => error instanceof RunApiError && error.code === code && error.status === status;
function fakeService(calls: unknown[] = []): ChatService {
  return {
    async list(owner) { assert.equal(owner, TEST_OWNER); calls.push("list"); return { conversations: [detail.conversation] }; },
    async get(owner, value) { assert.equal(owner, TEST_OWNER); calls.push(["get", value]); return detail; },
    async submit(owner, value, body) { assert.equal(owner, TEST_OWNER); calls.push(["submit", value, body]); return accepted; },
  };
}
function maximumDetail(): ConversationDetail {
  const turns = Array.from({ length: 32 }, (_, index) => ({
    summary: { ...detail.turns[0].summary, run_id: `ax-run-${index.toString(16).padStart(16, "0")}`, state: index === 31 ? "succeeded" as const : "failed" as const },
    user: "\x01".repeat(2048), assistant: index === 31 ? "\0".repeat(65536) : null,
  }));
  return { conversation: { ...detail.conversation, title: "\x01".repeat(60), head_run_id: turns[31].summary.run_id, turn_count: 32 }, turns, can_send: false, context_full: true };
}

test("chat schemas normalize UUIDs and reject unsafe input and inconsistent conversation states", () => {
  assert.equal(chatInputSchema.parse({ ...input, key: input.key.toUpperCase() }).key, input.key);
  assert.equal(chatInputSchema.safeParse({ ...input, text: "a".repeat(2048) }).success, true);
  for (const change of [{ key: "bad" }, { parent_run_id: "../run" }, { text: "\ud800" }, { text: "\0" }, { text: " " }, { text: "あ".repeat(683) }, { allow_model: false }, { instructions: "extra" }]) {
    assert.equal(chatInputSchema.safeParse({ ...input, ...change }).success, false);
  }
  assert.equal(conversationDetailSchema.safeParse(detail).success, true);
  for (const mutate of [
    (value: ConversationDetail) => { value.turns = []; },
    (value: ConversationDetail) => { value.conversation.head_run_id = "ax-run-1111111111111111"; },
    (value: ConversationDetail) => { value.conversation.turn_count = 2; },
    (value: ConversationDetail) => { value.conversation.state = "running"; },
    (value: ConversationDetail) => { value.turns[0].summary.active = true; },
    (value: ConversationDetail) => { value.turns[0].summary.adapter = "offline"; },
    (value: ConversationDetail) => { value.turns[0].assistant = null; },
    (value: ConversationDetail) => { value.turns[0].assistant = "a".repeat(65537); },
    (value: ConversationDetail) => { value.context_full = true; },
    (value: ConversationDetail) => { value.turns.push(value.turns[0]); value.conversation.turn_count = 2; },
  ]) { const value = structuredClone(detail); mutate(value); assert.equal(conversationDetailSchema.safeParse(value).success, false); }
  const pending = structuredClone(detail);
  pending.conversation.state = "accepted";
  pending.turns[0].summary = { ...pending.turns[0].summary, state: "accepted", phase: "accepted", resolved: false, can_recover: true };
  pending.turns[0].assistant = null;
  pending.can_send = false;
  assert.equal(conversationDetailSchema.safeParse(pending).success, true);
  assert.equal(conversationDetailSchema.safeParse({ ...pending, can_send: true }).success, false);
  assert.equal(conversationListSchema.safeParse({ conversations: [detail.conversation, detail.conversation] }).success, false);
});

test("chat HTTP authentication, methods and input validation precede any service operation", async () => {
  const calls: unknown[] = [];
  const app = createApi(config, undefined, undefined, fakeService(calls), testAuthenticate);
  const headers = { host: "127.0.0.1:3411", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", "x-ax-access-token": TEST_ACCESS_TOKEN, "x-ax-owner-id": "attacker-selected-owner" };
  const call = (path: string, method = "GET", body?: string, extra = {}) => app.request(`${config.apiOrigin}${path}`, { method, headers: { ...headers, ...extra }, body });
  assert.equal((await call("/v1/conversations")).status, 200);
  assert.equal((await call(`/v1/conversations/${id.toUpperCase()}`)).status, 200);
  assert.equal((await call(`/v1/conversations/${id}/turns`)).status, 404);
  assert.deepEqual(calls, ["list", ["get", id]]);
  assert.equal((await call(`/v1/conversations/${id.toUpperCase()}/turns`, "POST", JSON.stringify({ ...input, key: input.key.toUpperCase() }))).status, 202);
  assert.deepEqual(calls.at(-1), ["submit", id, input]);
  const count = calls.length;
  for (const [extra, expected] of [[{ authorization: "Bearer invalid" }, 401], [{ "x-ax-access-token": "" }, 401], [{ "x-ax-access-token": "invalid" }, 401], [{ origin: config.webOrigin }, 403], [{ host: "hostile.test" }, 403]] as const) {
    assert.equal((await call(`/v1/conversations/${id}/turns`, "POST", JSON.stringify(input), extra)).status, expected);
  }
  for (const change of [{ allow_model: false }, { text: "a".repeat(2049) }, { role: "system" }, { parent_run_id: "bad" }, { owner_user_id: "attacker-selected-owner" }]) assert.equal((await call(`/v1/conversations/${id}/turns`, "POST", JSON.stringify({ ...input, ...change }))).status, 400);
  assert.equal((await call("/v1/conversations/invalid")).status, 400);
  assert.equal((await call(`/v1/conversations/${id}/turns`, "POST", "{")).status, 400);
  assert.equal((await call(`/v1/conversations/${id}/turns`, "POST", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await call(`/v1/conversations/${id}/turns`, "POST", "x".repeat(MAX_RUN_REQUEST_BYTES + 1))).status, 413);
  assert.equal(calls.length, count);
});

test("chat API validates response identity, safe errors and strict response fields", async () => {
  const service = fakeService();
  const app = createApi(config, undefined, undefined, service, testAuthenticate);
  const headers = { host: "127.0.0.1:3411", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json", "x-ax-access-token": TEST_ACCESS_TOKEN };
  service.get = async () => ({ ...detail, conversation: { ...detail.conversation, id: otherId } });
  assert.deepEqual(await (await app.request(`${config.apiOrigin}/v1/conversations/${id}`, { headers })).json(), { error: "invalid_bridge_response" });
  service.get = async () => ({ ...detail, secret: "PRIVATE" });
  assert.deepEqual(await (await app.request(`${config.apiOrigin}/v1/conversations/${id}`, { headers })).json(), { error: "invalid_bridge_response" });
  service.get = async () => { throw new Error("PRIVATE stderr path"); };
  assert.deepEqual(await (await app.request(`${config.apiOrigin}/v1/conversations/${id}`, { headers })).json(), { error: "bridge_unavailable" });
  service.submit = async () => { throw new RunServiceError("conversation_context_full", 422); };
  const full = await app.request(`${config.apiOrigin}/v1/conversations/${id}/turns`, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(full.status, 422);
  assert.deepEqual(await full.json(), { error: "conversation_context_full" });
});

test("Python chat bridge sends fixed commands once and validates envelopes and identities", async () => {
  const calls: unknown[] = [];
  const service = pythonChatService(async (operation, value) => {
    calls.push([operation, value]);
    return { ok: true, data: operation === "conversations" ? { conversations: [detail.conversation] } : operation === "conversation" ? detail : accepted };
  });
  assert.deepEqual(await service.list(TEST_OWNER), { conversations: [detail.conversation] });
  assert.deepEqual(await service.get(TEST_OWNER, id.toUpperCase()), detail);
  assert.deepEqual(await service.submit(TEST_OWNER, id.toUpperCase(), { ...input, key: input.key.toUpperCase() }), accepted);
  assert.deepEqual(calls, [["conversations", { owner_user_id: TEST_OWNER, input: {} }], ["conversation", { owner_user_id: TEST_OWNER, input: { id } }], ["chat", { owner_user_id: TEST_OWNER, input: { id, ...input } }]]);
  for (const value of [{ ok: true, data: {} }, { ok: true, data: { ...accepted, conversation_id: otherId } }, { ok: false, error: { code: "SECRET key", status: 409 } }, { ok: true, data: accepted, extra: "PRIVATE" }]) await assert.rejects(pythonChatService(async () => value).submit(TEST_OWNER, id, input), isServiceError("invalid_bridge_response"));
  await assert.rejects(pythonChatService(async () => ({ ok: false, error: { code: "conversation_conflict", status: 409 } })).submit(TEST_OWNER, id, input), isServiceError("conversation_conflict", 409));
  await assert.rejects(service.get(TEST_OWNER, "bad"), isServiceError("invalid_conversation_id", 400));
  assert.equal(calls.length, 3);
});

test("chat response transport permits 1 MiB while legacy operations retain 512 KiB", async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (source: string) => (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    assert.equal(command, "python3");
    assert.ok(args[0].endsWith("/ax-local/web_bridge.py"));
    assert.equal(options?.shell, undefined);
    const child = spawn(process.execPath, ["-e", source], options);
    children.push(child);
    return child;
  };
  const source = `process.stdin.resume();process.stdout.write(JSON.stringify({content:"x".repeat(${MAX_RUN_RESPONSE_BYTES})}));`;
  const result = await invokeBridge("conversation", { id }, launch(source));
  assert.equal((result as { content: string }).content.length, MAX_RUN_RESPONSE_BYTES);
  await assert.rejects(invokeBridge("get", { run_id: runId }, launch(source)), isServiceError("invalid_bridge_response"));
  await assert.rejects(invokeBridge("conversation", { id }, launch(`process.stdout.write("x".repeat(${MAX_CHAT_RESPONSE_BYTES + 1}));`)), isServiceError("invalid_bridge_response"));
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await once(child, "close");
});

test("BFF chat client traverses real HTTP, including maximum escaped history above 512 KiB", async (t) => {
  const calls: unknown[] = [];
  const service = fakeService(calls);
  const server = serve({ fetch: (request) => createApi({ ...config, apiOrigin: new URL(request.url).origin }, undefined, undefined, service, testAuthenticate).fetch(request), hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  t.after(() => { if ("closeAllConnections" in server) server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = chatsClient(TEST_ACCESS_TOKEN, { ...config, apiOrigin: `http://127.0.0.1:${address.port}` });
  assert.deepEqual(await client.list(), { conversations: [detail.conversation] });
  assert.deepEqual(await client.get(id.toUpperCase()), detail);
  assert.deepEqual(await client.submit(id, input), accepted);
  assert.deepEqual(calls, ["list", ["get", id], ["submit", id, input]]);
  await assert.rejects(chatsClient("invalid-token", { ...config, apiOrigin: `http://127.0.0.1:${address.port}` }).list(), isApiError("unauthorized", 401));
  assert.equal(calls.length, 3);
  const maximum = maximumDetail();
  const size = Buffer.byteLength(JSON.stringify(maximum));
  assert.ok(size > MAX_RUN_RESPONSE_BYTES && size < MAX_CHAT_RESPONSE_BYTES);
  assert.equal(conversationDetailSchema.safeParse(maximum).success, true);
  service.get = async () => maximum;
  assert.deepEqual(await client.get(id), maximum);
  service.submit = async () => { calls.push("conflict"); throw new RunServiceError("conversation_conflict", 409); };
  await assert.rejects(client.submit(id, input), isApiError("conversation_conflict", 409));
  assert.equal(calls.filter((value) => value === "conflict").length, 1);
});

test("BFF chat client rejects malformed responses, redirects and body timeout without retry", async (t) => {
  let mode = "identity";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("Content-Type", "application/json");
    if (mode === "identity") response.end(JSON.stringify({ ...detail, conversation: { ...detail.conversation, id: otherId } }));
    else if (mode === "shape") response.end(JSON.stringify({ ...detail, extra: "PRIVATE" }));
    else if (mode === "redirect") { response.writeHead(302, { location: "/v1/conversations" }); response.end(); }
    else if (mode === "oversize") response.end("x".repeat(MAX_CHAT_RESPONSE_BYTES + 1));
    else { response.writeHead(200); response.flushHeaders(); response.write("{"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = chatsClient(TEST_ACCESS_TOKEN, { ...config, apiOrigin: `http://127.0.0.1:${address.port}` }, 100);
  for (const next of ["identity", "shape", "redirect", "oversize", "stalled-body"]) {
    mode = next;
    const before = requests;
    await assert.rejects(client.get(id), (error: unknown) => error instanceof RunApiError && error.status === 503);
    assert.equal(requests, before + 1);
  }
});
