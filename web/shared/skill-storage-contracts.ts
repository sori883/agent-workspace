import { z } from "zod";

export const MAX_SKILL_MANIFEST_BYTES = 16384;
export const MAX_SKILL_OBJECT_BYTES = 32768;
export const MAX_SKILL_REVISION_BYTES = 163840;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.uuid();
export function skillFilePathsAreCompatible(files: readonly { path: string }[]) {
  const paths = files.map(file => file.path);
  return new Set(paths).size === paths.length && !paths.some(path => paths.some(other => other.startsWith(`${path}/`)));
}
export const skillFilePathSchema = z.union([z.literal("SKILL.md"), z.string().max(255).regex(/^(references|scripts|assets)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/)]);
export const skillFileMetadataSchema = z.object({
  path: skillFilePathSchema, size_bytes: z.number().int().min(0).max(MAX_SKILL_OBJECT_BYTES),
  media_type: z.literal("text/plain; charset=utf-8"), sha256: digest,
}).strict();
export const skillManifestSchema = z.object({
  format_version: z.literal(1), workspace_id: uuid, definition_id: uuid, revision_id: uuid,
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().max(1024),
  content_sha256: digest, files: z.array(skillFileMetadataSchema).min(1).max(17),
}).strict().refine(value => value.files[0].path === "SKILL.md" && skillFilePathsAreCompatible(value.files));
export const skillSourceSchema = z.object({
  type: z.literal("skill-object-v1"), store_id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/), revision_id: uuid,
  manifest_key: z.string().regex(/^workspaces\/[0-9a-f-]{36}\/skills\/[0-9a-f-]{36}\/revisions\/[0-9a-f-]{36}\/manifest\.json$/),
  manifest_sha256: digest, manifest_bytes: z.number().int().positive().max(MAX_SKILL_MANIFEST_BYTES),
  total_bytes: z.number().int().positive().max(MAX_SKILL_REVISION_BYTES),
}).strict();
export const storedSkillContentSchema = z.object({
  name: z.string(), description: z.string(), files: z.array(skillFileMetadataSchema).min(1).max(17),
  source: skillSourceSchema, content_sha256: digest,
}).strict().refine(value => value.files[0].path === "SKILL.md" && skillFilePathsAreCompatible(value.files));
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type StoredSkillContent = z.infer<typeof storedSkillContentSchema>;
export type SkillFileMetadata = z.infer<typeof skillFileMetadataSchema>;
export interface SkillObjectStore {
  readonly storeId: string;
  putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string, expectedBytes: number): Promise<Uint8Array>;
}
export function skillRevisionPrefix(workspace: string, definition: string, revision: string) {
  return `workspaces/${uuid.parse(workspace)}/skills/${uuid.parse(definition)}/revisions/${uuid.parse(revision)}/`;
}
