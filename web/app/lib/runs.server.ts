import { z } from "zod";
import { readConfig, type LocalConfig } from "../../server/config";
import { readLimitedText } from "../../shared/http";
import { artifactResultSchema, MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES, recoverResultSchema, runDetailSchema, runErrorStatusSchema, runHttpErrorSchema, runIdSchema, runInputSchema, runListSchema, submitResultSchema, type RunInput } from "../../shared/run-contracts";

export class RunApiError extends Error {
  constructor(public readonly code: string, public readonly status: number = 503) { super(code); }
}

export function runsClient(config: LocalConfig = readConfig(), timeoutMs = 8000) {
  async function request<T>(path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body !== undefined && Buffer.byteLength(body) > MAX_RUN_REQUEST_BYTES) throw new RunApiError("body_too_large", 413);
    try {
      const response = await fetch(new URL(path, config.apiOrigin), {
        method: input === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        body, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunApiError("invalid_api_response");
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_RUN_RESPONSE_BYTES));
      if (!response.ok) {
        const parsed = runHttpErrorSchema.safeParse(value);
        if (!parsed.success || !runErrorStatusSchema.safeParse(response.status).success) throw new RunApiError("invalid_api_response");
        throw new RunApiError(parsed.data.error, response.status);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new RunApiError("invalid_api_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof RunApiError) throw error;
      throw new RunApiError("api_unavailable");
    }
  }
  function idPath(runId: string) {
    if (!runIdSchema.safeParse(runId).success) throw new RunApiError("invalid_run_id", 400);
    return `/v1/runs/${runId}`;
  }
  return {
    list: () => request("/v1/runs", runListSchema),
    get: (runId: string) => request(idPath(runId), runDetailSchema).then((detail) => {
      if (detail.summary.run_id !== runId) throw new RunApiError("invalid_api_response");
      return detail;
    }),
    submit(input: RunInput) {
      const parsed = runInputSchema.safeParse(input);
      if (!parsed.success) throw new RunApiError("invalid_request", 400);
      return request("/v1/runs", submitResultSchema, parsed.data);
    },
    artifact: (runId: string) => request(`${idPath(runId)}/artifact`, artifactResultSchema),
    recover: (runId: string) => request(`${idPath(runId)}/recover`, recoverResultSchema, {}).then((result) => {
      if (result.run_id !== runId) throw new RunApiError("invalid_api_response");
      return result;
    }),
  };
}
