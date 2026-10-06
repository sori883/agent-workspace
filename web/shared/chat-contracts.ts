import { z } from "zod";
import { MAX_ARTIFACT_BYTES, runIdSchema, runSummarySchema } from "./run-contracts";

export const MAX_CHAT_RESPONSE_BYTES = 1024 * 1024;
export const MAX_CHAT_TURNS = 32;
export const MAX_CHAT_TEXT_BYTES = 2048;
export const MAX_CHAT_CONTEXT_BYTES = 4096;
const encoder = new TextEncoder();
export const conversationIdSchema = z.uuid().transform((value) => value.toLowerCase());

function utf8Text(maxBytes: number, allowNull = false) {
  return z.string().refine((value) => (allowNull || !value.includes("\0")) && !Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  }) && encoder.encode(value).byteLength <= maxBytes);
}

export const chatInputSchema = z.object({
  key: conversationIdSchema,
  parent_run_id: runIdSchema.nullable(),
  text: utf8Text(MAX_CHAT_TEXT_BYTES).refine((value) => value.trim().length > 0),
  allow_model: z.literal(true),
}).strict();

const chatRunSummarySchema = runSummarySchema.refine((value) => {
  if (value.adapter !== "antigravity" || value.accepted_at === null || value.can_recover !== (!value.resolved && !value.active)) return false;
  if (["succeeded", "failed", "not_started"].includes(value.state)) return value.resolved && !value.active;
  if (value.state === "running") return !value.resolved && value.active;
  if (value.state === "needs_recovery") return !value.resolved && !value.active;
  return !value.resolved;
});
export const conversationSummarySchema = z.object({
  id: conversationIdSchema,
  title: utf8Text(240).refine((value) => Array.from(value).length > 0 && Array.from(value).length <= 60 && !/[\r\n]/.test(value)),
  updated_at: z.iso.datetime(),
  head_run_id: runIdSchema,
  turn_count: z.number().int().min(1).max(MAX_CHAT_TURNS),
  state: runSummarySchema.shape.state,
}).strict();
export const conversationDetailSchema = z.object({
  conversation: conversationSummarySchema,
  turns: z.array(z.object({
    summary: chatRunSummarySchema,
    user: utf8Text(MAX_CHAT_TEXT_BYTES).refine((value) => value.trim().length > 0),
    assistant: utf8Text(MAX_ARTIFACT_BYTES, true).nullable(),
  }).strict()).min(1).max(MAX_CHAT_TURNS),
  can_send: z.boolean(),
  context_full: z.boolean(),
}).strict().refine((value) => {
  const head = value.turns.at(-1);
  if (!head) return false;
  if (value.conversation.turn_count !== value.turns.length || value.conversation.head_run_id !== head.summary.run_id || value.conversation.state !== head.summary.state || value.conversation.updated_at !== head.summary.accepted_at) return false;
  if (new Set(value.turns.map((turn) => turn.summary.run_id)).size !== value.turns.length) return false;
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const [index, turn] of value.turns.entries()) {
    if (index < value.turns.length - 1 && !turn.summary.resolved) return false;
    if (encoder.encode(JSON.stringify(history)).byteLength > MAX_CHAT_CONTEXT_BYTES) return false;
    if ((turn.assistant !== null) !== (turn.summary.state === "succeeded")) return false;
    if (turn.assistant !== null) history.push({ role: "user", content: turn.user }, { role: "assistant", content: turn.assistant });
  }
  const contextFull = value.turns.length >= MAX_CHAT_TURNS || encoder.encode(JSON.stringify(history)).byteLength > MAX_CHAT_CONTEXT_BYTES;
  return value.context_full === contextFull && (!value.can_send || !contextFull && value.turns.every((turn) => turn.summary.resolved));
});
export const conversationListSchema = z.object({ conversations: z.array(conversationSummarySchema).max(50) }).strict().refine((value) => new Set(value.conversations.map((item) => item.id)).size === value.conversations.length);
export const chatSubmitResultSchema = z.object({ conversation_id: conversationIdSchema, run_id: runIdSchema, replayed: z.boolean() }).strict();

export type ChatInput = z.infer<typeof chatInputSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationList = z.infer<typeof conversationListSchema>;
export type ChatSubmitResult = z.infer<typeof chatSubmitResultSchema>;
