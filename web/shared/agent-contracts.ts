import { z } from "zod";
import { runIdSchema } from "./run-contracts";

const text = z.string().refine(value => value.trim().length > 0 && !value.includes("\0") && !Array.from(value).some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; }) && new TextEncoder().encode(value).length <= 2048);
export const agentStartSchema = z.object({ key: z.uuid(), conversation_id: z.uuid(), text, mode: z.enum(["preview", "model"]).optional(), allow_model: z.boolean().optional() }).strict().refine(value => value.mode !== "model" || value.allow_model === true, "Model use requires consent");
export const agentAnswerSchema = z.object({ key: z.uuid(), question_id: z.uuid(), expected_revision: z.number().int().positive(), text }).strict();
export const agentRootSchema = z.object({
  id: z.uuid(), conversation_id: z.uuid(), state: z.enum(["running", "stopping", "waiting_input", "succeeded", "failed", "blocked_unknown", "stopped"]),
  revision: z.number().int().positive(), question_id: z.uuid().nullable(), question: text.nullable(), can_answer: z.boolean(), stop_requested: z.boolean(),
  model_calls: z.number().int().min(0).max(3), tool_calls: z.number().int().min(0).max(2), active_ms: z.number().int().nonnegative(),
  grant_expires_at: z.iso.datetime(), wait_expires_at: z.iso.datetime().nullable(), preview: z.boolean(), mode: z.enum(["preview", "model"]), model: z.string().nullable(), estimated_usd: z.number().nonnegative().nullable(),
}).strict().refine(value => value.preview === (value.mode === "preview") && (value.mode === "preview" ? value.model === null && value.estimated_usd === 0 : value.model === "gemini-3.1-flash-lite"), "Inconsistent agent mode");
export const agentListSchema = z.object({ roots: z.array(agentRootSchema).max(50) }).strict();
export const agentSubmitSchema = z.object({ root_id: z.uuid(), conversation_id: z.uuid(), run_id: runIdSchema, replayed: z.boolean() }).strict();
export const agentMutationSchema = z.object({ ok: z.literal(true) }).strict();
export type AgentStart = z.infer<typeof agentStartSchema>;
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;
export type AgentRoot = z.infer<typeof agentRootSchema>;
export type AgentSubmit = z.infer<typeof agentSubmitSchema>;
