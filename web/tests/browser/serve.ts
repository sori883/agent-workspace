import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { createApi } from "../../api/app";
import { createPool } from "../../server/auth-store";
import { migrateAuth } from "../../server/auth-migrate";
import { prepareTestAuth } from "../prepare-auth";
import { startOidcFixture } from "../helpers/oidc-fixture";
import { RunServiceError, type RunService } from "../../api/run-service";
import { readConfig } from "../../server/config";
import type { ChatService } from "../../api/chat-service";
import type { ChatInput, ConversationDetail } from "../../shared/chat-contracts";
import type { RunDetail, RunInput } from "../../shared/run-contracts";

process.env.INTERNAL_API_TOKEN = randomBytes(32).toString("base64url");
process.env.LOCAL_SESSION_SECRET = randomBytes(32).toString("base64url");
const config = readConfig();
const auth = prepareTestAuth();
const fixture = await startOidcFixture(auth.clientSecret, Number(new URL(auth.issuer).port));
if (fixture.issuer !== auth.issuer) throw new Error("Unexpected fixture issuer");
const pool = createPool(auth);
await migrateAuth(pool);
await pool.end();
const entries = new Map<string, { owner: string; payload: string; detail: RunDetail; content: string }>();
function entry(owner: string, runId: string) {
  const found = [...entries.values()].find((value) => value.owner === owner && value.detail.summary.run_id === runId);
  if (!found) throw new RunServiceError("run_not_found", 404);
  return found;
}
const runs: RunService = {
  async submit(owner: string, input: RunInput) {
    const payload = JSON.stringify(input);
    const existing = entries.get(`${owner}:${input.key}`);
    if (existing) {
      if (existing.payload !== payload) throw new RunServiceError("idempotency_conflict", 409);
      return { run_id: existing.detail.summary.run_id, replayed: true };
    }
    const run_id = `ax-run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const content = input.input_text || input.instruction;
    const adapter = input.mode === "offline" ? "offline" : "antigravity";
    const detail: RunDetail = {
      summary: { run_id, adapter, accepted_at: new Date().toISOString(), state: "running", phase: "running", resolved: false, active: true, can_recover: false, error_type: null },
      request: { schema_version: 1, run_id, adapter, instruction: input.instruction, inputs: input.input_text ? { "input.txt": input.input_text } : {}, output_name: input.output_name },
      result: null, cleanup: { egress_denied: false, suspended: false }, cleanup_errors: [],
    };
    entries.set(`${owner}:${input.key}`, { owner, payload, detail, content });
    setTimeout(() => {
      detail.summary = { ...detail.summary, state: "succeeded", phase: "finished", resolved: true, active: false };
      detail.cleanup = { egress_denied: true, suspended: true };
      detail.result = { schema_version: 1, run_id, adapter, status: "succeeded", exit_code: 0, stop_reason: adapter === "offline" ? "OFFLINE" : "UNSPECIFIED", usage: adapter === "offline" ? { total_token_count: 0 } : { prompt_token_count: 100, total_token_count: 120 }, estimated_usd: adapter === "offline" ? 0 : 0.0001, error_type: null, artifact: { name: input.output_name, size_bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") } };
    }, 700);
    return { run_id, replayed: false };
  },
  async list(owner) { return { runs: [...entries.values()].filter((value) => value.owner === owner).reverse().map((value) => value.detail.summary) }; },
  async get(owner, runId) { return entry(owner, runId).detail; },
  async artifact(owner, runId) { const found = entry(owner, runId); return { name: found.detail.request.output_name, content: found.content }; },
  async recover(owner, runId) { entry(owner, runId); return { run_id: runId }; },
};
const conversationOwners = new Map<string, string>();
const conversations = new Map<string, { key: string; input: ChatInput; runId: string }[]>();
const chats: ChatService = {
  async submit(owner, id, input) {
    if (conversationOwners.has(id) && conversationOwners.get(id) !== owner) throw new RunServiceError("conversation_not_found", 404);
    const turns = conversations.get(id) ?? [];
    const existing = turns.find((turn) => turn.key === input.key);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new RunServiceError("idempotency_conflict", 409);
      return { conversation_id: id, run_id: existing.runId, replayed: true };
    }
    if ((turns.at(-1)?.runId ?? null) !== input.parent_run_id) throw new RunServiceError("conversation_conflict", 409);
    const past = turns.map((turn) => turn.input.text).join("\n");
    const codeword = /「([^」]+)」/.exec(past)?.[1];
    const reply = input.text === "会話の上限テスト" ? "会話を保存しました。".repeat(300) : input.text.includes("合言葉") && codeword ? `合言葉は「${codeword}」です。` : input.text.includes("合言葉") ? "合言葉を覚えました。" : `一緒に考えましょう。\n\n${input.text}`;
    const accepted = await runs.submit(owner, { key: input.key, mode: "model", instruction: input.text, input_text: reply, output_name: "reply.txt", allow_model: true });
    turns.push({ key: input.key, input, runId: accepted.run_id });
    conversations.set(id, turns);
    conversationOwners.set(id, owner);
    if (input.text === "受付結果テスト") throw new RunServiceError("bridge_unavailable", 503);
    return { conversation_id: id, ...accepted };
  },
  async get(owner, id) {
    if (conversationOwners.get(id) !== owner) throw new RunServiceError("conversation_not_found", 404);
    const turns = conversations.get(id);
    if (!turns) throw new RunServiceError("conversation_not_found", 404);
    const last = entry(owner, turns.at(-1)!.runId).detail.summary;
    const history = turns.flatMap((turn) => { const value = entry(owner, turn.runId); return value.detail.summary.state === "succeeded" ? [{ role: "user", content: turn.input.text }, { role: "assistant", content: value.content }] : []; });
    const context_full = turns.length >= 32 || Buffer.byteLength(JSON.stringify(history)) > 4096;
    const detail: ConversationDetail = {
      conversation: { id, title: Array.from(turns[0]!.input.text).slice(0, 60).join("").replace(/[\r\n]/g, " "), updated_at: last.accepted_at!, head_run_id: last.run_id, turn_count: turns.length, state: last.state },
      turns: turns.map((turn) => { const value = entry(owner, turn.runId); return { summary: value.detail.summary, user: turn.input.text, assistant: value.detail.summary.state === "succeeded" ? value.content : null }; }),
      can_send: last.resolved && !context_full, context_full,
    };
    return detail;
  },
  async list(owner) { return { conversations: await Promise.all([...conversations.keys()].filter((id) => conversationOwners.get(id) === owner).reverse().map(async (id) => (await chats.get(owner, id)).conversation)) }; },
};
const api = serve({ fetch: createApi(config, undefined, runs, chats).fetch, hostname: "127.0.0.1", port: config.apiPort });
const child = spawn(process.execPath, ["--import", "tsx", "server/serve.ts"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.webPort), NODE_ENV: "production" }, stdio: "inherit",
});
function stop() { api.close(); void fixture.close(); child.kill("SIGTERM"); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => { api.close(); void fixture.close(); process.exitCode = 1; });
child.on("exit", (code) => { api.close(); void fixture.close(); process.exitCode = code ?? 0; });
