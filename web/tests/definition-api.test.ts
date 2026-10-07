import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApi } from "../api/app";
import type { DefinitionService } from "../api/definition-service";
import { RunServiceError } from "../api/run-service";
import type { DefinitionSummary, SkillContent } from "../shared/definition-contracts";
import { MAX_DEFINITION_REQUEST_BYTES } from "../shared/definition-transfer";
import { TEST_ACCESS_TOKEN, TEST_OWNER, testAuthenticate } from "./helpers/api-auth";

test("definition API resolves the owner, bounds large text, keeps revision inputs strict and denies forged scope", async () => {
  const wid = randomUUID(), id = randomUUID();
  const config = { apiOrigin: "http://127.0.0.1:3999", apiToken: "a".repeat(64) };
  const summary: DefinitionSummary = { id, workspace_id: wid, created_by_user_id: TEST_OWNER, kind: "skill", visibility: "personal", name: "sales-summary", revision: 1, can_edit: true, archived_at: null, created_at: new Date().toISOString(), latest_version: null };
  const content: SkillContent = { name: summary.name, description: "集計", instructions: "列を確かめて集計する", files: Array.from({ length: 3 }, (_, i) => ({ path: `references/sample${i}.txt`, content: "x".repeat(32768) })) };
  let calls = 0;
  function check(owner: string, workspace: string, definition?: string) { calls++; assert.equal(owner, TEST_OWNER); assert.equal(workspace, wid); if (definition && definition !== id) throw new RunServiceError("definition_not_found", 404); }
  const service: DefinitionService = {
    async list(owner, workspace, options) { check(owner, workspace); assert.equal(options?.include_archived, false); return { definitions: [summary], next_cursor: null }; },
    async get(owner, workspace, definition) { check(owner, workspace, definition); return { definition: summary, draft: { revision: 1, content }, version: null }; },
    async create(owner, workspace, input) { check(owner, workspace); assert.deepEqual(input.content, content); return { definition: summary, version: null, replayed: false }; },
    async updateDraft(owner, workspace, definition, input) { check(owner, workspace, definition); assert.equal(input.expected_revision, 1); return { definition: summary, version: null, replayed: false }; },
    async publish(owner, workspace, definition) { check(owner, workspace, definition); throw new RunServiceError("definition_dependency_unavailable", 409); },
    async archive(owner, workspace, definition) { check(owner, workspace, definition); return { definition: summary, version: null, replayed: false }; },
    async getVersion() { throw new RunServiceError("definition_version_not_found", 404); },
  };
  const app = createApi(config, undefined, undefined, undefined, testAuthenticate, undefined, undefined, undefined, service);
  const headers = { host: "127.0.0.1:3999", authorization: `Bearer ${config.apiToken}`, "X-AX-Access-Token": TEST_ACCESS_TOKEN, "X-AX-Workspace-ID": wid, "content-type": "application/json" };
  const request = (path: string, body?: unknown, extra = {}) => app.request(`${config.apiOrigin}/v1/definitions${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const input = { key: randomUUID(), kind: "skill", visibility: "personal", content };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 65536);
  assert.equal((await request("", input)).status, 200);
  const detail = await request(`/${id}`);
  assert.equal(detail.status, 200); assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.deepEqual((await detail.json()).draft.content, content);
  assert.equal((await request("?kind=skill&filter=personal&include_archived=false&limit=50")).status, 200);
  assert.equal((await request(`/${id}/draft`, { key: randomUUID(), expected_revision: 1, content })).status, 200);
  assert.equal((await request(`/${id}/publish`, { key: randomUUID(), expected_revision: 1 })).status, 409);
  const accepted = calls;
  for (const forged of [{ ...input, owner_user_id: randomUUID() }, { ...input, workspace_id: randomUUID() }, { ...input, content: { ...content, name: "bad/name" } }, { ...input, content: { ...content, files: [{ path: "../private", content: "x" }] } }]) assert.equal((await request("", forged)).status, 400);
  for (const query of ["?owner_user_id=other", "?filter=all&filter=personal", "?include_archived=1", "?limit=51", "?limit=1e1", "?before=nope"]) assert.equal((await request(query)).status, 400);
  assert.equal((await request(`/${id}/draft`, { key: randomUUID(), expected_revision: "1", content })).status, 400);
  assert.equal((await request("", { ...input, content: { ...content, instructions: "x".repeat(MAX_DEFINITION_REQUEST_BYTES) } })).status, 413);
  assert.equal((await request("", input, { "X-AX-Access-Token": "bad" })).status, 401);
  assert.equal((await request("", input, { "X-AX-Workspace-ID": "" })).status, 400);
  assert.equal((await request("", input, { origin: "http://127.0.0.1:3100" })).status, 403);
  assert.equal(calls, accepted);
  assert.equal((await request(`/${randomUUID()}`)).status, 404);
});
