import { z } from "zod";
import * as dc from "../../shared/definition-contracts";
import { MAX_DEFINITION_REQUEST_BYTES } from "../../shared/definition-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_RESPONSE_BYTES, runErrorStatusSchema, runHttpErrorSchema } from "../../shared/run-contracts";
import { readConfig, type LocalConfig } from "../../server/config";
import { RunApiError } from "./runs.server";

export function definitionsClient(accessToken: string, workspaceId: string, config: LocalConfig = readConfig(), timeoutMs = 8000) {
  async function request<T>(path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body && Buffer.byteLength(body) > MAX_DEFINITION_REQUEST_BYTES) throw new RunApiError("request_too_large", 413);
    try {
      const response = await fetch(new URL(`/v1/${path}`, config.apiOrigin), {
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
  const id = (value: string) => z.uuid().parse(value).toLowerCase();
  return {
    list: (options: dc.DefinitionListOptions = {}) => {
      const values = dc.definitionListOptionsSchema.parse(options);
      const query = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)]));
      return request(`definitions?${query}`, dc.definitionListSchema);
    },
    get: async (definitionId: string) => {
      const value = await request(`definitions/${id(definitionId)}`, dc.definitionDetailSchema);
      if (value.definition.id !== id(definitionId)) throw new RunApiError("invalid_api_response");
      return value;
    },
    getVersion: async (versionId: string) => {
      const value = await request(`definition-versions/${id(versionId)}`, dc.definitionVersionSchema);
      if (value.id !== id(versionId)) throw new RunApiError("invalid_api_response");
      return value;
    },
    create: (input: dc.DefinitionCreate) => request("definitions", dc.definitionMutationResultSchema, dc.definitionCreateSchema.parse(input)),
    update: (definitionId: string, input: dc.DefinitionUpdate) => request(`definitions/${id(definitionId)}/draft`, dc.definitionMutationResultSchema, dc.definitionUpdateSchema.parse(input)),
    publish: (definitionId: string, input: dc.DefinitionRevisionInput) => request(`definitions/${id(definitionId)}/publish`, dc.definitionMutationResultSchema, dc.definitionRevisionInputSchema.parse(input)),
    archive: (definitionId: string, input: dc.DefinitionRevisionInput) => request(`definitions/${id(definitionId)}/archive`, dc.definitionMutationResultSchema, dc.definitionRevisionInputSchema.parse(input)),
  };
}
