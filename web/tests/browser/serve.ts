import { browserSchema } from "./test-database";
import { agentFixture } from "./agent-fixture";
import { WorkspaceRepository } from "../../data/workspaces";
import { postgresWorkspaceService } from "../../api/workspace-service";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { createApi } from "../../api/app";
import { authenticate } from "../../server/auth";
import { createPool } from "../../server/auth-store";
import { migrateAuth } from "../../server/auth-migrate";
import { migrateData } from "../../server/data-migrate";
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
await pool.query(`DROP SCHEMA IF EXISTS ${browserSchema} CASCADE`);
await pool.query(`CREATE SCHEMA ${browserSchema}`);
await migrateAuth(pool);
await migrateData(pool);
const organizations = postgresWorkspaceService(new WorkspaceRepository(pool));
const lostReceipts = new Set<string>();
const createWorkspace = organizations.create.bind(organizations);
organizations.create = async (owner, input) => {
  const result = await createWorkspace(owner, input);
  if (input.name === "受付結果が不明な会社" && !lostReceipts.has(input.key)) { lostReceipts.add(input.key); throw new RunServiceError("bridge_unavailable", 503); }
  return result;
};
const createInvitation = organizations.invite.bind(organizations);
organizations.invite = async (owner, id, input) => {
  const result = await createInvitation(owner, id, input);
  if (input.email === "uncertain@example.test" && !lostReceipts.has(input.key)) { lostReceipts.add(input.key); throw new RunServiceError("bridge_unavailable", 503); }
  return result;
};
async function checkWorkspace(owner: string, workspace?: string | null) { if (workspace) await organizations.get(owner, workspace); }
const entries = new Map<string, { owner: string; workspace: string | null; payload: string; detail: RunDetail; content: string }>();
function entry(owner: string, runId: string, workspace?: string | null) {
  const found = [...entries.values()].find((value) => value.owner === owner && value.workspace === (workspace ?? null) && value.detail.summary.run_id === runId);
  if (!found) throw new RunServiceError("run_not_found", 404);
  return found;
}
const runs: RunService = {
  async submit(owner: string, input: RunInput, workspace?: string | null) {
    await checkWorkspace(owner, workspace);
    const payload = JSON.stringify(input);
    const existing = entries.get(`${owner}:${workspace ?? "legacy"}:${input.key}`);
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
    entries.set(`${owner}:${workspace ?? "legacy"}:${input.key}`, { owner, workspace: workspace ?? null, payload, detail, content });
    setTimeout(() => {
      detail.summary = { ...detail.summary, state: "succeeded", phase: "finished", resolved: true, active: false };
      detail.cleanup = { egress_denied: true, suspended: true };
      detail.result = { schema_version: 1, run_id, adapter, status: "succeeded", exit_code: 0, stop_reason: adapter === "offline" ? "OFFLINE" : "UNSPECIFIED", usage: adapter === "offline" ? { total_token_count: 0 } : { prompt_token_count: 100, total_token_count: 120 }, estimated_usd: adapter === "offline" ? 0 : 0.0001, error_type: null, artifact: { name: input.output_name, size_bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") } };
    }, 700);
    return { run_id, replayed: false };
  },
  async list(owner, workspace) { await checkWorkspace(owner, workspace); if (!workspace) seedLegacy(owner); return { runs: [...entries.values()].filter((value) => value.owner === owner && value.workspace === (workspace ?? null)).reverse().map((value) => value.detail.summary) }; },
  async get(owner, runId, workspace) { await checkWorkspace(owner, workspace); return entry(owner, runId, workspace).detail; },
  async artifact(owner, runId, workspace) { await checkWorkspace(owner, workspace); const found = entry(owner, runId, workspace); return { name: found.detail.request.output_name, content: found.content }; },
  async recover(owner, runId, workspace) { await checkWorkspace(owner, workspace); const found = entry(owner, runId, workspace); found.detail.summary = { ...found.detail.summary, state: "not_started", phase: "not_started", resolved: true, active: false, can_recover: false }; return { run_id: runId }; },
};
function seedLegacy(owner: string) {
  const key = `${owner}:legacy:seed`;
  if (entries.has(key)) return;
  const run_id = `ax-run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  entries.set(key, { owner, workspace: null, payload: "", content: "以前の作業用テキスト", detail: {
    summary: { run_id, adapter: "offline", accepted_at: new Date().toISOString(), state: "needs_recovery", phase: "accepted", resolved: false, active: false, can_recover: true, error_type: null },
    request: { schema_version: 1, run_id, adapter: "offline", instruction: "以前の本人限定の実行", inputs: {}, output_name: "result.txt" },
    result: null, cleanup: { egress_denied: false, suspended: false }, cleanup_errors: [],
  } });
}
const conversationOwners = new Map<string, string>();
const conversations = new Map<string, { key: string; input: ChatInput; runId: string }[]>();
const chats: ChatService = {
  async submit(owner, id, input, workspace) {
    await checkWorkspace(owner, workspace);
    const scope = `${owner}:${workspace ?? "legacy"}`;
    if (conversationOwners.has(id) && conversationOwners.get(id) !== scope) throw new RunServiceError("conversation_not_found", 404);
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
    const accepted = await runs.submit(owner, { key: input.key, mode: "model", instruction: input.text, input_text: reply, output_name: "reply.txt", allow_model: true }, workspace);
    turns.push({ key: input.key, input, runId: accepted.run_id });
    conversations.set(id, turns);
    conversationOwners.set(id, scope);
    if (input.text === "受付結果テスト") throw new RunServiceError("bridge_unavailable", 503);
    return { conversation_id: id, ...accepted };
  },
  async get(owner, id, workspace) {
    await checkWorkspace(owner, workspace);
    const scope = `${owner}:${workspace ?? "legacy"}`;
    if (conversationOwners.get(id) !== scope) throw new RunServiceError("conversation_not_found", 404);
    const turns = conversations.get(id);
    if (!turns) throw new RunServiceError("conversation_not_found", 404);
    const last = entry(owner, turns.at(-1)!.runId, workspace).detail.summary;
    const history = turns.flatMap((turn) => { const value = entry(owner, turn.runId, workspace); return value.detail.summary.state === "succeeded" ? [{ role: "user", content: turn.input.text }, { role: "assistant", content: value.content }] : []; });
    const context_full = turns.length >= 32 || Buffer.byteLength(JSON.stringify(history)) > 4096;
    const detail: ConversationDetail = {
      conversation: { id, title: Array.from(turns[0]!.input.text).slice(0, 60).join("").replace(/[\r\n]/g, " "), updated_at: last.accepted_at!, head_run_id: last.run_id, turn_count: turns.length, state: last.state },
      turns: turns.map((turn) => { const value = entry(owner, turn.runId, workspace); return { summary: value.detail.summary, user: turn.input.text, assistant: value.detail.summary.state === "succeeded" ? value.content : null }; }),
      can_send: last.resolved && !context_full, context_full,
    };
    return detail;
  },
  async list(owner, workspace) { await checkWorkspace(owner, workspace); return { conversations: await Promise.all([...conversations.keys()].filter((id) => conversationOwners.get(id) === `${owner}:${workspace ?? "legacy"}`).reverse().map(async (id) => (await chats.get(owner, id, workspace)).conversation)) }; },
};
const interactive = agentFixture(runs, chats, checkWorkspace);
const api = serve({ fetch: createApi(config, undefined, interactive.runs, interactive.chats, authenticate, organizations, interactive.agents).fetch, hostname: "127.0.0.1", port: config.apiPort });
const child = spawn(process.execPath, ["--import", "tsx", "server/serve.ts"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.webPort), NODE_ENV: "production" }, stdio: "inherit",
});
function stop() { api.close(); void fixture.close(); child.kill("SIGTERM"); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => { api.close(); void fixture.close(); process.exitCode = 1; });
child.on("exit", async (code) => { api.close(); await fixture.close(); await pool.query(`DROP SCHEMA ${browserSchema} CASCADE`); await pool.end(); process.exitCode = code ?? 0; });
