import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApi } from "../api/app";
import type { FileService } from "../api/file-service";
import { RunServiceError } from "../api/run-service";
import { decodeFileChunk, encodeFileChunk, fileChunkSchema } from "../shared/file-transfer";
import { WORK_FILE_CHUNK_BYTES, type FileInfo } from "../shared/file-contracts";
import { TEST_ACCESS_TOKEN, TEST_OWNER, testAuthenticate } from "./helpers/api-auth";

test("file HTTP boundaries keep owner server-resolved and binary chunks bounded and exact", async () => {
  const workspace = randomUUID(), id = randomUUID();
  const config = { apiOrigin: "http://127.0.0.1:3999", apiToken: "a".repeat(64) };
  const bytes = Uint8Array.from({ length: WORK_FILE_CHUNK_BYTES }, (_, index) => index % 256);
  const info: FileInfo = { id, name: "月次.xlsx", size_bytes: bytes.length, sha256: "a".repeat(64), media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", state: "ready", chunk_size: WORK_FILE_CHUNK_BYTES, chunk_count: 1, received_chunks: 1, created_at: new Date().toISOString(), ready_at: new Date().toISOString() };
  let calls = 0;
  function access(owner: string, wid: string, fileId?: string) { calls++; assert.equal(owner, TEST_OWNER); assert.equal(wid, workspace); if (fileId !== undefined && fileId !== id) throw new RunServiceError("file_not_found", 404); }
  const files: FileService = {
    async begin(owner, wid) { access(owner, wid); return { file: info, replayed: false }; },
    async list(owner, wid) { access(owner, wid); return { files: [info], next_cursor: null }; },
    async get(owner, wid, fileId) { access(owner, wid, fileId); return info; },
    async putChunk(owner, wid, fileId, index, value) { access(owner, wid, fileId); assert.equal(index, 0); assert.deepEqual(value, bytes); return { ok: true, replayed: false }; },
    async readChunk(owner, wid, fileId, index) { access(owner, wid, fileId); assert.equal(index, 0); return bytes; },
    async seal(owner, wid, fileId) { access(owner, wid, fileId); return { file: info, replayed: false }; },
    async cancel(owner, wid, fileId) { access(owner, wid, fileId); return { ok: true, replayed: false }; },
    async cancelUnavailable(owner, wid) { access(owner, wid); return { cancelled_count: 0 }; },
  };
  const app = createApi(config, undefined, undefined, undefined, testAuthenticate, undefined, undefined, files);
  const headers = { host: "127.0.0.1:3999", authorization: `Bearer ${config.apiToken}`, "X-AX-Access-Token": TEST_ACCESS_TOKEN, "X-AX-Workspace-ID": workspace, "content-type": "application/json" };
  const request = (path: string, body?: unknown, extra = {}) => app.request(`${config.apiOrigin}/v1/files${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const input = { key: randomUUID(), name: info.name, size_bytes: info.size_bytes, sha256: info.sha256 };
  assert.equal((await request("", input)).status, 200);
  assert.equal((await request(`/${id}/chunks/0`, { content_base64: encodeFileChunk(bytes) })).status, 200);
  const read = await request(`/${id}/chunks/0`);
  assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(decodeFileChunk((await read.json()).content_base64), bytes);
  const recovered = await request("/cancel-unavailable", {});
  assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { cancelled_count: 0 });
  const accepted = calls;
  for (const body of [{ ...input, owner_user_id: randomUUID() }, { ...input, workspace_id: randomUUID() }, { ...input, size_bytes: 8 * 1024 * 1024 + 1 }]) assert.equal((await request("", body)).status, 400);
  for (const path of [`/${id}/chunks/-1`, `/${id}/chunks/256`, `/${id}/chunks/00`, "?before=bad", `?before=${id}&before=${id}`, "?owner_user_id=forged"]) assert.equal((await request(path)).status, 400);
  for (const content of ["A", "YQ", "YQ==\n", "YR==", "" ]) assert.equal((await request(`/${id}/chunks/0`, { content_base64: content })).status, 400);
  assert.equal((await request(`/${id}/chunks/0`, { content_base64: "a".repeat(65536) })).status, 413);
  assert.equal((await request("", input, { "X-AX-Workspace-ID": "" })).status, 400);
  assert.equal((await request("", input, { "X-AX-Access-Token": "bad" })).status, 401);
  assert.equal((await request("", input, { origin: "http://127.0.0.1:3100" })).status, 403);
  assert.equal(calls, accepted);
  assert.equal((await request(`/${randomUUID()}`)).status, 404);
  assert.equal(fileChunkSchema.safeParse({ content_base64: btoa("x".repeat(WORK_FILE_CHUNK_BYTES + 1)) }).success, false);
});
