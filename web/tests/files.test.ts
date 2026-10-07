import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { FileRepository } from "../data/files";
import { DataRepository } from "../data/repository";
import { WorkspaceRepository } from "../data/workspaces";
import { apiFunctions } from "../data/permissions";
import { fileBeginSchema, fileInfoSchema, fileWriteResultSchema, WORK_FILE_CHUNK_BYTES, MAX_WORK_FILE_BYTES } from "../shared/file-contracts";
import { RunServiceError } from "../api/run-service";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { prepareTestAuth } from "./prepare-auth";

const schema = `files_test_${randomBytes(8).toString("hex")}`;
const owner = randomUUID(), other = randomUUID(), stranger = randomUUID();
let pool: pg.Pool, admin: pg.Pool, connection: pg.PoolConfig, files: FileRepository, org: WorkspaceRepository, workspace: string, second: string;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const input = (bytes: Uint8Array, name = "売上.xlsx") => ({ key: randomUUID(), name, size_bytes: bytes.length, sha256: hash(bytes) });
const denied = (code: string) => (error: unknown) => error instanceof RunServiceError && error.code === code;
const sqlDenied = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
const call = async (name: string, args: unknown[] = []) => (await pool.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args)).rows[0].value;
before(async () => {
  const { caPath, ...database } = prepareTestAuth().database;
  connection = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 12, statement_timeout: 10000 };
  admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  await migrateAuth(pool); await migrateData(pool); await migrateData(pool);
  await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','A'),($2,'active','B'),($3,'active','C')", [owner, other, stranger]);
  org = new WorkspaceRepository(pool); files = new FileRepository(pool);
  workspace = (await org.create(owner, { key: randomUUID(), name: "A" })).workspace.id;
  second = (await org.create(owner, { key: randomUUID(), name: "B" })).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'admin','general')", [workspace, other]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE ax_files CASCADE");
  await pool.query("UPDATE users SET status='active'");
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'admin','general') ON CONFLICT DO NOTHING", [workspace, other]);
});
after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
async function upload(bytes: Uint8Array, name = "売上.xlsx", actor = owner, wid = workspace) {
  const accepted = await files.begin(actor, wid, input(bytes, name));
  for (let index = 0; index < accepted.file.chunk_count; index++) await files.putChunk(actor, wid, accepted.file.id, index, bytes.slice(index * WORK_FILE_CHUNK_BYTES, (index + 1) * WORK_FILE_CHUNK_BYTES));
  return files.seal(actor, wid, accepted.file.id);
}
async function read(id: string, actor = owner, wid = workspace) {
  const file = await files.get(actor, wid, id); const bytes = new Uint8Array(file.size_bytes);
  for (let index = 0; index < file.chunk_count; index++) bytes.set(await files.readChunk(actor, wid, id, index), index * file.chunk_size);
  return bytes;
}

test("binary upload, reordered chunks, stable hash and immutable ready file round-trip", async () => {
  const bytes = new Uint8Array(randomBytes(WORK_FILE_CHUNK_BYTES * 2 + 71)); bytes[0] = 0; bytes[1] = 255;
  const request = input(bytes), accepted = fileWriteResultSchema.parse(await call("ax_file_begin", [owner, workspace, request, randomUUID()])), id = accepted.file.id;
  assert.equal(accepted.file.state, "uploading"); assert.equal(accepted.file.received_chunks, 0);
  await assert.rejects(files.readChunk(owner, workspace, id, 0), denied("file_not_ready"));
  for (const index of [2, 0, 1]) assert.equal((await files.putChunk(owner, workspace, id, index, bytes.slice(index * WORK_FILE_CHUNK_BYTES, (index + 1) * WORK_FILE_CHUNK_BYTES))).replayed, false);
  const sealed = await files.seal(owner, workspace, id); assert.equal(sealed.file.state, "ready"); assert.equal(sealed.file.received_chunks, 3); assert.equal(sealed.file.sha256, hash(bytes));
  assert.deepEqual(await read(id), bytes);
  assert.equal((await files.seal(owner, workspace, id)).replayed, true);
  assert.equal((await files.begin(owner, workspace, request)).file.id, id);
  assert.equal((await files.putChunk(owner, workspace, id, 0, bytes.slice(0, WORK_FILE_CHUNK_BYTES))).replayed, true);
  await assert.rejects(files.putChunk(owner, workspace, id, 0, new Uint8Array(WORK_FILE_CHUNK_BYTES)), denied("file_chunk_conflict"));
  await assert.rejects(files.cancel(owner, workspace, id), denied("file_already_ready"));
  await assert.rejects(pool.query("UPDATE ax_files SET name='changed.csv' WHERE id=$1", [id]), sqlDenied("immutable_file"));
  await assert.rejects(pool.query("UPDATE ax_file_chunks SET content=$2 WHERE file_id=$1", [id, new Uint8Array([1])]), sqlDenied("immutable_file"));
  await assert.rejects(pool.query("DELETE FROM ax_file_chunks WHERE file_id=$1", [id]), sqlDenied("immutable_file"));
});

test("CSV bytes including Unicode and line endings are preserved; storage does not parse extensions", async () => {
  const csv = new TextEncoder().encode("部門,金額\r\n開発,1234\r\n総務,56\r\n");
  const ready = await upload(csv, "報告.CSV"); assert.equal(ready.file.media_type, "text/csv"); assert.deepEqual(await read(ready.file.id), csv);
  const xlsx = new Uint8Array(Buffer.from("UEsDBBQAAAAIAAAAIVC5Fh4k0AAAAL4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbK2Ru27DMAxFf8XQWkRMM2QobC9t16ZDfoCV6ViwXhCZ1Pn7yOpj6NQCnQiJh/cQYHu8JuJm8S5wpyaR9ADAZiKPrGOiUDpjzB6lPPMJEpoZTwS77XYPJgahIBtZM1TfPtGIZyfN81K+2cbQqUyOVfP4Aa6uTmFKzhqU0odLGH5YNp8GXSYrw5NNfFcABX17uFDOdqDmFbO8oC9xsDh4j3l+i3HWK/YnWxxHa2iI5uzLiOaUCQeeiMQ7Xav2aMMv/BVmqOX+nxf5zv/aA+rZ+htQSwMEFAAAAAgAAAAhUP5bhnKKAAAA8AAAAAsAAABfcmVscy8ucmVsc43PMQ7CMAwF0KtUPkBdGBhQ2omlK+ICJnXaqk0cOUGU25OxIAZG63+9L5srr5RnCWmaY6o2v4bUwpRzPCMmO7GnVEvkUBIn6imXU0eMZBcaGY9Nc0LdG9CZvVn1QwvaDweobq/I/9ji3Gz5IvbhOeQfE1+NIpOOnFvYVnyKLneRpS4oYGfw48HuDVBLAwQUAAAACAAAACFQb8qSYZIAAADkAAAADwAAAHhsL3dvcmtib29rLnhtbI2PMQ6DMAxFrxL5ADV06ICAqQt7L5CCaSKSOLKD2uMXQdk72f9/+X25fbMsT+bFfGJI2oErJTeIOjqKVi+cKW3JzBJt2aS8ULOQndQRlRjwWlU3jNYnOAiN/MPgefYj3XlcI6VyQISCLZ6TOp8V+nZv0N80yUbq4MHFBgWze8PUQQ1GGr8tMkw1YN/ieYbnZ/0XUEsDBBQAAAAIAAAAIVC2VKrPjgAAAPEAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHONzz0OwjAMBeCrVDlA3TIwoCYTS1fEBaLUbaI2P7KNgNsTMaAiMTBZfpa+Jw8X3KyEnNiHws0jbom18iLlBMDOY7Tc5oKpXuZM0UpdaYFi3WoXhEPXHYH2hjLD3mzGSSsap14112fBf+w8z8HhObtbxCQ/KuCeaWWPKBW1tKBo9YkY3qNvq6rADPD1oXkBUEsDBBQAAAAIAAAAIVDVZd+nfwAAALEAAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sTY7dDoIwDEZfhewBLKByYcYSjS/SzOmM7CddAzw+BQ3xpvl6Tr6mekr0Kd45ruYwxNIrz5wvAMV6F7AcUnZRzDNRQJaVXlAyOXxspTBAW9cdBHxHZfTG7shoNKWpol41Qu0armsaTdMeTxpGo8H+xO0rzt2OQboy/47B/qVZAFBLAQIUAxQAAAAIAAAAIVC5Fh4k0AAAAL4BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAAAAhUP5bhnKKAAAA8AAAAAsAAAAAAAAAAAAAAIABAQEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAAAAhUG/KkmGSAAAA5AAAAA8AAAAAAAAAAAAAAIABtAEAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAIAAAAIVC2VKrPjgAAAPEAAAAaAAAAAAAAAAAAAACAAXMCAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUAxQAAAAIAAAAIVDVZd+nfwAAALEAAAAYAAAAAAAAAAAAAACAATkDAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAUABQBFAQAA7gMAAAAA", "base64"));
  assert.deepEqual(await read((await upload(xlsx, "fixture.xlsx")).file.id), xlsx);
  const opaque = new Uint8Array([0, 255, 80, 75]);
  assert.deepEqual(await read((await upload(opaque, "未解析.xlsx")).file.id), opaque);
});

test("missing chunks, incorrect sizes and hash mismatches cannot publish partial bytes", async () => {
  const bytes = new Uint8Array(40000), accepted = await files.begin(owner, workspace, input(bytes));
  await assert.rejects(files.seal(owner, workspace, accepted.file.id), denied("file_incomplete"));
  await assert.rejects(files.putChunk(owner, workspace, accepted.file.id, 2, new Uint8Array([1])), denied("invalid_file_chunk"));
  await assert.rejects(files.putChunk(owner, workspace, accepted.file.id, 0, new Uint8Array(32767)), denied("invalid_file_chunk"));
  await files.putChunk(owner, workspace, accepted.file.id, 0, bytes.slice(0, 32768));
  await assert.rejects(files.seal(owner, workspace, accepted.file.id), denied("file_incomplete"));
  await files.putChunk(owner, workspace, accepted.file.id, 1, new Uint8Array(7232).fill(1));
  await assert.rejects(files.seal(owner, workspace, accepted.file.id), denied("file_hash_mismatch"));
  assert.equal((await files.get(owner, workspace, accepted.file.id)).state, "uploading");
  await assert.rejects(files.readChunk(owner, workspace, accepted.file.id, 0), denied("file_not_ready"));
});

test("same-key and same-chunk races are idempotent; conflicting bytes never replace the winner", async () => {
  const bytes = new Uint8Array([1, 2, 3]), request = input(bytes);
  const begins = await Promise.all(Array.from({ length: 8 }, () => files.begin(owner, workspace, request)));
  assert.equal(new Set(begins.map(x => x.file.id)).size, 1); assert.equal(begins.filter(x => !x.replayed).length, 1);
  const id = begins[0].file.id;
  await assert.rejects(files.begin(owner, workspace, { ...request, name: "renamed.xlsx" }), denied("idempotency_conflict"));
  await assert.rejects(files.begin(owner, second, request), denied("idempotency_conflict"));
  const chunks = await Promise.all(Array.from({ length: 5 }, () => files.putChunk(owner, workspace, id, 0, bytes)));
  assert.equal(chunks.filter(x => !x.replayed).length, 1);
  const seals = await Promise.all(Array.from({ length: 6 }, () => files.seal(owner, workspace, id)));
  assert.equal(seals.filter(x => !x.replayed).length, 1); assert.equal(new Set(seals.map(x => x.file.ready_at)).size, 1);
  const next = await files.begin(owner, workspace, input(bytes));
  const conflict = await Promise.allSettled([files.putChunk(owner, workspace, next.file.id, 0, bytes), files.putChunk(owner, workspace, next.file.id, 0, new Uint8Array([9, 9, 9]))]);
  assert.equal(conflict.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(conflict.filter(x => x.status === "rejected" && denied("file_chunk_conflict")(x.reason)).length, 1);
});

test("owner and workspace checks cover every operation, including administrators and cancelled replay", async () => {
  const request = input(new Uint8Array([1])), accepted = await files.begin(owner, workspace, request), id = accepted.file.id;
  for (const [actor, wid] of [[other, workspace], [stranger, workspace], [owner, second]]) {
    for (const operation of [() => files.get(actor, wid, id), () => files.putChunk(actor, wid, id, 0, new Uint8Array([1])), () => files.seal(actor, wid, id), () => files.cancel(actor, wid, id), () => files.readChunk(actor, wid, id, 0)]) await assert.rejects(operation(), denied("file_not_found"));
  }
  assert.equal((await files.list(other, workspace)).files.length, 0);
  await assert.rejects(files.get(owner, workspace, randomUUID()), denied("file_not_found"));
  await files.cancel(owner, workspace, id);
  assert.equal((await files.begin(owner, workspace, request)).file.state, "cancelled");
  assert.equal((await files.list(owner, workspace)).files.length, 0);
});

test("membership and user revocation prevent all subsequent file reads and writes", async () => {
  const draft = await files.begin(other, workspace, input(new Uint8Array([1]))), ready = await upload(new Uint8Array([2]), "ready.csv", other);
  await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, other]);
  for (const operation of [() => files.begin(other, workspace, input(new Uint8Array([1]))), () => files.list(other, workspace), () => files.get(other, workspace, ready.file.id), () => files.readChunk(other, workspace, ready.file.id, 0), () => files.putChunk(other, workspace, draft.file.id, 0, new Uint8Array([1])), () => files.seal(other, workspace, draft.file.id), () => files.cancel(other, workspace, draft.file.id)]) await assert.rejects(operation(), denied("workspace_not_found"));
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace, other]);
  assert.deepEqual(await read(ready.file.id, other), new Uint8Array([2]));
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [other]);
  await assert.rejects(files.get(other, workspace, ready.file.id), denied("invalid_owner_user_id"));
});

test("cancel releases draft reservations once and races with seal without deleting a ready result", async () => {
  const requests = Array.from({ length: 5 }, () => input(new Uint8Array([1])));
  const begun = await Promise.allSettled(requests.map(x => files.begin(owner, workspace, x)));
  assert.equal(begun.filter(x => x.status === "fulfilled").length, 4);
  assert.equal(begun.filter(x => x.status === "rejected" && denied("file_draft_limit")(x.reason)).length, 1);
  const accepted = begun.find(x => x.status === "fulfilled")!; assert.equal(accepted.status, "fulfilled"); if (accepted.status !== "fulfilled") return;
  const id = accepted.value.file.id; await files.putChunk(owner, workspace, id, 0, new Uint8Array([1]));
  const cancels = await Promise.all(Array.from({ length: 4 }, () => files.cancel(owner, workspace, id)));
  assert.equal(cancels.filter(x => !x.replayed).length, 1); assert.equal((await files.get(owner, workspace, id)).received_chunks, 0);
  await assert.rejects(files.putChunk(owner, workspace, id, 0, new Uint8Array([1])), denied("file_cancelled"));
  await assert.rejects(files.seal(owner, workspace, id), denied("file_cancelled"));
  const next = await files.begin(owner, workspace, input(new Uint8Array([2]))); await files.putChunk(owner, workspace, next.file.id, 0, new Uint8Array([2]));
  const race = await Promise.allSettled([files.seal(owner, workspace, next.file.id), files.cancel(owner, workspace, next.file.id)]);
  assert.equal(race.filter(x => x.status === "fulfilled").length, 1);
  const state = await files.get(owner, workspace, next.file.id); assert.ok(["ready", "cancelled"].includes(state.state));
  if (state.state === "ready") assert.deepEqual(await read(state.id), new Uint8Array([2]));
});

test("stable cursor pagination hides other owners and cancelled drafts", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await upload(new Uint8Array([i]), `${i}.csv`)).file.id);
  const first = await files.list(owner, workspace, { limit: 2 }); assert.equal(first.files.length, 2); assert.ok(first.next_cursor);
  const secondPage = await files.list(owner, workspace, { limit: 2, before: first.next_cursor! }); const last = await files.list(owner, workspace, { limit: 2, before: secondPage.next_cursor! });
  assert.equal(last.next_cursor, null); assert.deepEqual([...first.files, ...secondPage.files, ...last.files].map(x => x.id), ids.reverse());
  await assert.rejects(files.list(other, workspace, { before: first.next_cursor! }), denied("file_not_found"));
});

test("SQL and shared schemas reject malformed metadata, payloads, and oversized chunks", async () => {
  const good = input(new Uint8Array([1]));
  for (const change of [{ name: "../a.csv" }, { name: "a\\x.csv" }, { name: "a\n.csv" }, { name: "a.exe" }, { name: `${"あ".repeat(85)}.csv` }, { size_bytes: 0 }, { size_bytes: MAX_WORK_FILE_BYTES + 1 }, { size_bytes: 1.5 }, { sha256: "x".repeat(64) }, { owner_user_id: other }]) {
    assert.equal(fileBeginSchema.safeParse({ ...good, ...change }).success, false);
    await assert.rejects(call("ax_file_begin", [owner, workspace, { ...good, ...change }, randomUUID()]), sqlDenied("invalid_request"));
  }
  const accepted = await files.begin(owner, workspace, good);
  assert.equal(fileInfoSchema.safeParse({ ...accepted.file, state: "ready" }).success, false);
  await assert.rejects(call("ax_file_chunk", [owner, workspace, accepted.file.id, 0, new Uint8Array(32769)]), sqlDenied("invalid_file_chunk"));
  await assert.rejects(call("ax_file_chunk", [owner, workspace, accepted.file.id, null, null]), sqlDenied("invalid_file_chunk"));
});

async function seedReady(count: number, actors: string[]) {
  const zeroHash = hash(new Uint8Array(MAX_WORK_FILE_BYTES));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE file_seed_ids ON COMMIT DROP AS SELECT gen_random_uuid() id,($1::uuid[])[1+(i-1)/31] actor FROM generate_series(1,$2::int) i", [actors, count]);
    await client.query("INSERT INTO ax_files(id,owner_user_id,workspace_id,request_key,name,size_bytes,sha256,media_type) SELECT id,actor,$1,gen_random_uuid(),'stored.xlsx',8388608,$2,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' FROM file_seed_ids", [workspace, zeroHash]);
    await client.query("INSERT INTO ax_file_chunks SELECT f.id,i,decode(repeat('00',32768),'hex') FROM file_seed_ids f CROSS JOIN generate_series(0,255) i");
    await client.query("UPDATE ax_files SET state='ready',ready_at=clock_timestamp() WHERE id IN (SELECT id FROM file_seed_ids)");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

test("8 MiB exact boundary, owner quota reservations and cancellation are atomic", async () => {
  const bytes = new Uint8Array(MAX_WORK_FILE_BYTES), ready = await upload(bytes);
  assert.equal(ready.file.chunk_count, 256); assert.equal(hash(await read(ready.file.id)), hash(bytes));
  await seedReady(30, [owner]);
  const accepted = await Promise.allSettled([files.begin(owner, workspace, input(bytes)), files.begin(owner, second, input(bytes))]);
  assert.equal(accepted.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(accepted.filter(x => x.status === "rejected" && denied("file_quota_exceeded")(x.reason)).length, 1);
  const row = (await pool.query("SELECT id,workspace_id FROM ax_files WHERE state='uploading'")).rows[0];
  await files.cancel(owner, row.workspace_id, row.id);
  const replacement = await files.begin(owner, second, input(bytes));
  await assert.rejects(files.begin(owner, workspace, input(new Uint8Array([1]))), denied("file_quota_exceeded"));
  assert.equal(replacement.file.size_bytes, MAX_WORK_FILE_BYTES);
});

test("global 1 GiB quota serializes competing users and includes unfilled reservations", async () => {
  const actors = [owner, other, stranger, randomUUID(), randomUUID()];
  await pool.query("INSERT INTO users(id,status,display_name) SELECT x,'active','quota' FROM unnest($1::uuid[]) x ON CONFLICT DO NOTHING", [actors]);
  await seedReady(127, actors);
  const request = input(new Uint8Array(MAX_WORK_FILE_BYTES));
  const result = await Promise.allSettled([files.begin(stranger, second, request), files.begin(actors[3], second, { ...request, key: randomUUID() })]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 0);
  await pool.query("INSERT INTO org_memberships SELECT $1,x,'member','general' FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING", [second, [actors[3], actors[4]]]);
  const finals = await Promise.allSettled([files.begin(actors[3], second, input(new Uint8Array(MAX_WORK_FILE_BYTES))), files.begin(actors[4], second, input(new Uint8Array(MAX_WORK_FILE_BYTES)))]);
  assert.equal(finals.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(finals.filter(x => x.status === "rejected" && denied("file_quota_exceeded")(x.reason)).length, 1);
  assert.equal(Number((await pool.query("SELECT sum(size_bytes) n FROM ax_files WHERE state<>'cancelled'")).rows[0].n), 1024 * 1024 * 1024);
});

test("restricted API role commits every file operation without table or helper access", async () => {
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ax_api,ax_execution`);
  const signatures = (await pool.query("SELECT oid::regprocedure::text signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1)", [apiFunctions])).rows;
  for (const { signature } of signatures) await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ax_api`);
  const transaction = (role: string, sql: string) => execFileSync("docker", ["exec", "-i", process.env.POSTGRES_CONTAINER ?? "ax-local-postgres", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "app_auth_test"], { input: `BEGIN; SET LOCAL search_path=${schema},pg_temp; SET LOCAL ROLE ${role}; ${sql} COMMIT;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).trim();
  const id = randomUUID(), bytes = new Uint8Array([0, 255, 128]), request = input(bytes, "role.csv");
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_file_begin('${owner}','${workspace}','${JSON.stringify(request)}','${id}');`)).file.id, id);
  transaction("ax_api", `SELECT ax_file_chunk('${owner}','${workspace}','${id}',0,decode('00ff80','hex'));`);
  transaction("ax_api", `SELECT ax_file_seal('${owner}','${workspace}','${id}');`);
  assert.equal(transaction("ax_api", `SELECT ax_file_read_chunk('${owner}','${workspace}','${id}',0);`), "00ff80");
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_file_get('${owner}','${workspace}','${id}');`)).state, "ready");
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_file_list('${owner}','${workspace}');`)).files.length, 1);
  const draft = randomUUID(); transaction("ax_api", `SELECT ax_file_begin('${owner}','${workspace}','${JSON.stringify({ ...request, key: randomUUID() })}','${draft}');`);
  transaction("ax_api", `SELECT ax_file_cancel('${owner}','${workspace}','${draft}');`);
  assert.deepEqual(JSON.parse(transaction("ax_api", `SELECT ax_file_cancel_unavailable('${owner}','${workspace}');`)), { cancelled_count: 0 });
  const permission = (error: any) => error.status === 3 && String(error.stderr).includes("permission denied");
  assert.throws(() => transaction("ax_api", "SELECT * FROM ax_file_chunks;"), permission);
  assert.throws(() => transaction("ax_api", `SELECT ax_file_owned('${owner}','${workspace}','${id}');`), permission);
  assert.throws(() => transaction("ax_execution", `SELECT ax_file_read_chunk('${owner}','${workspace}','${id}',0);`), permission);
  const acl = (await pool.query("SELECT proname,prosecdef,proconfig,has_function_privilege('public',oid,'EXECUTE') public FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax_file_%'")).rows;
  assert.ok(acl.every(x => !x.public));
  assert.ok(acl.filter(x => apiFunctions.includes(x.proname)).every(x => x.prosecdef && x.proconfig.some((v: string) => v.startsWith("search_path="))));
});

test("v5 migration preserves existing run records and checksums while adding an empty file ledger", async () => {
  const oldSchema = `files_v5_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${oldSchema}`); const old = new pg.Pool({ ...connection, options: `-c search_path=${oldSchema}` });
  try {
    await migrateAuth(old); const client = await old.connect();
    try {
      await client.query("BEGIN"); await client.query("CREATE TABLE ax_migrations(version integer PRIMARY KEY,digest text NOT NULL)");
      for (const [index, name] of ["schema.sql", "schema-v2.sql", "schema-v3.sql", "schema-v4.sql", "schema-v5.sql"].entries()) {
        const source = readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"); await client.query(source); await client.query("INSERT INTO ax_migrations VALUES($1,$2)", [index + 1, createHash("sha256").update(source).digest("hex")]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await old.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','old')", [owner]);
    const wid = (await new WorkspaceRepository(old).create(owner, { key: randomUUID(), name: "Old" })).workspace.id;
    await old.query("UPDATE ax_control SET accepting=true");
    await new DataRepository(old, { image: `localhost:5001/runner@sha256:${"a".repeat(64)}` }).submit(owner, { key: randomUUID(), mode: "offline", instruction: "old file", input_text: "a\nb", output_name: "old.txt", allow_model: false }, wid);
    const oldRuns = (await old.query("SELECT to_jsonb(r) v FROM ax_runs r")).rows;
    const before = (await old.query("SELECT version,digest FROM ax_migrations ORDER BY version")).rows;
    const oldData = (await old.query("SELECT to_jsonb(w) v FROM org_workspaces w")).rows;
    await migrateData(old); await migrateData(old);
    assert.deepEqual((await old.query("SELECT version,digest FROM ax_migrations WHERE version<6 ORDER BY version")).rows, before);
    assert.deepEqual((await old.query("SELECT to_jsonb(w) v FROM org_workspaces w")).rows, oldData);
    assert.deepEqual((await old.query("SELECT to_jsonb(r) v FROM ax_runs r")).rows, oldRuns);
    const repo = new FileRepository(old); assert.equal((await repo.list(owner, wid)).files.length, 0);
    const accepted = await repo.begin(owner, wid, input(new Uint8Array([1]))); await repo.putChunk(owner, wid, accepted.file.id, 0, new Uint8Array([1])); await repo.seal(owner, wid, accepted.file.id);
    assert.deepEqual(await repo.readChunk(owner, wid, accepted.file.id, 0), new Uint8Array([1]));
  } finally { await old.end(); await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`); }
});

test("explicit unavailable-workspace recovery releases blocked quota without exposing old metadata", async () => {
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING", [second, other]);
  const drafts = await Promise.all(Array.from({ length: 4 }, () => files.begin(other, workspace, input(new Uint8Array([1])))));
  await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, other]);
  await assert.rejects(files.get(other, workspace, drafts[0].file.id), denied("workspace_not_found"));
  await assert.rejects(files.cancel(other, workspace, drafts[0].file.id), denied("workspace_not_found"));
  await assert.rejects(files.begin(other, second, input(new Uint8Array([1]))), denied("file_draft_limit"));
  assert.deepEqual(await files.cancelUnavailable(other,second),{cancelled_count:4});
  assert.deepEqual(await files.cancelUnavailable(other,second),{cancelled_count:0});
  assert.equal((await files.begin(other,second,input(new Uint8Array([1])))).file.state,"uploading");
  await assert.rejects(files.get(other,workspace,drafts[0].file.id),denied("workspace_not_found"));
});

async function waitBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 blocked", [pid])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected the transaction to wait for the workspace lock");
}

test("unavailable recovery preserves ready/current-member/other-owner data and requires current membership", async () => {
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING", [second, other]);
  const ready = await upload(new Uint8Array([8]), "kept.csv", other);
  const old = await files.begin(other, workspace, input(new Uint8Array([1]))), current = await files.begin(other, second, input(new Uint8Array([2]))), someone = await files.begin(owner, workspace, input(new Uint8Array([3])));
  await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, other]);
  await assert.rejects(files.cancelUnavailable(other,workspace), denied("workspace_not_found"));
  const results = await Promise.all(Array.from({length:4}, () => files.cancelUnavailable(other,second)));
  assert.equal(results.reduce((sum,x)=>sum+x.cancelled_count,0),1);
  assert.equal((await files.get(other,second,current.file.id)).state,"uploading");
  assert.equal((await files.get(owner,workspace,someone.file.id)).state,"uploading");
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[workspace,other]);
  assert.equal((await files.get(other,workspace,old.file.id)).state,"cancelled");
  assert.deepEqual(await read(ready.file.id,other),new Uint8Array([8]));
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1",[other]);
  await assert.rejects(files.cancelUnavailable(other,second),denied("invalid_owner_user_id"));
});

test("rejoining and unavailable recovery serialize; a restored membership keeps its draft", async () => {
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING",[second,other]);
  await pool.query("UPDATE users SET verified_email='b@example.test' WHERE id=$1",[other]);
  const draft = await files.begin(other,workspace,input(new Uint8Array([1])));
  await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[workspace,other]);
  const invite = await org.invite(owner,workspace,{key:randomUUID(),email:"b@example.test"});
  const joiner = await pool.connect(), recovery = await pool.connect();
  try {
    await joiner.query("BEGIN"); await joiner.query("SELECT 1 FROM org_workspaces WHERE id=$1 FOR UPDATE",[workspace]);
    const recoveryPid = (await recovery.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = new FileRepository(recovery).cancelUnavailable(other,second); pending.catch(()=>{});
    await waitBlocked(recoveryPid);
    await new WorkspaceRepository(joiner).accept(other,{token:invite.token!}); await joiner.query("COMMIT");
    assert.deepEqual(await pending,{cancelled_count:0});
    assert.equal((await files.get(other,workspace,draft.file.id)).state,"uploading");
    await files.putChunk(other,workspace,draft.file.id,0,new Uint8Array([1])); await files.seal(other,workspace,draft.file.id);
  } finally { await joiner.query("ROLLBACK"); joiner.release(); recovery.release(); }
});

test("committed recovery is not undone by a later rejoin and does not race chunk/seal past revocation", async () => {
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING",[second,other]);
  await pool.query("UPDATE users SET verified_email='b@example.test' WHERE id=$1",[other]);
  const draft = await files.begin(other,workspace,input(new Uint8Array([1]))); await files.putChunk(other,workspace,draft.file.id,0,new Uint8Array([1]));
  const remover = await pool.connect(), sealing = await pool.connect();
  try {
    await remover.query("BEGIN"); await remover.query("SELECT 1 FROM org_workspaces WHERE id=$1 FOR UPDATE",[workspace]);
    await remover.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[workspace,other]);
    const pid = (await sealing.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pendingSeal = new FileRepository(sealing).seal(other,workspace,draft.file.id); pendingSeal.catch(()=>{});
    const pendingChunk = files.putChunk(other,workspace,draft.file.id,0,new Uint8Array([1])); pendingChunk.catch(()=>{});
    const pendingRecovery = files.cancelUnavailable(other,second); pendingRecovery.catch(()=>{});
    await waitBlocked(pid); await remover.query("COMMIT");
    await assert.rejects(pendingSeal,denied("workspace_not_found")); await assert.rejects(pendingChunk,denied("workspace_not_found"));
    assert.deepEqual(await pendingRecovery,{cancelled_count:1});
  } finally { await remover.query("ROLLBACK"); remover.release(); sealing.release(); }
  const invite = await org.invite(owner,workspace,{key:randomUUID(),email:"b@example.test"}); await org.accept(other,{token:invite.token!});
  assert.equal((await files.get(other,workspace,draft.file.id)).state,"cancelled");
  const current = await files.begin(other,workspace,input(new Uint8Array([2])));
  const values = await Promise.all([files.putChunk(other,workspace,current.file.id,0,new Uint8Array([2])),files.cancelUnavailable(other,second)]);
  assert.equal(values[1].cancelled_count,0);
  const sealed = await Promise.all([files.seal(other,workspace,current.file.id),files.cancelUnavailable(other,second)]);
  assert.equal(sealed[0].file.state,"ready"); assert.equal(sealed[1].cancelled_count,0);
});

test("unavailable recovery excludes drafts added in a workspace outside its locked snapshot", async () => {
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING", [second, other]);
  const third = (await org.create(owner, { key: randomUUID(), name: "Later upload" })).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [third, other]);
  await files.begin(other, workspace, input(new Uint8Array([1])));
  const blocker = await pool.connect(), recovery = await pool.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM org_workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const pid = (await recovery.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = new FileRepository(recovery).cancelUnavailable(other, second); pending.catch(() => {});
    await waitBlocked(pid);
    const later = await files.begin(other, third, input(new Uint8Array([2])));
    await org.removeMember(owner, third, other);
    await blocker.query("COMMIT");
    assert.deepEqual(await pending, { cancelled_count: 0 });
    assert.equal((await pool.query("SELECT state FROM ax_files WHERE id=$1", [later.file.id])).rows[0].state, "uploading");
    assert.deepEqual(await files.cancelUnavailable(other, second), { cancelled_count: 1 });
  } finally { await blocker.query("ROLLBACK"); blocker.release(); recovery.release(); }
});
