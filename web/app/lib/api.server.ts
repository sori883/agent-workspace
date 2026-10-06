import { checkResultSchema, statusSchema, type CheckInput } from "../../shared/contracts";
import { readLimitedText } from "../../shared/http";
import { readConfig, type LocalConfig } from "../../server/config";

export class ApiUnavailable extends Error {}

export function apiClient(config: LocalConfig = readConfig(), timeoutMs = 3000) {
  async function request(path: string, input?: CheckInput): Promise<unknown> {
    try {
      const response = await fetch(new URL(path, config.apiOrigin), {
        method: input ? "POST" : "GET",
        headers: { authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        body: input ? JSON.stringify(input) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error("API request failed.");
      return JSON.parse(await readLimitedText(response));
    } catch {
      throw new ApiUnavailable("接続先に応答がありません。しばらくしてから、もう一度お試しください。");
    }
  }
  return {
    async status() {
      const result = statusSchema.safeParse(await request("/v1/status"));
      if (!result.success) throw new ApiUnavailable("接続先の応答を確認できませんでした。");
      return result.data;
    },
    async check(input: CheckInput) {
      const result = checkResultSchema.safeParse(await request("/v1/connection-check", input));
      if (!result.success) throw new ApiUnavailable("接続先の応答を確認できませんでした。");
      return result.data;
    },
  };
}
