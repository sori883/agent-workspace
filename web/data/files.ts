import { z } from "zod";
import { fileBeginSchema, fileCancelUnavailableSchema, fileInfoSchema, fileListSchema, fileMutationSchema, fileWriteResultSchema, WORK_FILE_CHUNK_BYTES, type FileBegin } from "../shared/file-contracts";
import { RunServiceError } from "../api/run-service";
import type { Database } from "./db";
import { unhex } from "./canonical";

export class FileRepository {
  constructor(readonly database: Database) {}
  private async call<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const { rows } = await this.database.query<{ value: unknown }>(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args);
      if (rows.length !== 1) throw new Error();
      return schema.parse(rows[0].value);
    } catch (error) {
      if (error instanceof RunServiceError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && typeof error.message === "string") {
        const code = error.message;
        if (["file_not_found", "workspace_not_found"].includes(code)) throw new RunServiceError(code, 404);
        if (["workspace_forbidden", "workspace_access_revoked"].includes(code)) throw new RunServiceError(code, 403);
        if (["invalid_request", "invalid_owner_user_id", "invalid_file_chunk"].includes(code)) throw new RunServiceError(code, 400);
        if (["file_not_ready", "file_cancelled", "file_already_ready", "file_incomplete", "file_hash_mismatch", "file_chunk_conflict", "file_draft_limit", "file_quota_exceeded", "idempotency_conflict"].includes(code)) throw new RunServiceError(code, 409);
      }
      throw new RunServiceError("bridge_unavailable");
    }
  }
  private id(value: string) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data.toLowerCase();
  }
  begin(owner: string, workspace: string, input: FileBegin) {
    const parsed = fileBeginSchema.safeParse(input);
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return this.call("ax_file_begin", [this.id(owner), this.id(workspace), parsed.data, crypto.randomUUID()], fileWriteResultSchema);
  }
  list(owner: string, workspace: string, options: { before?: string; limit?: number } = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RunServiceError("invalid_request", 400);
    return this.call("ax_file_list", [this.id(owner), this.id(workspace), options.before === undefined ? null : this.id(options.before), limit], fileListSchema);
  }
  get(owner: string, workspace: string, file: string) {
    return this.call("ax_file_get", [this.id(owner), this.id(workspace), this.id(file)], fileInfoSchema);
  }
  putChunk(owner: string, workspace: string, file: string, index: number, bytes: Uint8Array) {
    if (!Number.isInteger(index) || index < 0 || index >= 256 || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > WORK_FILE_CHUNK_BYTES) throw new RunServiceError("invalid_file_chunk", 400);
    return this.call("ax_file_chunk", [this.id(owner), this.id(workspace), this.id(file), index, bytes], fileMutationSchema);
  }
  async readChunk(owner: string, workspace: string, file: string, index: number): Promise<Uint8Array> {
    if (!Number.isInteger(index) || index < 0 || index >= 256) throw new RunServiceError("invalid_file_chunk", 400);
    const value = await this.call("ax_file_read_chunk", [this.id(owner), this.id(workspace), this.id(file), index], z.string().regex(/^(?:[0-9a-f]{2})+$/).max(WORK_FILE_CHUNK_BYTES * 2));
    return unhex(value);
  }
  seal(owner: string, workspace: string, file: string) {
    return this.call("ax_file_seal", [this.id(owner), this.id(workspace), this.id(file)], fileWriteResultSchema);
  }
  cancelUnavailable(owner: string, currentWorkspace: string) {
    return this.call("ax_file_cancel_unavailable", [this.id(owner), this.id(currentWorkspace)], fileCancelUnavailableSchema);
  }
  cancel(owner: string, workspace: string, file: string) {
    return this.call("ax_file_cancel", [this.id(owner), this.id(workspace), this.id(file)], fileMutationSchema);
  }
}
