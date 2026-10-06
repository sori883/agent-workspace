import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { prepareTestAuth } from "./prepare-auth";
import { canonical, fingerprint, payloadHash, sha256, submissionKey, utf8 } from "../data/canonical";
import { WorkspaceRepository } from "../data/workspaces";
import { DataRepository } from "../data/repository";
import { postgresRunService, RunServiceError } from "../api/run-service";
import { postgresChatService } from "../api/chat-service";
import type { RunInput } from "../shared/run-contracts";
import { importLegacyRecords, readLegacyRecords } from "../server/legacy-import";

const schema = `data_test_${randomBytes(8).toString("hex")}`;
const image = `localhost:5001/runner@sha256:${"a".repeat(64)}`;
let workspace: string;
const owner = randomUUID(); const other = randomUUID(); const controller = "test-controller";
let pool: pg.Pool; let admin: pg.Pool; let repository: DataRepository;
const call = async <T = any>(name: string, args: unknown[] = []): Promise<T> => (await pool.query(`SELECT ${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) AS value`, args)).rows[0].value;
const runInput = (change: Partial<RunInput> = {}): RunInput => ({ key: randomUUID(), mode: "offline", instruction: "保存してください。", input_text: "青空", output_name: "answer.txt", allow_model: false, ...change });
const serviceError = (code: string, status = 409) => (error: unknown) => error instanceof RunServiceError && error.code === code && error.status === status;
const sqlError = (message: string) => (error: unknown) => error instanceof Error && error.message === message;
type Claim = { run_id: string; generation: number; request: { adapter: string; output_name: string }; kind: string; result: unknown; effects: Record<string, unknown> };
const claim = () => call<Claim | null>("ax_claim", [controller, 30]);
async function effect(c: Claim, operation: string) {
  const value = await call("ax_intent", [c.run_id, c.generation, controller, operation]);
  const evidence = operation === "egress_deny" ? { egress_denied: true, actor: c.run_id } : operation === "suspend" ? { phase: "SUSPENDED", worker_assignment: null, actor: c.run_id } : { confirmed: true, actor: c.run_id };
  await call("ax_evidence", [c.run_id, c.generation, controller, value.operation_id, evidence]);
  return value;
}
async function start(c: Claim) {
  for (const operation of ["create", "resume", "stage", ...(c.request.adapter === "antigravity" ? ["egress_allow"] : ["egress_prepare"]), "start"]) await effect(c, operation);
}
async function result(c: Claim, content = "返答\0😀", change: Record<string, unknown> = {}) {
  const body = utf8(content);
  const value = { schema_version: 1, run_id: c.run_id, adapter: c.request.adapter, status: "succeeded", exit_code: 0, stop_reason: c.request.adapter === "offline" ? "OFFLINE" : "UNSPECIFIED", usage: { prompt_token_count: c.request.adapter === "offline" ? 0 : 1, total_token_count: c.request.adapter === "offline" ? 0 : 1 }, estimated_usd: 0, error_type: null, artifact: { name: c.request.output_name, size_bytes: body.length, sha256: await sha256(body) }, ...change };
  await call("ax_collect", [c.run_id, c.generation, controller, value, value.artifact ? body : null]);
  return value;
}
async function finish(c: Claim) {
  await effect(c, "egress_deny"); await effect(c, "suspend");
  return call("ax_finish", [c.run_id, c.generation, controller]);
}
before(async () => {
  const settings = prepareTestAuth();
  const { caPath, ...database } = settings.database;
  const connection = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 10000 };
  admin = new pg.Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(new URL("../server/auth-schema.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../server/auth-schema-v2.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../data/schema.sql", import.meta.url), "utf8"));
    await client.query(readFileSync(new URL("../data/schema-v2.sql", import.meta.url), "utf8"));
    await client.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','A'),($2,'active','B')", [owner, other]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  repository = new DataRepository(pool, { image });
  workspace = (await new WorkspaceRepository(pool).create(owner, {key:randomUUID(),name:"Data"})).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace,other]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE ax_conversations,ax_runs CASCADE");
  await pool.query("INSERT INTO ax_execution_slot VALUES(true,NULL,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL,hold_reason=NULL");
  await pool.query("UPDATE ax_control SET accepting=true");
});
after(async () => {
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

test("concurrent same-key admission persists one run, replay survives guard and rejects changed body", async () => {
  const service = postgresRunService(repository); const input = runInput();
  const values = await Promise.all(Array.from({ length: 8 }, () => service.submit(owner, input, workspace)));
  assert.equal(new Set(values.map((v) => v.run_id)).size, 1);
  assert.equal(values.filter((v) => !v.replayed).length, 1);
  await assert.rejects(service.submit(owner, { ...input, instruction: "変更" }, workspace), serviceError("idempotency_conflict"));
  await assert.rejects(service.submit(other, input, workspace), serviceError("unresolved_run"));
  await assert.rejects(service.get(other, values[0].run_id, workspace), serviceError("run_not_found", 404));
  await assert.rejects(service.artifact(other, values[0].run_id, workspace), serviceError("run_not_found", 404));
  await assert.rejects(service.recover(other, values[0].run_id, workspace), serviceError("run_not_found", 404));
  assert.equal((await service.list(other, workspace)).runs.length, 0);
  await service.recover(owner, values[0].run_id, workspace);
  assert.equal((await service.get(owner, values[0].run_id, workspace)).summary.state, "not_started");
  assert.equal(await claim(), null);
  assert.equal((await service.submit(owner, input, workspace)).replayed, true);
});

test("controller effects claim once, results preserve NUL and completion requires actual cleanup evidence", async () => {
  const accepted = await repository.submit(owner, runInput(), workspace);
  const claims = await Promise.all([claim(), claim()]); const c = claims.find(Boolean)!;
  assert.equal(claims.filter(Boolean).length, 1);
  await start(c);
  await assert.rejects(call("ax_intent", [c.run_id, c.generation, controller, "start"]), sqlError("execution_already_claimed"));
  await result(c);
  assert.equal((await repository.get(owner, accepted.run_id, workspace)).summary.resolved, false);
  const denied = await effect(c, "egress_deny");
  const stopped = await call("ax_intent", [c.run_id, c.generation, controller, "suspend"]);
  await assert.rejects(call("ax_evidence", [c.run_id, c.generation, controller, stopped.operation_id, { actor: c.run_id, phase: "SUSPENDED", worker_assignment: "still-live" }]), sqlError("invalid_evidence"));
  await call("ax_evidence", [c.run_id, c.generation, controller, stopped.operation_id, { actor: c.run_id, phase: "SUSPENDED", worker_assignment: null }]);
  assert.deepEqual(await call("ax_finish", [c.run_id, c.generation, controller]), { resolved: true, outcome: "succeeded" });
  assert.equal((await repository.artifact(owner, accepted.run_id, workspace)).content, "返答\0😀");
  await assert.rejects(call("ax_evidence", [c.run_id, c.generation, controller, denied.operation_id, { actor: c.run_id, egress_denied: true }]), sqlError("stale_claim"));
});

test("expired claim and lost acknowledgement never issue a second send permit or auto-start", async () => {
  const accepted = await repository.submit(owner, runInput(), workspace); const c = (await claim())!;
  await call("ax_intent", [c.run_id, c.generation, controller, "create"]);
  await pool.query("UPDATE ax_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1", [c.run_id]);
  assert.equal(await claim(), null);
  await assert.rejects(call("ax_heartbeat", [c.run_id, c.generation, controller, 30]), sqlError("stale_claim"));
  await repository.recover(owner, accepted.run_id, workspace);
  assert.equal(await claim(), null);
  await assert.rejects(call("ax_authorize_recovery", [c.run_id, { process_stopped: true }]), sqlError("retirement_unconfirmed"));
  await call("ax_authorize_recovery", [c.run_id, { controller_id: controller, generation: c.generation, process_stopped: true, transport_fenced: true, inflight_settled: true }]);
  const recovery = (await claim())!; assert.equal(recovery.kind, "recovery");
  await assert.rejects(call("ax_intent", [recovery.run_id, recovery.generation, controller, "resume"]), sqlError("restart_forbidden"));
  await assert.rejects(call("ax_intent", [c.run_id, c.generation, controller, "resume"]), sqlError("stale_claim"));
  assert.deepEqual(await finish(recovery), { resolved: true, outcome: "failed" });
});

test("chat history, owner and parent are atomic, failed turns stay out of history and NUL survives", async () => {
  const chats = postgresChatService(repository); const cid = randomUUID();
  const input = { key: randomUUID(), parent_run_id: null, text: "青空\n😀", allow_model: true as const };
  const accepted = await chats.submit(owner, cid, input, workspace); const c = (await claim())!;
  await assert.rejects(chats.submit(other, cid, input, workspace), serviceError("conversation_not_found", 404));
  await assert.rejects(chats.get(other, cid, workspace), serviceError("conversation_not_found", 404));
  await start(c); await result(c, "答え\0😀"); await finish(c);
  assert.equal((await chats.get(owner, cid, workspace)).turns[0].assistant, "答え\0😀");
  assert.equal((await chats.submit(owner, cid, input, workspace)).replayed, true);
  await assert.rejects(chats.submit(owner, cid, { ...input, key: randomUUID() }, workspace), serviceError("conversation_conflict"));
  const next = { ...input, key: randomUUID(), parent_run_id: accepted.run_id, text: "続き" };
  const second = await chats.submit(owner, cid, next, workspace); await repository.recover(owner, second.run_id, workspace);
  const third = await chats.submit(owner, cid, { ...next, key: randomUUID(), parent_run_id: second.run_id }, workspace);
  const detail = await repository.get(owner, third.run_id, workspace);
  assert.equal(detail.request.inputs["conversation.json"], '[{"role":"user","content":"青空\\n😀"},{"role":"assistant","content":"答え\\u0000😀"}]');
  assert.deepEqual((await chats.get(owner, cid, workspace)).turns.map((t) => t.assistant), ["答え\0😀", null, null]);
});

test("paid failure fingerprint, review, total cost and unknown usage apply across owners", async () => {
  const input = runInput({ mode: "model", allow_model: true }); const first = await repository.submit(owner, input, workspace); let c = (await claim())!;
  await start(c); await result(c, "", { status: "failed", exit_code: 1, error_type: "Failed", artifact: null, estimated_usd: 0.003 }); await finish(c);
  await assert.rejects(repository.submit(other, { ...input, key: randomUUID() }, workspace), serviceError("failed_request_already_attempted"));
  await assert.rejects(repository.submit(other, { ...input, key: randomUUID(), instruction: "修正" }, workspace), serviceError("paid_failure_requires_review"));
  await call("ax_review_failure", [first.run_id, "失敗を確認"]);
  await assert.rejects(repository.submit(owner, { ...input, key: randomUUID() }, workspace), serviceError("failed_request_already_attempted"));
  await repository.submit(other, { ...input, key: randomUUID(), instruction: "修正" }, workspace); c = (await claim())!;
  await start(c); await result(c, "成功", { estimated_usd: 0.007 }); await finish(c);
  await assert.rejects(repository.submit(owner, { ...input, key: randomUUID(), instruction: "別" }, workspace), serviceError("pilot_estimate_limit_reached"));
  const offline = await repository.submit(owner, runInput(), workspace); await repository.recover(owner, offline.run_id, workspace);
  await pool.query("UPDATE ax_runs SET result=jsonb_set(result,'{usage}','null') WHERE run_id=$1", [c.run_id]);
  await assert.rejects(repository.submit(owner, runInput(), workspace), serviceError("unknown_paid_usage"));
});

test("unknown model result cannot release execution slot despite both cleanup confirmations", async () => {
  await repository.submit(owner, runInput({ mode: "model", allow_model: true }), workspace); const c = (await claim())!;
  await start(c); await result(c, "", { status: "failed", exit_code: 1, error_type: "UnknownUsage", artifact: null, usage: null, estimated_usd: null });
  assert.deepEqual(await finish(c), { resolved: false, outcome: "failed" });
  await assert.rejects(repository.submit(other, runInput(), workspace), serviceError("unresolved_run"));
});

test("SQL canonical output matches Python for integer filenames and original hashes", async () => {
  const value = { "2": "two", "10": "ten", 日本語: "\n😀", nested: { z: false, a: "\x01" } };
  assert.equal(await call("ax_json", [value, false]), canonical(value));
  assert.equal(await call("ax_json", [value, true]), canonical(value, true));
  assert.equal(await call("ax_quote_bytes", [utf8("\0\b\f\n\r\t\x01青😀")]), JSON.stringify("\0\b\f\n\r\t\x01青😀"));
});

async function legacyFixture(options: { owner?: string; input?: RunInput; receipt?: Record<string, unknown>; result?: unknown; content?: string; id?: string } = {}) {
  const input = options.input ?? runInput(); const id = options.id ?? `ax-run-${randomBytes(8).toString("hex")}`;
  const request = { schema_version: 1, run_id: id, adapter: input.mode === "offline" ? "offline" : "antigravity", instruction: input.instruction, inputs: input.input_text ? { "input.txt": input.input_text } : {}, output_name: input.output_name };
  const body = utf8(options.content ?? "legacy\0😀");
  const resultValue = options.result === undefined ? { schema_version: 1, run_id: id, adapter: request.adapter, status: "succeeded", exit_code: 0, stop_reason: request.adapter === "offline" ? "OFFLINE" : "UNSPECIFIED", usage: { prompt_token_count: request.adapter === "offline" ? 0 : 1, total_token_count: request.adapter === "offline" ? 0 : 1 }, estimated_usd: 0, error_type: null, artifact: { name: input.output_name, size_bytes: body.length, sha256: await sha256(body) } } : options.result;
  const { key, ...payload } = input;
  const receipt = { schema_version: 1, run_id: id, adapter: request.adapter, fingerprint: await fingerprint(request, image), image, phase: "finished", apply_attempted: true, start_attempted: true, result: resultValue, cleanup: { egress_denied: true, suspended: true }, cleanup_errors: [], resolved: true, outcome: "succeeded", error_type: null, known_estimated_usd_before: 0, estimate_is_billing_guarantee: false,
    submission: { key_hash: await submissionKey(options.owner ?? null, key), payload_hash: await payloadHash(payload), accepted_at: "2026-10-06T01:00:00.123456Z" }, ...(options.owner ? { owner_user_id: options.owner } : {}), ...options.receipt };
  const manifest = { apiVersion: "ax.io/v1alpha1", kind: "Task", metadata: { name: id, atespace: "ax-demo" }, spec: { image, command: ["python3", "/opt/ax-task/runner.py", "wait"], debug: true } };
  const bytes = (v: unknown) => utf8(JSON.stringify(v, null, 2) + "\n");
  return { id, receipt, request, result: resultValue, args: [{ sort_at: "2026-10-06T01:00:00Z" }, bytes(receipt), bytes(request), resultValue === null ? null : bytes(resultValue), bytes(manifest), resultValue && (resultValue as { artifact?: unknown }).artifact ? body : null] as unknown[] };
}

test("import preserves original bytes, timestamps, ownerless privacy, hashes and replay without enqueuing", async () => {
  await pool.query("UPDATE ax_control SET accepting=false");
  const input = runInput(); const owned = await legacyFixture({ owner, input }); const legacy = await legacyFixture();
  const a = await call("ax_import_run", owned.args); const b = await call("ax_import_run", legacy.args);
  assert.equal(a.invalid, false); assert.equal(b.invalid, false);
  assert.equal((await call("ax_import_run", owned.args)).replayed, true);
  const changed = [...owned.args]; changed[1] = utf8(JSON.stringify({ ...owned.receipt, error_type: "Changed" }));
  await assert.rejects(call("ax_import_run", changed), sqlError("import_conflict"));
  assert.deepEqual(await call("ax_complete_import"), { runs: 2, conversations: 0, invalid: 0, unresolved: 0 });
  assert.equal(await claim(), null);
  assert.equal((await repository.list(owner)).runs.length, 1);
  assert.equal((await repository.get(owner, owned.id)).summary.accepted_at, "2026-10-06T01:00:00.123456Z");
  assert.equal((await repository.artifact(owner, owned.id)).content, "legacy\0😀");
  await assert.rejects(repository.get(owner, legacy.id), serviceError("run_not_found", 404));
  await pool.query("UPDATE ax_control SET accepting=true");
  await assert.rejects(repository.submit(owner, input, workspace), serviceError("run_not_found", 404));
  await assert.rejects(repository.submit(owner, input), serviceError("workspace_required", 400));
  assert.equal((await pool.query("SELECT request_bytes FROM ax_imports WHERE run_id=$1", [owned.id])).rows[0].request_bytes.toString("hex"), Buffer.from(owned.args[2] as Uint8Array).toString("hex"));
});

test("newer result file never promotes an old receipt and quarantined originals block global admission", async () => {
  await pool.query("UPDATE ax_control SET accepting=false");
  const fixture = await legacyFixture({ result: null, receipt: { phase: "start_attempted", outcome: "pending", resolved: false } });
  fixture.args[3] = utf8('{"status":"succeeded"}');
  assert.equal((await call("ax_import_run", fixture.args)).invalid, true);
  assert.deepEqual(await call("ax_complete_import"), { runs: 1, conversations: 0, invalid: 1, unresolved: 1 });
  assert.equal(await claim(), null);
  const row = (await pool.query("SELECT result,resolved FROM ax_runs WHERE run_id=$1", [fixture.id])).rows[0];
  assert.deepEqual(row, { result: null, resolved: false });
  await pool.query("UPDATE ax_control SET accepting=true");
  await assert.rejects(repository.submit(owner, runInput(), workspace), serviceError("invalid_run_ledger", 503));
});

test("legacy importer reports database quarantine when file preflight accepts an invalid fingerprint", async () => {
  await pool.query("UPDATE ax_control SET accepting=false");
  const fixture = await legacyFixture({ receipt: { fingerprint: "0".repeat(64) } });
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ax-data-import-"));
  try {
    const directory = join(root, fixture.id);
    mkdirSync(join(directory, "artifacts"), { recursive: true });
    for (const [index, name] of ["receipt.json", "request.json", "result.json", "manifest.json"].entries()) {
      writeFileSync(join(directory, name), fixture.args[index + 1] as Uint8Array);
    }
    writeFileSync(join(directory, "artifacts", fixture.request.output_name), fixture.args[5] as Uint8Array);
    const records = readLegacyRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].invalid, false);
    assert.deepEqual(await importLegacyRecords(pool, records), { count: 1, quarantined: 1, unresolved: 0 });
    assert.deepEqual((await pool.query("SELECT invalid,resolved FROM ax_runs WHERE run_id=$1", [fixture.id])).rows[0], { invalid: true, resolved: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy unknown usage and paid costs remain global even when hidden from every user", async () => {
  await pool.query("UPDATE ax_control SET accepting=false");
  const paid = await legacyFixture({ input: runInput({ mode: "model", allow_model: true }) });
  const value = { ...(paid.result as object), estimated_usd: 0.01 };
  paid.args[1] = utf8(JSON.stringify({ ...paid.receipt, result: value })); paid.args[3] = utf8(JSON.stringify(value));
  await call("ax_import_run", paid.args); await call("ax_complete_import");
  await pool.query("UPDATE ax_control SET accepting=true");
  assert.deepEqual(await repository.list(owner), { runs: [] });
  await assert.rejects(repository.submit(owner, runInput({ mode: "model", allow_model: true }), workspace), serviceError("pilot_estimate_limit_reached"));
  await pool.query("UPDATE ax_runs SET result=jsonb_set(result,'{usage}','null') WHERE run_id=$1", [paid.id]);
  await assert.rejects(repository.submit(other, runInput(), workspace), serviceError("unknown_paid_usage"));
});

test("thirty-two failed turns, escaped maximum reply, limit replay and snapshot integrity", async () => {
  const cid = randomUUID(); let parent: string | null = null; let lastInput: any;
  for (let i = 0; i < 32; i++) {
    lastInput = { key: randomUUID(), parent_run_id: parent, text: "\x01".repeat(2048), allow_model: true as const };
    const accepted = await repository.submitChat(owner, cid, lastInput, workspace); parent = accepted.run_id;
    if (i < 31) await repository.recover(owner, accepted.run_id, workspace);
    else { const c = (await claim())!; await start(c); await result(c, "\0".repeat(65536)); await finish(c); }
  }
  const detail = await repository.getConversation(owner, cid, workspace);
  assert.equal(detail.turns.length, 32); assert.equal(detail.context_full, true); assert.equal(detail.can_send, false);
  assert.equal(detail.turns[31].assistant?.length, 65536);
  assert.ok(utf8(JSON.stringify(detail)).length < 1024 * 1024);
  assert.equal((await repository.submitChat(owner, cid, lastInput, workspace)).replayed, true);
  await assert.rejects(repository.submitChat(owner, cid, { ...lastInput, key: randomUUID(), parent_run_id: parent }, workspace), serviceError("conversation_context_full", 422));
  await assert.rejects(pool.query("UPDATE ax_runs SET owner_user_id=$1 WHERE run_id=$2", [other, parent]), sqlError("immutable_run"));
  await pool.query("UPDATE ax_conversations SET context_bytes=convert_to('[]','UTF8') WHERE id=$1", [cid]);
  await assert.rejects(repository.getConversation(owner, cid, workspace), serviceError("invalid_conversation_state"));
});

test("SQL functions are private, public entry points pin search_path and failure cannot return to start", async () => {
  const functions = (await pool.query("SELECT proname,prosecdef,proconfig,proacl::text[] AS proacl FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'ax_%'", [schema])).rows;
  assert.ok(functions.length > 20);
  for (const fn of functions) {
    assert.ok(fn.proacl !== null);
    assert.ok(!fn.proacl.some((acl: string) => acl.startsWith("=")));
    if (fn.prosecdef) assert.deepEqual(fn.proconfig, [`search_path=${schema}, pg_temp`]);
  }
  await repository.submit(owner, runInput(), workspace); const c = (await claim())!;
  await assert.rejects(call("ax_intent", [c.run_id, null, controller, "create"]), sqlError("stale_claim"));
  await effect(c, "create"); await effect(c, "resume"); await effect(c, "stage");
  await call("ax_fail", [c.run_id, c.generation, controller, "LocalFailure"]);
  await effect(c, "egress_deny");
  await assert.rejects(call("ax_intent", [c.run_id, c.generation, controller, "start"]), sqlError("restart_forbidden"));
});
