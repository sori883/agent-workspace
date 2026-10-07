import { z } from "zod";

export const MAX_DEFINITION_BYTES = 131072;
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const text = (max: number, nonempty = false) => z.string().refine(value => utf8(value) <= max && (!nonempty || value.trim().length > 0)
  && !Array.from(value).some(c => { const n = c.codePointAt(0)!; return n === 0 || (n >= 0xd800 && n <= 0xdfff); }), "Text is empty, invalid, or too large");
const safePath = z.string().max(255).regex(/^(references|scripts|assets)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
export const skillContentSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: text(1024), instructions: text(16384, true),
  files: z.array(z.object({ path: safePath, content: text(32768) }).strict()).max(16),
}).strict().refine(value => new Set(value.files.map(f => f.path)).size === value.files.length
  && utf8(JSON.stringify(value)) <= MAX_DEFINITION_BYTES, "Duplicate paths or oversized content");
export const agentContentSchema = z.object({
  name: text(256, true), instructions: text(16384, true),
  skill_version_ids: z.array(z.uuid().transform(value => value.toLowerCase())).max(8), allowed_tools: z.array(z.literal("python")).max(1),
}).strict().refine(value => new Set(value.skill_version_ids).size === value.skill_version_ids.length && utf8(JSON.stringify(value)) <= MAX_DEFINITION_BYTES, "Duplicate skills or oversized content");
export const definitionContentSchema = z.union([skillContentSchema, agentContentSchema]);
export const definitionKindSchema = z.enum(["skill", "agent"]);
export const definitionVisibilitySchema = z.enum(["personal", "workspace"]);
const key = z.uuid().transform(value => value.toLowerCase());
const revision = z.number().int().positive().max(2147483647);
export const definitionCreateSchema = z.discriminatedUnion("kind", [
  z.object({ key, kind: z.literal("skill"), visibility: definitionVisibilitySchema, content: skillContentSchema }).strict(),
  z.object({ key, kind: z.literal("agent"), visibility: definitionVisibilitySchema, content: agentContentSchema }).strict(),
]);
export const definitionUpdateSchema = z.object({ key, expected_revision: revision, content: definitionContentSchema }).strict();
export const definitionRevisionInputSchema = z.object({ key, expected_revision: revision }).strict();
export const definitionListOptionsSchema = z.object({ kind: definitionKindSchema.optional(), filter: z.enum(["personal", "workspace", "all"]).default("all"), before: key.optional(), limit: z.number().int().min(1).max(50).default(50), include_archived: z.boolean().default(false) }).strict();
export const definitionVersionSummarySchema = z.object({ id: z.uuid(), name: text(256, true), version: z.number().int().min(1).max(100), sha256: z.string().regex(/^[0-9a-f]{64}$/), published_at: z.iso.datetime() }).strict();
export const definitionSummarySchema = z.object({
  id: z.uuid(), workspace_id: z.uuid(), created_by_user_id: z.uuid(), kind: definitionKindSchema, visibility: definitionVisibilitySchema,
  name: text(256, true), revision: revision.nullable(), can_edit: z.boolean(), archived_at: z.iso.datetime().nullable(), created_at: z.iso.datetime(), latest_version: definitionVersionSummarySchema.nullable(),
}).strict().refine(value => value.can_edit === (value.revision !== null), "Invalid edit state");
export const definitionVersionSchema = z.object({
  id: z.uuid(), definition_id: z.uuid(), version: z.number().int().min(1).max(100), kind: definitionKindSchema, content: definitionContentSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/), published_by_user_id: z.uuid(), published_at: z.iso.datetime(),
}).strict().refine(value => (value.kind === "skill" ? skillContentSchema : agentContentSchema).safeParse(value.content).success, "Content kind mismatch");
export const definitionDetailSchema = z.object({ definition: definitionSummarySchema, draft: z.object({ revision, content: definitionContentSchema }).strict().nullable(), version: definitionVersionSchema.nullable() }).strict()
  .refine(value => value.definition.can_edit === (value.draft !== null)
    && (value.draft === null || value.draft.revision === value.definition.revision)
    && (value.version === null || value.version.definition_id === value.definition.id), "Inconsistent definition");
export const definitionMutationResultSchema = z.object({ definition: definitionSummarySchema, version: definitionVersionSchema.nullable(), replayed: z.boolean() }).strict();
export const definitionListSchema = z.object({ definitions: z.array(definitionSummarySchema).max(50), next_cursor: z.uuid().nullable() }).strict();
export type SkillContent = z.infer<typeof skillContentSchema>;
export type AgentContent = z.infer<typeof agentContentSchema>;
export type DefinitionContent = z.infer<typeof definitionContentSchema>;
export type DefinitionCreate = z.infer<typeof definitionCreateSchema>;
export type DefinitionUpdate = z.infer<typeof definitionUpdateSchema>;
export type DefinitionRevisionInput = z.infer<typeof definitionRevisionInputSchema>;
export type DefinitionSummary = z.infer<typeof definitionSummarySchema>;
export type DefinitionDetail = z.infer<typeof definitionDetailSchema>;
export type DefinitionVersion = z.infer<typeof definitionVersionSchema>;
export type DefinitionMutationResult = z.infer<typeof definitionMutationResultSchema>;
export type DefinitionList = z.infer<typeof definitionListSchema>;
export type DefinitionListOptions = z.input<typeof definitionListOptionsSchema>;
export function renderSkillMarkdown(content: SkillContent): string {
  const value = skillContentSchema.parse(content);
  return `---\nname: ${JSON.stringify(value.name)}\ndescription: ${JSON.stringify(value.description)}\n---\n\n${value.instructions}\n`;
}
