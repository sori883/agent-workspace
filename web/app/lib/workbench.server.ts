import { z } from "zod";
import { readConfig, type LocalConfig } from "../../server/config";
import { readLimitedText } from "../../shared/http";
import * as c from "../../shared/workbench-contracts";
import { MAX_WORKBENCH_RESPONSE_BYTES } from "../../shared/workbench-transfer";
import { MAX_RUN_REQUEST_BYTES, runErrorStatusSchema, runHttpErrorSchema } from "../../shared/run-contracts";
import { RunApiError } from "./runs.server";

export function workbenchClient(accessToken: string, workspaceId: string, config: LocalConfig = readConfig(), timeoutMs = 8000) {
  async function request<T>(path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body !== undefined && new TextEncoder().encode(body).length > MAX_RUN_REQUEST_BYTES) throw new RunApiError("body_too_large", 413);
    try {
      const response = await fetch(new URL(`/v1/workbench${path}`, config.apiOrigin), {
        method: input === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json", "X-AX-Access-Token": accessToken, "X-AX-Workspace-ID": workspaceId },
        body, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      });
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunApiError("invalid_api_response");
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_WORKBENCH_RESPONSE_BYTES));
      if (!response.ok) {
        const parsed = runHttpErrorSchema.safeParse(value);
        if (!parsed.success || !runErrorStatusSchema.safeParse(response.status).success) throw new RunApiError("invalid_api_response");
        throw new RunApiError(parsed.data.error, response.status);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new RunApiError("invalid_api_response");
      return parsed.data;
    } catch (error) { if (error instanceof RunApiError) throw error; throw new RunApiError("api_unavailable"); }
  }
  const id = (value: string) => { const parsed = z.uuid().safeParse(value); if (!parsed.success) throw new RunApiError("invalid_request", 400); return parsed.data.toLowerCase(); };
  return {
    list: (before?: string) => request(before ? `?before=${id(before)}` : "", c.workbenchListSchema),
    async get(rootId: string) { const root = await request(`/${id(rootId)}`, c.workbenchRootSchema); if (root.id !== id(rootId)) throw new RunApiError("invalid_api_response"); return root; },
    start: (input: c.WorkbenchStart) => request("", c.workbenchSubmitSchema, c.workbenchStartSchema.parse(input)),
    answer: (rootId: string, input: c.WorkbenchAnswer) => request(`/${id(rootId)}/answer`, c.workbenchSubmitSchema, c.workbenchAnswerSchema.parse(input)),
    stop: (rootId: string) => request(`/${id(rootId)}/stop`, c.workbenchMutationSchema, {}),
    recover: (rootId: string) => request(`/${id(rootId)}/recover`, c.workbenchMutationSchema, {}),
  };
}
