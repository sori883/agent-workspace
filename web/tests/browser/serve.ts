import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApi } from "../../api/app";
import { RunServiceError, type RunService } from "../../api/run-service";
import { readConfig } from "../../server/config";
import type { RunDetail, RunInput } from "../../shared/run-contracts";

process.env.INTERNAL_API_TOKEN = randomBytes(32).toString("base64url");
process.env.LOCAL_SESSION_SECRET = randomBytes(32).toString("base64url");
const config = readConfig();
const entries = new Map<string, { payload: string; detail: RunDetail; content: string }>();
function entry(runId: string) {
  const found = [...entries.values()].find((value) => value.detail.summary.run_id === runId);
  if (!found) throw new RunServiceError("run_not_found", 404);
  return found;
}
const runs: RunService = {
  async submit(input: RunInput) {
    const payload = JSON.stringify(input);
    const existing = entries.get(input.key);
    if (existing) {
      if (existing.payload !== payload) throw new RunServiceError("idempotency_conflict", 409);
      return { run_id: existing.detail.summary.run_id, replayed: true };
    }
    const run_id = `ax-run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const content = input.input_text || input.instruction;
    const adapter = input.mode === "offline" ? "offline" : "antigravity";
    const detail: RunDetail = {
      summary: { run_id, adapter, accepted_at: new Date().toISOString(), state: "running", phase: "running", resolved: false, active: true, can_recover: false, error_type: null },
      request: { schema_version: 1, run_id, adapter, instruction: input.instruction, inputs: input.input_text ? { "input.txt": input.input_text } : {}, output_name: input.output_name },
      result: null, cleanup: { egress_denied: false, suspended: false }, cleanup_errors: [],
    };
    entries.set(input.key, { payload, detail, content });
    setTimeout(() => {
      detail.summary = { ...detail.summary, state: "succeeded", phase: "finished", resolved: true, active: false };
      detail.cleanup = { egress_denied: true, suspended: true };
      detail.result = { schema_version: 1, run_id, adapter, status: "succeeded", exit_code: 0, stop_reason: "OFFLINE", usage: { total_token_count: 0 }, estimated_usd: 0, error_type: null, artifact: { name: input.output_name, size_bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") } };
    }, 700);
    return { run_id, replayed: false };
  },
  async list() { return { runs: [...entries.values()].reverse().map((value) => value.detail.summary) }; },
  async get(runId) { return entry(runId).detail; },
  async artifact(runId) { const found = entry(runId); return { name: found.detail.request.output_name, content: found.content }; },
  async recover(runId) { entry(runId); return { run_id: runId }; },
};
const api = serve({ fetch: createApi(config, undefined, runs).fetch, hostname: "127.0.0.1", port: config.apiPort });
const child = spawn(process.execPath, [realpathSync("node_modules/.bin/react-router-serve"), "build/server/index.js"], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.webPort), NODE_ENV: "production" }, stdio: "inherit",
});
function stop() { api.close(); child.kill("SIGTERM"); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => { api.close(); process.exitCode = 1; });
child.on("exit", (code) => { api.close(); process.exitCode = code ?? 0; });
