import { z } from "zod";
import { conversationDetailSchema, type ChatInput, type ChatSubmitResult, type ConversationDetail, type ConversationList } from "../shared/chat-contracts";
import { artifactResultSchema, protocolRequestSchema, protocolResultSchema, runDetailSchema, runIdSchema, runSummarySchema, type ArtifactResult, type RecoverResult, type RunDetail, type RunInput, type RunList, type RunSummary, type SubmitResult } from "../shared/run-contracts";
import { RunServiceError } from "../api/run-service";
import type { Database } from "./db";
import { canonical, decodeUtf8, fingerprint, hex, historyJson, sha256, unhex } from "./canonical";

const snapshotSchema = z.object({
  run_id: runIdSchema, owner_user_id: z.uuid().nullable(), conversation_id: z.uuid().nullable(), sequence: z.number().int().nullable(), parent_run_id: runIdSchema.nullable(),
  request: protocolRequestSchema, request_hex: z.string(), request_hash: z.string(), image: z.string(), manifest: z.unknown(), fingerprint: z.string(),
  accepted_at: z.string().nullable(), phase: z.string(), outcome: z.string(), resolved: z.boolean(), active: z.boolean(), error_type: z.string().nullable(),
  result: protocolResultSchema.nullable(), cleanup: z.record(z.string(), z.unknown()), cleanup_errors: z.array(z.string()), invalid: z.boolean(), artifact_hex: z.string().nullable(),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
const codes = new Map<string, 400 | 404 | 409 | 422 | 503>([
  ...["invalid_request", "invalid_owner_user_id", "invalid_run_id", "invalid_conversation_id", "model_not_allowed"].map((code) => [code, 400] as const),
  ...["run_not_found", "artifact_unavailable", "conversation_not_found"].map((code) => [code, 404] as const),
  ...["idempotency_conflict", "another_cli_running", "unresolved_run", "unknown_paid_usage", "paid_failure_requires_review", "failed_request_already_attempted", "pilot_estimate_limit_reached", "execution_already_claimed", "conversation_conflict", "conversation_busy", "invalid_conversation_state"].map((code) => [code, 409] as const),
  ["conversation_context_full", 422], ["admission_closed", 503], ["invalid_run_ledger", 503], ["artifact_verification_failed", 503],
]);
const ownerId = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new RunServiceError("invalid_owner_user_id", 400);
  return parsed.data.toLowerCase();
};
const validRun = (value: string) => {
  if (!runIdSchema.safeParse(value).success) throw new RunServiceError("invalid_run_id", 400);
  return value;
};
const validConversation = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new RunServiceError("invalid_conversation_id", 400);
  return parsed.data.toLowerCase();
};
const invalid = () => new RunServiceError("invalid_bridge_response");

export class DataRepository {
  constructor(readonly database: Database, readonly options: { image: string }) {
    if (!/^localhost:5001\/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$/.test(options.image)) throw new Error("invalid_runner_image");
  }
  private async query(name: string, parameters: unknown[]): Promise<unknown> {
    try {
      const { rows } = await this.database.query<{ value: unknown }>(`SELECT ${name}(${parameters.map((_, index) => `$${index + 1}`).join(",")}) AS value`, parameters);
      if (rows.length !== 1) throw invalid();
      return rows[0].value;
    } catch (error) {
      if (error instanceof RunServiceError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && typeof error.message === "string" && codes.has(error.message)) throw new RunServiceError(error.message, codes.get(error.message));
      throw new RunServiceError("bridge_unavailable");
    }
  }
  private async snapshot(value: unknown, owner: string): Promise<Snapshot> {
    try {
      const row = snapshotSchema.parse(value);
      if (row.invalid || row.owner_user_id !== owner || row.run_id !== row.request.run_id || row.result && (row.result.run_id !== row.run_id || row.result.adapter !== row.request.adapter)) throw invalid();
      const bytes = unhex(row.request_hex);
      if (await sha256(bytes) !== row.request_hash || canonical(protocolRequestSchema.parse(JSON.parse(decodeUtf8(bytes)))) !== canonical(row.request) || await fingerprint(row.request, row.image) !== row.fingerprint) throw invalid();
      const manifest = { apiVersion: "ax.io/v1alpha1", kind: "Task", metadata: { name: row.run_id, atespace: "ax-demo" }, spec: { image: row.image, command: ["python3", "/opt/ax-task/runner.py", "wait"], debug: true } };
      if (canonical(row.manifest) !== canonical(manifest)) throw invalid();
      return row;
    } catch (error) { if (error instanceof RunServiceError) throw error; throw invalid(); }
  }
  private summary(row: Snapshot): RunSummary {
    const active = row.active && !row.resolved;
    const state = row.resolved ? ["not_started", "dry_run"].includes(row.outcome) ? "not_started" : row.outcome === "succeeded" ? "succeeded" : "failed" : row.phase === "accepted" ? "accepted" : active ? "running" : "needs_recovery";
    return runSummarySchema.parse({ run_id: row.run_id, adapter: row.request.adapter, accepted_at: row.accepted_at, phase: row.phase, state, resolved: row.resolved, active, can_recover: !row.resolved && !active, error_type: row.error_type });
  }
  private async artifactContent(row: Snapshot): Promise<string> {
    if (!row.result?.artifact) throw new RunServiceError("artifact_unavailable", 404);
    if (row.artifact_hex === null) throw new RunServiceError("artifact_verification_failed");
    try {
      const bytes = unhex(row.artifact_hex);
      if (bytes.length !== row.result.artifact.size_bytes || await sha256(bytes) !== row.result.artifact.sha256 || row.result.artifact.name !== row.request.output_name) throw invalid();
      return artifactResultSchema.parse({ name: row.result.artifact.name, content: decodeUtf8(bytes) }).content;
    } catch { throw new RunServiceError("artifact_verification_failed"); }
  }
  async submit(owner: string, input: RunInput): Promise<SubmitResult> {
    owner = ownerId(owner);
    const id = `ax-run-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    return z.object({ run_id: runIdSchema, replayed: z.boolean() }).strict().parse(await this.query("ax_accept", [owner, "run", null, JSON.stringify(input), this.options.image, id]));
  }
  async list(owner: string): Promise<RunList> {
    owner = ownerId(owner);
    const rows = z.array(z.unknown()).max(50).parse(await this.query("ax_list_runs", [owner]));
    return { runs: await Promise.all(rows.map(async (row) => this.summary(await this.snapshot(row, owner)))) };
  }
  async get(owner: string, id: string): Promise<RunDetail> {
    owner = ownerId(owner);
    const row = await this.snapshot(await this.query("ax_read_run", [owner, validRun(id)]), owner);
    return runDetailSchema.parse({ summary: this.summary(row), request: row.request, result: row.result, cleanup: { egress_denied: row.cleanup.egress_denied === true, suspended: row.cleanup.suspended === true }, cleanup_errors: row.cleanup_errors });
  }
  async artifact(owner: string, id: string): Promise<ArtifactResult> {
    owner = ownerId(owner);
    const row = await this.snapshot(await this.query("ax_read_run", [owner, validRun(id)]), owner);
    return { name: row.request.output_name, content: await this.artifactContent(row) };
  }
  async recover(owner: string, id: string): Promise<RecoverResult> {
    return z.object({ run_id: z.literal(validRun(id)) }).strict().parse(await this.query("ax_request_recovery", [ownerId(owner), id]));
  }
  async submitChat(owner: string, cid: string, input: ChatInput): Promise<ChatSubmitResult> {
    owner = ownerId(owner); cid = validConversation(cid);
    const id = `ax-run-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
    const result = z.object({ run_id: runIdSchema, replayed: z.boolean() }).strict().parse(await this.query("ax_accept", [owner, "chat", cid, JSON.stringify(input), this.options.image, id]));
    return { ...result, conversation_id: cid };
  }
  private async conversation(value: unknown, owner: string): Promise<ConversationDetail> {
    try {
      const saved = z.object({ id: z.uuid(), head_run_id: runIdSchema, turn_count: z.number().int(), context_hex: z.string(), runs: z.array(z.unknown()).min(1).max(32) }).strict().parse(value);
      const history: { role: string; content: string }[] = [];
      const turns: ConversationDetail["turns"] = [];
      let parent: string | null = null;
      for (const [index, raw] of saved.runs.entries()) {
        const row = await this.snapshot(raw, owner);
        if (row.conversation_id !== saved.id || row.sequence !== index + 1 || row.parent_run_id !== parent || row.request.adapter !== "antigravity" || row.request.output_name !== "reply.txt" || Object.keys(row.request.inputs).length !== 1 || row.request.inputs["conversation.json"] !== historyJson(history)) throw invalid();
        let assistant: string | null = null;
        if (row.resolved && row.outcome === "succeeded") {
          if (row.result?.status !== "succeeded" || row.cleanup.egress_denied !== true || row.cleanup.suspended !== true || row.cleanup_errors.length) throw invalid();
          assistant = await this.artifactContent(row);
          history.push({ role: "user", content: row.request.instruction }, { role: "assistant", content: assistant });
        }
        turns.push({ summary: this.summary(row), user: row.request.instruction, assistant });
        parent = row.run_id;
      }
      if (saved.head_run_id !== parent || saved.turn_count !== turns.length || decodeUtf8(unhex(saved.context_hex)) !== historyJson(history)) throw invalid();
      const head = turns.at(-1)!.summary;
      const contextFull = turns.length >= 32 || new TextEncoder().encode(historyJson(history)).length > 4096;
      return conversationDetailSchema.parse({ conversation: { id: saved.id, title: Array.from(turns[0].user).slice(0, 60).join("").replace(/[\r\n]/g, " "), updated_at: head.accepted_at, head_run_id: head.run_id, turn_count: turns.length, state: head.state }, turns, can_send: !contextFull && turns.every((turn) => turn.summary.resolved), context_full: contextFull });
    } catch { throw new RunServiceError("invalid_conversation_state", 409); }
  }
  async getConversation(owner: string, cid: string): Promise<ConversationDetail> {
    owner = ownerId(owner); cid = validConversation(cid);
    const value = await this.conversation(await this.query("ax_read_conversation", [owner, cid]), owner);
    if (value.conversation.id !== cid) throw invalid();
    return value;
  }
  async listConversations(owner: string): Promise<ConversationList> {
    owner = ownerId(owner);
    const values = z.array(z.unknown()).max(50).parse(await this.query("ax_list_conversations", [owner]));
    return { conversations: await Promise.all(values.map(async (value) => (await this.conversation(value, owner)).conversation)) };
  }
}
