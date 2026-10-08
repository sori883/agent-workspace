import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApi } from "../api/app";
import type { WorkbenchService } from "../api/workbench-service";
import { RunServiceError } from "../api/run-service";
import type { WorkbenchRoot } from "../shared/workbench-contracts";
import { TEST_ACCESS_TOKEN, TEST_OWNER, testAuthenticate } from "./helpers/api-auth";

test("workbench API binds owner/workspace/grant and strictly separates v2 requests", async () => {
  const wid = randomUUID(), id = randomUUID(), run = "ax-run-0123456789abcdef", key = randomUUID(), token = "b".repeat(64), expires = Math.floor(Date.now() / 1000) + 600;
  const config = { apiOrigin: "http://127.0.0.1:3999", apiToken: "a".repeat(64) };
  const root: WorkbenchRoot = { id, protocol_version: 2, state: "waiting_input", revision: 2, current_run_id: run, stage: "runtime", mode: "preview", question_id: randomUUID(), question: "対象列は？", can_answer: true, stop_requested: false, model_calls: 1, tool_calls: 1, python_calls: 0, active_ms: 50, estimated_usd: 0, reserved_usd: 0, input_files: [], output_files: [], checkpoints: [], messages: [{ run_id: run, kind: "user_start", text: "CSVの合計" }] };
  let calls = 0;
  function check(owner: string, workspace: string, rootId?: string) { calls++; assert.equal(owner, TEST_OWNER); assert.equal(workspace, wid); if (rootId && rootId !== id) throw new RunServiceError("workbench_not_found", 404); }
  const submit = { root_id: id, run_id: run, replayed: false, protocol_version: 2 as const };
  const service: WorkbenchService = {
    async list(owner, workspace) { check(owner, workspace); return { roots: [root], next_cursor: null }; },
    async get(owner, workspace, rootId) { check(owner, workspace, rootId); return root; },
    async start(owner, workspace, input, exp, fingerprint) { check(owner, workspace); assert.equal(input.mode, "preview"); assert.deepEqual(input.input_file_ids, []); assert.equal(exp, expires); assert.equal(fingerprint, token); return submit; },
    async answer(owner, workspace, rootId, input, exp, fingerprint) { check(owner, workspace, rootId); assert.equal(input.expected_revision, 2); assert.equal(exp, expires); assert.equal(fingerprint, token); return submit; },
    async stop(owner, workspace, rootId) { check(owner, workspace, rootId); return { ok: true }; },
    async recover(owner, workspace, rootId) { check(owner, workspace, rootId); return { ok: true }; },
  };
  const authenticate = async (value: string) => ({ ownerUserId: await testAuthenticate(value), expiresAt: expires, tokenFingerprint: token });
  const app = createApi(config, undefined, undefined, undefined, authenticate, undefined, undefined, undefined, undefined, service);
  const headers = { host: "127.0.0.1:3999", authorization: `Bearer ${config.apiToken}`, "X-AX-Access-Token": TEST_ACCESS_TOKEN, "X-AX-Workspace-ID": wid, "content-type": "application/json" };
  const request = (path: string, body?: unknown, extra = {}) => app.request(`${config.apiOrigin}/v1/workbench${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await request("", { key, text: "集計" }); assert.equal(result.status, 202); assert.equal(result.headers.get("cache-control"), "no-store"); assert.deepEqual(await result.json(), submit);
  assert.deepEqual(await (await request(`/${id}`)).json(), root);
  assert.equal((await request("")).status, 200);
  assert.equal((await request(`/${id}/answer`, { key: randomUUID(), question_id: root.question_id, expected_revision: 2, text: "amount" })).status, 202);
  assert.equal((await request(`/${id}/stop`, {})).status, 200);
  assert.equal((await request(`/${id}/recover`, {})).status, 200);
  const accepted = calls;
  for (const change of [{ owner_user_id: randomUUID() }, { workspace_id: randomUUID() }, { execution_policy: "unlimited" }, { mode: "model" }, { input_file_ids: Array.from({ length: 5 }, () => randomUUID()) }, { agent_version_id: randomUUID(), skill_version_ids: [randomUUID()] }, { builtin_skill_ids: ["unknown"] }, { builtin_skill_ids: ["tabular-v1", "tabular-v1"] }, { skill_version_ids: Array.from({ length: 8 }, () => randomUUID()), builtin_skill_ids: ["tabular-v1"] }, { agent_version_id: randomUUID(), builtin_skill_ids: ["general-v1"] }]) assert.equal((await request("", { key, text: "集計", ...change })).status, 400);
  for (const path of ["?before=bad", "?before="+randomUUID()+"&before="+randomUUID(), "?owner=forged"]) assert.equal((await request(path)).status, 400);
  assert.equal((await request(`/${id}/answer`, { key, question_id: root.question_id, expected_revision: "2", text: "amount" })).status, 400);
  assert.equal((await request(`/${id}/stop`, { run_id: run })).status, 400);
  assert.equal((await request("", { key, text: "集計" }, { "X-AX-Workspace-ID": "" })).status, 400);
  assert.equal((await request("", { key, text: "集計" }, { "X-AX-Access-Token": "bad" })).status, 401);
  assert.equal((await request("", { key, text: "集計" }, { origin: "http://127.0.0.1:3100" })).status, 403);
  assert.equal(calls, accepted);
  assert.equal((await request(`/${randomUUID()}`)).status, 404);
});
