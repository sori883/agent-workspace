import { z } from "zod";
import { readConfig, type LocalConfig } from "../../server/config";
import { readLimitedText } from "../../shared/http";
import { chatInputSchema, chatSubmitResultSchema, conversationDetailSchema, conversationIdSchema, conversationListSchema, MAX_CHAT_RESPONSE_BYTES, type ChatInput } from "../../shared/chat-contracts";
import { MAX_RUN_REQUEST_BYTES, runErrorStatusSchema, runHttpErrorSchema } from "../../shared/run-contracts";
import { RunApiError } from "./runs.server";

export { RunApiError };

export function chatsClient(config: LocalConfig = readConfig(), timeoutMs = 8000) {
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
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_CHAT_RESPONSE_BYTES));
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
  function validId(id: string) {
    const parsed = conversationIdSchema.safeParse(id);
    if (!parsed.success) throw new RunApiError("invalid_conversation_id", 400);
    return parsed.data;
  }
  return {
    list: () => request("/v1/conversations", conversationListSchema),
    async get(id: string) {
      id = validId(id);
      const detail = await request(`/v1/conversations/${id}`, conversationDetailSchema);
      if (detail.conversation.id !== id) throw new RunApiError("invalid_api_response");
      return detail;
    },
    async submit(id: string, input: ChatInput) {
      id = validId(id);
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) throw new RunApiError("invalid_request", 400);
      const result = await request(`/v1/conversations/${id}/turns`, chatSubmitResultSchema, parsed.data);
      if (result.conversation_id !== id) throw new RunApiError("invalid_api_response");
      return result;
    },
  };
}
