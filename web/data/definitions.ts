import { z } from "zod";
import { RunServiceError } from "../api/run-service";
import * as c from "../shared/definition-contracts";
import type { Database } from "./db";

export class DefinitionRepository {
  constructor(readonly database: Database) {}
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
        if (["idempotency_conflict", "definition_revision_conflict", "definition_archived", "definition_dependency_unavailable", "definition_count_limit", "definition_version_limit", "definition_quota_exceeded"].includes(code)) throw new RunServiceError(code, 409);
      }
      throw new RunServiceError("bridge_unavailable");
    }
  }
  list(owner: string, workspace: string, options: c.DefinitionListOptions = {}) {
    return this.call("ax_definition_list", [this.id(owner), this.id(workspace), this.parse(c.definitionListOptionsSchema, options)], c.definitionListSchema);
  }
  get(owner: string, workspace: string, id: string) {
    return this.call("ax_definition_get", [this.id(owner), this.id(workspace), this.id(id)], c.definitionDetailSchema);
  }
  create(owner: string, workspace: string, input: c.DefinitionCreate) {
    return this.call("ax_definition_create", [this.id(owner), this.id(workspace), this.parse(c.definitionCreateSchema, input), crypto.randomUUID()], c.definitionMutationResultSchema);
  }
  updateDraft(owner: string, workspace: string, id: string, input: c.DefinitionUpdate) {
    return this.call("ax_definition_update", [this.id(owner), this.id(workspace), this.id(id), this.parse(c.definitionUpdateSchema, input)], c.definitionMutationResultSchema);
  }
  publish(owner: string, workspace: string, id: string, input: c.DefinitionRevisionInput) {
    return this.call("ax_definition_publish", [this.id(owner), this.id(workspace), this.id(id), this.parse(c.definitionRevisionInputSchema, input), crypto.randomUUID()], c.definitionMutationResultSchema);
  }
  archive(owner: string, workspace: string, id: string, input: c.DefinitionRevisionInput) {
    return this.call("ax_definition_archive", [this.id(owner), this.id(workspace), this.id(id), this.parse(c.definitionRevisionInputSchema, input)], c.definitionMutationResultSchema);
  }
  getVersion(owner: string, workspace: string, id: string, options: { forUse?: boolean } = {}) {
    const value = this.parse(z.object({ forUse: z.boolean().default(false) }).strict(), options);
    return this.call("ax_definition_version", [this.id(owner), this.id(workspace), this.id(id), value.forUse], c.definitionVersionSchema);
  }
}
