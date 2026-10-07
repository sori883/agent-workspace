import { createHash, randomUUID } from "node:crypto";
import type { AgentService } from "../../api/agent-service";
import type { ChatService } from "../../api/chat-service";
import { RunServiceError, type RunService } from "../../api/run-service";
import type { AgentRoot, AgentSubmit } from "../../shared/agent-contracts";
import type { ConversationDetail } from "../../shared/chat-contracts";
import type { RunDetail } from "../../shared/run-contracts";

export function agentFixture(baseRuns: RunService, baseChats: ChatService, check: (owner: string, workspace?: string | null) => Promise<void>) {
  const roots = new Map<string, { owner: string; workspace: string; root: AgentRoot; detail: ConversationDetail; runs: RunDetail[] }>();
  const keys = new Map<string, { payload: string; result: AgentSubmit }>();
  const receipts = new Set<string>();
  async function get(owner: string, workspace: string, id: string) {
    await check(owner, workspace);
    const item = roots.get(id);
    if (!item || item.owner !== owner || item.workspace !== workspace) throw new RunServiceError("agent_not_found", 404);
    return item;
  }
  function segment(item: NonNullable<ReturnType<typeof roots.get>>, text: string) {
    const run_id = `ax-run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const accepted_at = new Date().toISOString();
    const run: RunDetail = { summary: { run_id, adapter: "interactive", accepted_at, state: "running", phase: "running", resolved: false, active: true, can_recover: false, error_type: null }, request: { schema_version: 1, run_id, adapter: "interactive", instruction: text, inputs: {}, output_name: "reply.txt" }, result: null, cleanup: { egress_denied: false, suspended: false }, cleanup_errors: [] };
    item.runs.push(run);
    item.detail.turns.push({ summary: run.summary, user: text, assistant: null });
    item.detail.conversation = { ...item.detail.conversation, updated_at: accepted_at, head_run_id: run_id, turn_count: item.runs.length, state: "running" };
    item.root.state = "running";
    setTimeout(() => {
      const reply = item.runs.length === 1 ? "成果物に含めたい内容を教えてください。" : `依頼と回答を整理しました。\n${text}`;
      const stopped = item.root.stop_requested;
      run.summary = { ...run.summary, state: stopped ? "not_started" : "succeeded", phase: "finished", resolved: true, active: false };
      run.cleanup = { egress_denied: true, suspended: true };
      if (!stopped) run.result = { schema_version: 1, run_id, adapter: "interactive", status: "succeeded", exit_code: 0, stop_reason: "UNSPECIFIED", usage: { prompt_token_count: 100, candidates_token_count: 20, total_token_count: 120 }, estimated_usd: 0, error_type: null, artifact: { name: "reply.txt", size_bytes: Buffer.byteLength(reply), sha256: createHash("sha256").update(reply).digest("hex") } };
      item.detail.turns[item.runs.length - 1] = { summary: run.summary, user: text, assistant: stopped ? null : reply };
      item.detail.conversation.state = run.summary.state;
      item.root.state = stopped ? "stopped" : item.runs.length === 1 ? "waiting_input" : "succeeded";
      item.root.question_id = item.root.state === "waiting_input" ? item.root.id : null;
      item.root.question = item.root.question_id ? reply : null;
      item.root.can_answer = !!item.root.question_id;
      item.root.revision++;
      item.root.model_calls++;
      item.root.tool_calls++;
    }, 700);
    return { root_id: item.root.id, conversation_id: item.root.conversation_id, run_id, replayed: false };
  }
  const agents: AgentService = {
    async list(owner, workspace) { await check(owner, workspace); return { roots: [...roots.values()].filter(item => item.owner === owner && item.workspace === workspace).map(item => item.root).reverse() }; },
    async get(owner, workspace, id) { return (await get(owner, workspace, id)).root; },
    async start(owner, workspace, input, expires) {
      await check(owner, workspace);
      const key = `${owner}:${workspace}:${input.key}`;
      const previous = keys.get(key);
      if (previous) { if (previous.payload !== JSON.stringify(input)) throw new RunServiceError("idempotency_conflict", 409); return { ...previous.result, replayed: true }; }
      const id = randomUUID();
      const item = { owner, workspace, root: { id, conversation_id: input.conversation_id, state: "running", revision: 1, question_id: null, question: null, can_answer: false, stop_requested: false, model_calls: 0, tool_calls: 0, active_ms: 0, grant_expires_at: new Date(expires * 1000).toISOString(), wait_expires_at: null, preview: true } as AgentRoot, detail: { conversation: { id: input.conversation_id, title: input.text, updated_at: new Date().toISOString(), head_run_id: "", turn_count: 0, state: "running" }, turns: [], can_send: false, context_full: false, agent_root_id: id } as ConversationDetail, runs: [] as RunDetail[] };
      roots.set(id, item);
      const result = segment(item, input.text);
      keys.set(key, { payload: JSON.stringify(input), result });
      if (input.text === "対話の受付結果テスト" && !receipts.has(key)) { receipts.add(key); throw new RunServiceError("bridge_unavailable", 503); }
      return result;
    },
    async answer(owner, workspace, id, input) {
      const item = await get(owner, workspace, id);
      const key = `${owner}:${workspace}:${input.key}`;
      const previous = keys.get(key);
      if (previous) { if (previous.payload !== JSON.stringify(input)) throw new RunServiceError("idempotency_conflict", 409); return { ...previous.result, replayed: true }; }
      if (!item.root.can_answer || input.question_id !== id || input.expected_revision !== item.root.revision) throw new RunServiceError("agent_answer_conflict", 409);
      item.root.can_answer = false;
      item.root.revision++;
      const result = segment(item, input.text);
      keys.set(key, { payload: JSON.stringify(input), result });
      return result;
    },
    async stop(owner, workspace, id) { const item = await get(owner, workspace, id); if (item.detail.conversation.title === "停止失敗テスト" && !receipts.has(id)) { receipts.add(id); throw new RunServiceError("bridge_unavailable", 503); } item.root.stop_requested = true; item.root.can_answer = false; item.root.state = item.root.state === "waiting_input" ? "stopped" : "stopping"; return { ok: true }; },
    async revoke(owner) { for (const item of roots.values()) if (item.owner === owner && ["running", "waiting_input"].includes(item.root.state)) await agents.stop(owner, item.workspace, item.root.id); return { ok: true }; },
  };
  const chats: ChatService = {
    ...baseChats,
    async list(owner, workspace) { const base = await baseChats.list(owner, workspace); return { conversations: [...base.conversations, ...[...roots.values()].filter(item => item.owner === owner && item.workspace === workspace).map(item => item.detail.conversation)] }; },
    async get(owner, id, workspace) { const item = [...roots.values()].find(item => item.root.conversation_id === id); if (!item) return baseChats.get(owner, id, workspace); return (await get(owner, workspace!, item.root.id)).detail; },
  };
  const runs: RunService = {
    ...baseRuns,
    async get(owner, id, workspace) { const item = [...roots.values()].find(item => item.runs.some(run => run.summary.run_id === id)); if (!item) return baseRuns.get(owner, id, workspace); return (await get(owner, workspace!, item.root.id)).runs.find(run => run.summary.run_id === id)!; },
    async artifact(owner, id, workspace) { const item = [...roots.values()].find(item => item.runs.some(run => run.summary.run_id === id)); if (!item) return baseRuns.artifact(owner, id, workspace); const detail = (await get(owner, workspace!, item.root.id)).detail; return { name: "reply.txt", content: detail.turns.find(turn => turn.summary.run_id === id)!.assistant! }; },
  };
  return { agents, chats, runs };
}
