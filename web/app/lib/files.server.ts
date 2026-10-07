import { z } from "zod";
import * as fc from "../../shared/file-contracts";
import { fileChunkSchema, fileChunkIndexSchema } from "../../shared/file-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES, runErrorStatusSchema, runHttpErrorSchema } from "../../shared/run-contracts";
import { readConfig, type LocalConfig } from "../../server/config";
import { RunApiError } from "./runs.server";

export function filesClient(accessToken: string, workspaceId: string, config: LocalConfig = readConfig(), timeoutMs = 8000) {
  async function request<T>(path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body && Buffer.byteLength(body) > MAX_RUN_REQUEST_BYTES) throw new RunApiError("request_too_large", 413);
    try {
      const response = await fetch(new URL(`/v1/files${path}`, config.apiOrigin), {
        method: input === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json", "X-AX-Access-Token": accessToken, "X-AX-Workspace-ID": workspaceId },
        body, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunApiError("invalid_api_response");
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_RUN_RESPONSE_BYTES));
      if (!response.ok) {
        const error = runHttpErrorSchema.safeParse(value);
        if (!error.success || !runErrorStatusSchema.safeParse(response.status).success) throw new RunApiError("invalid_api_response");
        throw new RunApiError(error.data.error, response.status);
      }
      return schema.parse(value);
    } catch (error) {
      if (error instanceof RunApiError) throw error;
      throw new RunApiError("api_unavailable");
    }
  }
  const id = (value: string) => z.uuid().parse(value);
  return {
    list: (before?: string) => request(before ? `?before=${id(before)}` : "", fc.fileListSchema),
    get: async (fileId: string) => {
      const file = await request(`/${id(fileId)}`, fc.fileInfoSchema);
      if (file.id !== fileId) throw new RunApiError("invalid_api_response");
      return file;
    },
    begin: (input: z.infer<typeof fc.fileBeginSchema>) => request("", fc.fileWriteResultSchema, fc.fileBeginSchema.parse(input)),
    putChunk: (fileId: string, index: number, content: string) => request(`/${id(fileId)}/chunks/${fileChunkIndexSchema.parse(index)}`, fc.fileMutationSchema, fileChunkSchema.parse({ content_base64: content })),
    readChunk: (fileId: string, index: number) => request(`/${id(fileId)}/chunks/${fileChunkIndexSchema.parse(index)}`, fileChunkSchema),
    seal: (fileId: string) => request(`/${id(fileId)}/seal`, fc.fileWriteResultSchema, {}),
    cancel: (fileId: string) => request(`/${id(fileId)}/cancel`, fc.fileMutationSchema, {}),
    cancelUnavailable: () => request("/cancel-unavailable", fc.fileCancelUnavailableSchema, {}),
  };
}
