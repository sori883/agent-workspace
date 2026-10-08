import { z } from "zod";
import { RunServiceError } from "../api/run-service";
import * as c from "../shared/definition-contracts";
import type { Database } from "./db";
import type { SkillObjectStore } from "../shared/skill-storage-contracts";
import { isStoredSkill, SkillStorage } from "./skill-storage";

export class DefinitionRepository {
  private readonly storage?: SkillStorage;
  constructor(readonly database: Database, objectStore?: SkillObjectStore, private readonly options: { legacyWrites?: boolean } = {}) { this.storage = objectStore ? new SkillStorage(objectStore) : undefined; }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data;
  }
  private id(value: string) { return this.parse(z.uuid(), value).toLowerCase(); }
  private async call<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const { rows } = await this.database.query<{ value: unknown }>(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args);
      if (rows.length !== 1) throw new Error();
      return schema.parse(rows[0].value);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && typeof error.message === "string") {
        const code = error.message;
        if (["definition_not_found", "definition_version_not_found", "workspace_not_found"].includes(code)) throw new RunServiceError(code, 404);
        if (code === "definition_forbidden") throw new RunServiceError(code, 403);
        if (["invalid_request", "invalid_owner_user_id"].includes(code)) throw new RunServiceError(code, 400);
        if (["idempotency_conflict", "definition_revision_conflict", "definition_archived", "definition_dependency_unavailable", "definition_count_limit", "definition_version_limit", "definition_quota_exceeded", "skill_save_superseded"].includes(code)) throw new RunServiceError(code, 409);
        if (["skill_storage_required", "skill_storage_integrity"].includes(code)) throw new RunServiceError(code);
      }
      throw new RunServiceError("bridge_unavailable");
    }
  }
  private async hydrate(value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (isStoredSkill(record)) {
      if (!this.storage) throw new RunServiceError("skill_storage_unavailable");
      return this.storage.hydrate(record);
    }
    const result = { ...record };
    for (const key of ["draft", "version", "content"]) if (key in result) result[key] = await this.hydrate(result[key]);
    return result;
  }
  private async hydratedCall<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    const value = await this.call(name, args, z.unknown());
    const hydrated = await this.hydrate(value);
    return schema.parse(hydrated);
  }
  list(owner: string, workspace: string, options: c.DefinitionListOptions = {}) {
    return this.call("ax_definition_list", [this.id(owner), this.id(workspace), this.parse(c.definitionListOptionsSchema, options)], c.definitionListSchema);
  }
  async get(owner: string, workspace: string, id: string) {
    const args = [this.id(owner), this.id(workspace), this.id(id)];
    const result = await this.hydratedCall("ax_definition_get", args, c.definitionDetailSchema);
    const current = await this.call("ax_definition_get", args, z.object({ definition: z.object({ can_edit: z.boolean() }) }).passthrough());
    if (result.draft !== null && !current.definition.can_edit) throw new RunServiceError("definition_forbidden", 403);
    return result;
  }
  create(owner: string, workspace: string, input: c.DefinitionCreate) {
    const value = this.parse(c.definitionCreateSchema, input);
    if (value.kind === "skill" && this.storage) return this.storage.save((name, args) => this.call(name, args, z.unknown()), this.id(owner), this.id(workspace), null, value).then(result => c.definitionMutationResultSchema.parse(result));
    if (value.kind === "skill" && !this.options.legacyWrites) throw new RunServiceError("skill_storage_unavailable");
    return this.call("ax_definition_create", [this.id(owner), this.id(workspace), value, crypto.randomUUID()], c.definitionMutationResultSchema);
  }
  updateDraft(owner: string, workspace: string, id: string, input: c.DefinitionUpdate) {
    const value = this.parse(c.definitionUpdateSchema, input);
    if (c.skillContentSchema.safeParse(value.content).success && this.storage) return this.storage.save((name, args) => this.call(name, args, z.unknown()), this.id(owner), this.id(workspace), this.id(id), { ...value, content: value.content as c.SkillContent }).then(result => c.definitionMutationResultSchema.parse(result));
    if (c.skillContentSchema.safeParse(value.content).success && !this.options.legacyWrites) throw new RunServiceError("skill_storage_unavailable");
    return this.call("ax_definition_update", [this.id(owner), this.id(workspace), this.id(id), value], c.definitionMutationResultSchema);
  }
  async publish(owner: string, workspace: string, id: string, input: c.DefinitionRevisionInput) {
    const args = [this.id(owner), this.id(workspace), this.id(id)];
    const value = this.parse(c.definitionRevisionInputSchema, input);
    if (this.storage || !this.options.legacyWrites) {
      const content = await this.call("ax_skill_publish_prepare", [...args, value], z.unknown());
      if (isStoredSkill(content)) await this.hydrate(content);
    }
    const result = await this.hydratedCall("ax_definition_publish", [...args, value, crypto.randomUUID()], c.definitionMutationResultSchema);
    if (result.version) await this.call("ax_definition_version", [args[0], args[1], result.version.id, false], z.unknown());
    return result;
  }
  archive(owner: string, workspace: string, id: string, input: c.DefinitionRevisionInput) {
    return this.call("ax_definition_archive", [this.id(owner), this.id(workspace), this.id(id), this.parse(c.definitionRevisionInputSchema, input)], c.definitionMutationResultSchema);
  }
  async getVersion(owner: string, workspace: string, id: string, options: { forUse?: boolean } = {}) {
    const value = this.parse(z.object({ forUse: z.boolean().default(false) }).strict(), options);
    const args = [this.id(owner), this.id(workspace), this.id(id), value.forUse];
    const result = await this.hydratedCall("ax_definition_version", args, c.definitionVersionSchema);
    await this.call("ax_definition_version", args, z.unknown());
    return result;
  }
}
