import { z } from "zod";
import { RunServiceError } from "../api/run-service";
import { renderSkillMarkdown, skillContentSchema, type SkillContent } from "../shared/definition-contracts";
import { MAX_SKILL_MANIFEST_BYTES, skillFilePathsAreCompatible, skillManifestSchema, skillRevisionPrefix, storedSkillContentSchema, type SkillFileMetadata, type SkillManifest, type SkillObjectStore, type StoredSkillContent } from "../shared/skill-storage-contracts";
import { canonical, sha256, utf8 } from "./canonical";

export type SkillSaveCall = (name: string, args: unknown[]) => Promise<unknown>;
const ticketSchema = z.object({ definition_id: z.uuid(), revision_id: z.uuid(), lease_token: z.uuid(), generation: z.number().int().positive(), result: z.unknown().nullable() });
const decodeSkillUtf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
export class SkillStorage {
  constructor(readonly store: SkillObjectStore) {}
  async prepare(content: SkillContent) {
    const value = skillContentSchema.parse(content);
    if (!skillFilePathsAreCompatible(value.files)) throw new RunServiceError("invalid_request", 400);
    const objects = [{ path: "SKILL.md", bytes: utf8(renderSkillMarkdown(value)) }, ...value.files.map(file => ({ path: file.path, bytes: utf8(file.content) }))];
    const files: SkillFileMetadata[] = await Promise.all(objects.map(async file => ({ path: file.path, size_bytes: file.bytes.length, media_type: "text/plain; charset=utf-8" as const, sha256: await sha256(file.bytes) })));
    const bytes = utf8(canonical(value, true));
    return { objects, files, content_sha256: await sha256(bytes), content_bytes: bytes.length, file_bytes: objects.reduce((sum, file) => sum + file.bytes.length, 0) };
  }
  async save(call: SkillSaveCall, owner: string, workspace: string, id: string | null, input: { key: string; expected_revision?: number; visibility?: string; content: SkillContent }) {
    const prepared = await this.prepare(input.content);
    const metadata = { key: input.key, ...(id ? { expected_revision: input.expected_revision } : { visibility: input.visibility }), name: input.content.name, description: input.content.description,
      files: prepared.files, content_sha256: prepared.content_sha256, content_bytes: prepared.content_bytes, file_bytes: prepared.file_bytes, store_id: this.store.storeId };
    const ticket = ticketSchema.parse(await call("ax_skill_save_begin", [owner, workspace, id, metadata, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]));
    if (ticket.result !== null) return ticket.result;
    const prefix = skillRevisionPrefix(workspace, ticket.definition_id, ticket.revision_id);
    const manifest: SkillManifest = { format_version: 1, workspace_id: workspace, definition_id: ticket.definition_id, revision_id: ticket.revision_id,
      name: input.content.name, description: input.content.description, content_sha256: prepared.content_sha256, files: prepared.files };
    const manifestBytes = utf8(canonical(skillManifestSchema.parse(manifest), true));
    if (manifestBytes.length > MAX_SKILL_MANIFEST_BYTES) throw new RunServiceError("invalid_request", 400);
    for (const file of prepared.objects) await this.store.putImmutable(prefix + file.path, file.bytes, "text/plain; charset=utf-8");
    await this.store.putImmutable(prefix + "manifest.json", manifestBytes, "application/json");
    const source = { type: "skill-object-v1", store_id: this.store.storeId, revision_id: ticket.revision_id, manifest_key: prefix + "manifest.json",
      manifest_sha256: await sha256(manifestBytes), manifest_bytes: manifestBytes.length, total_bytes: prepared.file_bytes + manifestBytes.length };
    return call("ax_skill_save_commit", [owner, workspace, input.key, ticket.lease_token, ticket.generation, source]);
  }
  async hydrate(value: unknown): Promise<SkillContent> {
    const parsed = storedSkillContentSchema.safeParse(value);
    if (!parsed.success) throw new RunServiceError("skill_storage_integrity");
    const stored = parsed.data;
    if (stored.source.store_id !== this.store.storeId) throw new RunServiceError("skill_storage_unavailable");
    const manifestBytes = await this.store.get(stored.source.manifest_key, stored.source.manifest_bytes);
    if (await sha256(manifestBytes) !== stored.source.manifest_sha256) throw new RunServiceError("skill_storage_integrity");
    let manifest: SkillManifest;
    try { manifest = skillManifestSchema.parse(JSON.parse(decodeSkillUtf8(manifestBytes))); } catch { throw new RunServiceError("skill_storage_integrity"); }
    const prefix = skillRevisionPrefix(manifest.workspace_id, manifest.definition_id, manifest.revision_id);
    if (prefix + "manifest.json" !== stored.source.manifest_key || manifest.revision_id !== stored.source.revision_id || manifest.name !== stored.name || manifest.description !== stored.description
      || manifest.content_sha256 !== stored.content_sha256 || canonical(manifest.files, true) !== canonical(stored.files, true)
      || manifest.files.reduce((sum, file) => sum + file.size_bytes, manifestBytes.length) !== stored.source.total_bytes) throw new RunServiceError("skill_storage_integrity");
    const content = await Promise.all(manifest.files.map(async file => {
      const bytes = await this.store.get(prefix + file.path, file.size_bytes);
      if (bytes.length !== file.size_bytes || await sha256(bytes) !== file.sha256) throw new RunServiceError("skill_storage_integrity");
      try { return decodeSkillUtf8(bytes); } catch { throw new RunServiceError("skill_storage_integrity"); }
    }));
    const header = `---\nname: ${JSON.stringify(manifest.name)}\ndescription: ${JSON.stringify(manifest.description)}\n---\n\n`;
    if (!content[0].startsWith(header) || !content[0].endsWith("\n")) throw new RunServiceError("skill_storage_integrity");
    const hydrated = { name: manifest.name, description: manifest.description, instructions: content[0].slice(header.length, -1), files: manifest.files.slice(1).map((file, i) => ({ path: file.path, content: content[i + 1] })) };
    if (!skillContentSchema.safeParse(hydrated).success || await sha256(utf8(canonical(hydrated, true))) !== manifest.content_sha256) throw new RunServiceError("skill_storage_integrity");
    return hydrated;
  }
}
export function isStoredSkill(value: unknown): value is StoredSkillContent {
  return !!value && typeof value === "object" && "source" in value;
}
