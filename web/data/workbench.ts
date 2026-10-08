import { z } from "zod";
import { RunServiceError } from "../api/run-service";
import type { Database } from "./db";
import * as c from "../shared/workbench-contracts";
import { hex } from "./canonical";

export class WorkbenchRepository {
  constructor(readonly database: Database) {}
  private parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new RunServiceError("invalid_request", 400); return result.data; }
  private id(value: string) { return this.parse(z.uuid(), value).toLowerCase(); }
  private run() { return `ax-run-${hex(crypto.getRandomValues(new Uint8Array(8)))}`; }
  private async call<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const { rows } = await this.database.query<{value: unknown}>(`SELECT ${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) AS value`, args);
      if (rows.length !== 1) throw new Error();
      return schema.parse(rows[0].value);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && typeof error.message === "string") {
        const code = error.message;
        if (["workbench_not_found", "workspace_not_found", "file_not_found", "definition_not_found", "definition_version_not_found"].includes(code)) throw new RunServiceError(code, 404);
        if (["workspace_forbidden", "workspace_access_revoked", "definition_forbidden"].includes(code)) throw new RunServiceError(code, 403);
        if (["invalid_request", "invalid_owner_user_id", "model_not_allowed", "agent_selection_disabled", "skill_context_too_large"].includes(code)) throw new RunServiceError(code, 400);
        if (["admission_closed", "workbench_disabled", "python_disabled", "invalid_run_ledger"].includes(code)) throw new RunServiceError(code, 503);
        if (["idempotency_conflict", "agent_answer_conflict", "agent_stopped", "agent_grant_expired", "agent_grant_revoked", "agent_budget_exhausted", "pilot_estimate_limit_reached", "unresolved_run", "unknown_paid_usage", "paid_failure_requires_review", "failed_request_already_attempted", "file_not_ready", "file_quota_exceeded", "definition_archived", "definition_dependency_unavailable"].includes(code)) throw new RunServiceError(code, 409);
      }
      throw new RunServiceError("bridge_unavailable");
    }
  }
  start(owner: string, workspace: string, input: c.WorkbenchStart, expires: number, tokenFingerprint: string) { return this.call("ax_workbench_start", [this.id(owner), this.id(workspace), this.parse(c.workbenchStartSchema,input), this.run(), expires, tokenFingerprint], c.workbenchSubmitSchema); }
  answer(owner: string, workspace: string, root: string, input: c.WorkbenchAnswer, expires: number, tokenFingerprint: string) { return this.call("ax_workbench_answer", [this.id(owner), this.id(workspace), this.id(root), this.parse(c.workbenchAnswerSchema,input), this.run(), expires, tokenFingerprint], c.workbenchSubmitSchema); }
  list(owner: string, workspace: string, before: string | null = null) { return this.call("ax_workbench_list", [this.id(owner), this.id(workspace), before === null ? null : this.id(before)], c.workbenchListSchema); }
  get(owner: string, workspace: string, root: string) { return this.call("ax_workbench_get", [this.id(owner), this.id(workspace), this.id(root)], c.workbenchRootSchema); }
  stop(owner: string, workspace: string, root: string) { return this.call("ax_workbench_stop", [this.id(owner), this.id(workspace), this.id(root)], c.workbenchMutationSchema); }
  recover(owner: string, workspace: string, root: string) { return this.call("ax_workbench_request_recovery", [this.id(owner), this.id(workspace), this.id(root)], c.workbenchMutationSchema); }
}
