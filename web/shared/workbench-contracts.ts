import { z } from "zod";

const id = z.uuid().transform(value => value.toLowerCase());
const run = z.string().regex(/^ax-run-[0-9a-f]{16}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().refine(value => value.trim().length > 0 && new TextEncoder().encode(value).length <= max && !Array.from(value).some(c => { const n = c.codePointAt(0)!; return n === 0 || n >= 0xd800 && n <= 0xdfff; }));
export const workbenchStartSchema = z.object({ key: id, text: text(2048), mode: z.enum(["preview", "model"]).default("preview"), allow_model: z.boolean().optional(), agent_version_id: id.optional(), skill_version_ids: z.array(id).max(8).optional(), input_file_ids: z.array(id).max(4).default([]) }).strict()
  .refine(value => value.mode !== "model" || value.allow_model === true, "Model consent required")
  .refine(value => new Set(value.input_file_ids).size === value.input_file_ids.length && new Set(value.skill_version_ids).size === (value.skill_version_ids?.length ?? 0), "Duplicate references")
  .refine(value => !value.agent_version_id || !value.skill_version_ids?.length, "Choose an agent or skills");
export const workbenchAnswerSchema = z.object({ key: id, question_id: id, expected_revision: z.number().int().positive(), text: text(2048) }).strict();
export const workbenchSubmitSchema = z.object({ root_id: id, run_id: run, replayed: z.boolean(), protocol_version: z.literal(2) }).strict();
const file = z.object({ alias: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), file_id: id, name: z.string(), size_bytes: z.number().int().min(1).max(8388608), sha256: digest }).strict();
export const workbenchRootSchema = z.object({
  id, protocol_version: z.literal(2), state: z.enum(["running", "stopping", "waiting_input", "succeeded", "failed", "blocked_unknown", "stopped"]),
  revision: z.number().int().positive(), current_run_id: run, stage: z.enum(["runtime", "python"]), mode: z.enum(["preview", "model"]),
  question_id: id.nullable(), question: z.string().nullable(), can_answer: z.boolean(), stop_requested: z.boolean(),
  model_calls: z.number().int().min(0).max(6), tool_calls: z.number().int().min(0).max(8), python_calls: z.number().int().min(0).max(3), active_ms: z.number().int().nonnegative(),
  estimated_usd: z.number().nonnegative().nullable(), reserved_usd: z.number().nonnegative(),
  messages: z.array(z.object({ run_id: run, kind: z.string(), text: z.string() }).strict()).max(17),
  input_files: z.array(file).max(4), output_files: z.array(file).max(12), checkpoints: z.array(z.object({ revision: z.number().int().positive(), run_id: run, kind: z.string(), text: z.string() }).strict()).max(9),
}).strict();
export const workbenchListSchema = z.object({ roots: z.array(workbenchRootSchema).max(50), next_cursor: id.nullable() }).strict();
export const workbenchMutationSchema = z.object({ ok: z.literal(true) }).strict();
export type WorkbenchStart = z.input<typeof workbenchStartSchema>;
export type WorkbenchAnswer = z.infer<typeof workbenchAnswerSchema>;
export type WorkbenchRoot = z.infer<typeof workbenchRootSchema>;
export type WorkbenchSubmit = z.infer<typeof workbenchSubmitSchema>;
export const workbenchApiFunctions = ["ax_workbench_start", "ax_workbench_answer", "ax_workbench_list", "ax_workbench_get", "ax_workbench_stop", "ax_workbench_request_recovery"];
export const workbenchExecutionFunctions = ["ax_workbench_input_manifest", "ax_workbench_read_chunk", "ax_workbench_definition_chunk", "ax_workbench_output_begin", "ax_workbench_output_chunk", "ax_workbench_output_seal", "ax_workbench_cleanup"];
