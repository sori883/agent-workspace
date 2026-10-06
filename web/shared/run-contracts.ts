import { z } from "zod";

export const MAX_RUN_REQUEST_BYTES = 64 * 1024;
export const MAX_RUN_RESPONSE_BYTES = 512 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const safeIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const protocolIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/);
export const runIdSchema = z.string().regex(/^ax-run-[0-9a-f]{16}$/);
export const outputNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const adapterSchema = z.enum(["offline", "antigravity"]);

function textSchema(maxBytes: number, allowNull = false) {
  return z.string().refine((value) => (allowNull || !value.includes("\0")) && !Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && code >= 0xd800 && code <= 0xdfff;
  }) && encoder.encode(value).byteLength <= maxBytes, "Invalid UTF-8 text or size");
}

const instructionSchema = textSchema(2048).refine((value) => value.trim().length > 0);
export const runInputSchema = z.object({
  key: z.uuid(),
  mode: z.enum(["offline", "model"]),
  instruction: instructionSchema,
  input_text: textSchema(4096),
  output_name: outputNameSchema,
  allow_model: z.boolean(),
}).strict().refine((value) => value.mode !== "model" || value.allow_model, "Model use requires consent");

export const protocolRequestSchema = z.object({
  schema_version: z.literal(1),
  run_id: runIdSchema,
  adapter: adapterSchema,
  instruction: instructionSchema,
  inputs: z.record(outputNameSchema, textSchema(4096)).refine((value) => Object.keys(value).length <= 4 && Object.values(value).reduce((size, text) => size + encoder.encode(text).byteLength, 0) <= 4096),
  output_name: outputNameSchema,
}).strict();

export const protocolResultSchema = z.object({
  schema_version: z.literal(1),
  run_id: runIdSchema,
  adapter: adapterSchema,
  status: z.enum(["succeeded", "failed", "timed_out"]),
  exit_code: z.number().int(),
  stop_reason: protocolIdentifier.nullable(),
  usage: z.record(protocolIdentifier, z.number().int().nonnegative()).refine((value) => Object.keys(value).length > 0).nullable(),
  estimated_usd: z.number().nonnegative().nullable(),
  error_type: protocolIdentifier.nullable(),
  artifact: z.object({ name: outputNameSchema, size_bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().nullable(),
}).strict().refine((value) => {
  if (value.status !== "succeeded") return value.exit_code !== 0;
  if (value.exit_code !== 0 || value.error_type !== null || value.usage === null || value.estimated_usd === null || value.artifact === null) return false;
  if (value.adapter === "offline") return value.stop_reason === "OFFLINE" && value.estimated_usd === 0 && Object.values(value.usage).every((amount) => amount === 0);
  return value.stop_reason === "UNSPECIFIED" && (value.usage.prompt_token_count ?? 0) > 0 && (value.usage.total_token_count ?? 0) > 0;
});

export const runSummarySchema = z.object({
  run_id: runIdSchema,
  adapter: adapterSchema,
  accepted_at: z.iso.datetime().nullable(),
  state: z.enum(["accepted", "running", "succeeded", "failed", "needs_recovery", "not_started"]),
  phase: safeIdentifier,
  resolved: z.boolean(),
  active: z.boolean(),
  can_recover: z.boolean(),
  error_type: safeIdentifier.nullable(),
}).strict();
export const runDetailSchema = z.object({
  summary: runSummarySchema,
  request: protocolRequestSchema,
  result: protocolResultSchema.nullable(),
  cleanup: z.object({ egress_denied: z.boolean(), suspended: z.boolean() }).strict(),
  cleanup_errors: z.array(safeIdentifier),
}).strict().refine((value) => value.summary.run_id === value.request.run_id && value.summary.adapter === value.request.adapter && (value.result === null || value.result.run_id === value.summary.run_id && value.result.adapter === value.summary.adapter));
export const runListSchema = z.object({ runs: z.array(runSummarySchema).max(50) }).strict();
export const submitResultSchema = z.object({ run_id: runIdSchema, replayed: z.boolean() }).strict();
export const recoverResultSchema = z.object({ run_id: runIdSchema }).strict();
export const artifactResultSchema = z.object({ name: outputNameSchema, content: textSchema(MAX_ARTIFACT_BYTES, true) }).strict();
export const emptyRunBodySchema = z.object({}).strict();
export const runHttpErrorSchema = z.object({ error: safeIdentifier }).strict();
export const runErrorStatusSchema = z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(409), z.literal(413), z.literal(415), z.literal(422), z.literal(503)]);
export const bridgeErrorSchema = z.object({ ok: z.literal(false), error: z.object({ code: safeIdentifier, status: runErrorStatusSchema }).strict() }).strict();

export type RunInput = z.infer<typeof runInputSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type ArtifactResult = z.infer<typeof artifactResultSchema>;
export type RunList = z.infer<typeof runListSchema>;
export type SubmitResult = z.infer<typeof submitResultSchema>;
export type RecoverResult = z.infer<typeof recoverResultSchema>;
export type RunErrorStatus = z.infer<typeof runErrorStatusSchema>;
