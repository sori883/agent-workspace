import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { prepareTestAuth } from "./prepare-auth";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { WorkspaceRepository } from "../data/workspaces";
import { DataRepository } from "../data/repository";
import { RunServiceError } from "../api/run-service";
import { createApi } from "../api/app";
import { readConfig } from "../server/config";
import { apiFunctions, executionFunctions } from "../data/permissions";

const schema = `workspace_test_${randomBytes(8).toString("hex")}`;
const alice = randomUUID(), bob = randomUUID(), carol = randomUUID();
const image = `localhost:5001/runner@sha256:${"a".repeat(64)}`;
let connection: pg.PoolConfig;
let pool: pg.Pool, admin: pg.Pool, org: WorkspaceRepository, runs: DataRepository;
const input = () => ({ key: randomUUID(), mode: "offline" as const, instruction: "保存", input_text: "内容", output_name: "answer.txt", allow_model: false });
const errorCode = (code: string) => (e: unknown) => e instanceof RunServiceError && e.code === code;
const sqlError = (code: string) => (e: unknown) => e instanceof Error && e.message === code;
const call = async (name: string, args: unknown[] = []) => (await pool.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args)).rows[0].value;
const create = async (owner = alice, name = "会社") => (await org.create(owner, { key: randomUUID(), name })).workspace.id;
async function transfer(wid: string, recipient: string, sender = alice) {
  const value=await org.proposeOwnership(sender,wid,{key:randomUUID(),to_user_id:recipient});
  await org.respondOwnership(recipient,wid,value.transfer.id,"accept"); return value.transfer;
}
async function join(wid: string, owner = bob) {
  const invite = await org.invite(alice, wid, { key: randomUUID(), email: owner === bob ? "bob@example.test" : "carol@example.test" });
  return org.accept(owner, { token: invite.token! });
}
before(async () => {
  const { caPath, ...database } = prepareTestAuth().database;
  connection = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 10, statement_timeout: 10000 };
  admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  await migrateAuth(pool); await migrateData(pool); await migrateData(pool);
  await pool.query("INSERT INTO users(id,status,display_name,verified_email) VALUES($1,'active','Alice','alice@example.test'),($2,'active','Bob','bob@example.test'),($3,'active','Carol','carol@example.test')", [alice, bob, carol]);
  org = new WorkspaceRepository(pool); runs = new DataRepository(pool, { image });
});
beforeEach(async () => {
  await pool.query("TRUNCATE org_workspaces,ax_runs,ax_conversations CASCADE");
  await pool.query("UPDATE users SET status='active',verified_email=CASE id WHEN $1 THEN 'alice@example.test' WHEN $2 THEN 'bob@example.test' ELSE 'carol@example.test' END", [alice, bob]);
  await pool.query("INSERT INTO ax_execution_slot VALUES(true,NULL,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL,hold_reason=NULL");
  await pool.query("UPDATE ax_control SET accepting=true");
});
after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

test("workspace creation enforces current ownership quota and replay, transfer returns a slot", async () => {
  const key=randomUUID(); const replay=await Promise.all(Array.from({length:8},()=>org.create(alice,{key,name:"会社"})));
  assert.equal(new Set(replay.map(x=>x.workspace.id)).size,1); assert.equal(replay.filter(x=>!x.replayed).length,1);
  await assert.rejects(org.create(alice,{key,name:"変更"}),errorCode("idempotency_conflict"));
  for(let i=0;i<48;i++) await create();
  const races=await Promise.allSettled(Array.from({length:5},()=>create()));
  assert.equal(races.filter(x=>x.status==="fulfilled").length,1);
  assert.equal((await org.list(alice)).owned_count,50);
  assert.equal((await org.create(alice,{key,name:"会社"})).replayed,true);
  const wid=replay[0].workspace.id; await join(wid);
  await transfer(wid,bob); await org.leave(alice,wid);
  assert.equal((await org.list(alice)).owned_count,49); await create();
  await assert.rejects(create(),errorCode("workspace_ownership_limit"));
  await assert.rejects(pool.query("UPDATE org_workspaces SET created_by_user_id=$1 WHERE id=$2",[bob,wid]),sqlError("immutable_workspace_creator"));
});

test("last admin remains under concurrent leave and ordinary members cannot administer", async () => {
  const wid = await create(); await join(wid);
  await assert.rejects(org.rename(bob, wid, { name: "拒否" }), errorCode("workspace_forbidden"));
  await assert.rejects(org.member(bob, wid, bob, { access_level: "admin", business_role: "developer" }), errorCode("workspace_forbidden"));
  await org.member(alice, wid, bob, { access_level: "admin", business_role: "developer" });
  const result = await Promise.allSettled([org.leave(alice, wid), org.leave(bob, wid)]);
  assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(result.filter(x => x.status === "rejected" && errorCode("workspace_owner_cannot_leave")(x.reason)).length, 1);
  assert.equal((await pool.query("SELECT count(*) FROM org_memberships WHERE workspace_id=$1 AND access_level='admin'", [wid])).rows[0].count, "1");
});

test("groups require same-workspace membership and rejoining cannot resurrect group or admin rights", async () => {
  const wid = await create(), other = await create(); await join(wid);
  const g = await org.createGroup(alice, wid, { key: randomUUID(), name: "開発" });
  await org.groupMember(alice, wid, g.group.id, bob, { member: true });
  await assert.rejects(org.groupMember(alice, other, g.group.id, alice, { member: true }), errorCode("group_not_found"));
  await assert.rejects(pool.query("INSERT INTO org_group_memberships VALUES($1,$2,$3)", [other, g.group.id, alice]), (e: any) => e.code === "23503");
  await org.member(alice, wid, bob, { access_level: "admin", business_role: "developer" });
  await org.removeMember(alice, wid, bob); await join(wid);
  const detail = await org.get(bob, wid);
  assert.deepEqual(detail.workspace, { id: wid, name: "会社", owner_user_id: alice, access_level: "member", business_role: "general" });
  assert.deepEqual(detail.groups[0].member_user_ids, []); assert.deepEqual(detail.invitations, []);
});

test("invitations store only hashes, replay never rotates links, acceptance is recipient and current-admin bound", async () => {
  const wid = await create(); const key = randomUUID(); const first = await org.invite(alice, wid, { key, email: "BOB@example.test" });
  const replay = await org.invite(alice, wid, { key, email: "bob@example.test" });
  assert.deepEqual(replay, { id: first.id, token: null, expires_at: first.expires_at, replayed: true });
  assert.equal(first.token!.length, 43);
  const serialized = JSON.stringify((await pool.query("SELECT row_to_json(i) AS value FROM org_invitations i")).rows);
  assert.ok(!serialized.includes(first.token!));
  await assert.rejects(org.accept(carol, { token: first.token! }), errorCode("invitation_recipient_mismatch"));
  await pool.query("UPDATE users SET verified_email=NULL WHERE id=$1", [bob]);
  await assert.rejects(org.accept(bob, { token: first.token! }), errorCode("verified_email_required"));
  await pool.query("UPDATE users SET verified_email='bob@example.test' WHERE id=$1", [bob]);
  assert.equal((await org.accept(bob, { token: first.token! })).replayed, false);
  assert.equal((await org.accept(bob, { token: first.token! })).replayed, true);
  await org.removeMember(alice, wid, bob);
  await assert.rejects(org.accept(bob, { token: first.token! }), errorCode("invitation_already_used"));
  const next = await org.invite(alice, wid, { key: randomUUID(), email: "bob@example.test" });
  await join(wid, carol); await org.member(alice, wid, carol, { access_level: "admin", business_role: "general" }); await transfer(wid,carol); await org.member(carol, wid, alice, { access_level: "member", business_role: "general" });
  await assert.rejects(org.accept(bob, { token: next.token! }), errorCode("invitation_sender_inactive"));
});

test("expired and revoked invites reject acceptance and cross-workspace same key conflicts", async () => {
  const wid = await create(), other = await create(); const key = randomUUID();
  const results = await Promise.allSettled([org.invite(alice, wid, { key, email: "bob@example.test" }), org.invite(alice, other, { key, email: "bob@example.test" })]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(results.filter(x => x.status === "rejected" && errorCode("idempotency_conflict")(x.reason)).length, 1);
  const expired = await org.invite(alice, wid, { key: randomUUID(), email: "bob@example.test" });
  await pool.query("UPDATE org_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
  await assert.rejects(org.accept(bob, { token: expired.token! }), errorCode("invitation_unavailable"));
  const revoked = await org.invite(alice, wid, { key: randomUUID(), email: "bob@example.test" }); await org.revokeInvitation(alice, wid, revoked.id);
  await assert.rejects(org.accept(bob, { token: revoked.token! }), errorCode("invitation_unavailable"));
});

test("run workspace and private owner boundaries survive replay, list and membership revocation", async () => {
  const wid = await create(), other = await create(); await join(wid); const request = input();
  await assert.rejects(runs.submit(alice, request), errorCode("workspace_required"));
  const accepted = await runs.submit(alice, request, wid);
  assert.deepEqual(await runs.list(alice), { runs: [] }); assert.equal((await runs.list(alice, wid)).runs.length, 1);
  await assert.rejects(runs.get(alice, accepted.run_id, other), errorCode("run_not_found"));
  await assert.rejects(runs.get(bob, accepted.run_id, wid), errorCode("run_not_found"));
  await assert.rejects(runs.submit(alice, request, other), errorCode("run_not_found"));
  assert.equal((await runs.submit(alice, request, wid)).replayed, true);
  await org.member(alice, wid, bob, { access_level: "admin", business_role: "general" }); await transfer(wid,bob); await org.leave(alice, wid);
  await assert.rejects(runs.get(alice, accepted.run_id, wid), errorCode("workspace_not_found"));
  await assert.rejects(runs.recover(alice, accepted.run_id, wid), errorCode("workspace_not_found"));
});

test("revocation prevents every new external effect while cleanup and terminal storage remain available", async () => {
  for (const operation of ["create", "resume", "stage", "egress_prepare", "egress_allow", "start"]) {
    const wid = await create(bob); await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [wid, alice]);
    const accepted = await runs.submit(alice, input(), wid); const c = await call("ax_claim", ["controller", 30]);
    await org.removeMember(bob, wid, alice);
    await assert.rejects(call("ax_intent", [accepted.run_id, c.generation, "controller", operation]), sqlError("workspace_access_revoked"));
    await call("ax_fail", [accepted.run_id, c.generation, "controller", "workspace_access_revoked"]);
    for (const cleanup of ["egress_deny", "suspend"]) {
      const permit = await call("ax_intent", [accepted.run_id, c.generation, "controller", cleanup]);
      const evidence = cleanup === "egress_deny" ? { actor: accepted.run_id, egress_denied: true } : { actor: accepted.run_id, phase: "SUSPENDED", worker_assignment: null };
      await call("ax_evidence", [accepted.run_id, c.generation, "controller", permit.operation_id, evidence]);
    }
    assert.equal((await call("ax_finish", [accepted.run_id, c.generation, "controller"])).resolved, true);
    await pool.query("TRUNCATE org_workspaces,ax_runs,ax_conversations CASCADE");
    await pool.query("INSERT INTO ax_execution_slot VALUES(true,NULL,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL,hold_reason=NULL");
  }
});

test("v2 migration retains v1 checksum, has no public functions and runtime grants exclude old entry points", async () => {
  assert.deepEqual((await pool.query("SELECT version FROM ax_migrations ORDER BY version")).rows.map(x => x.version), [1, 2, 3]);
  assert.ok(!apiFunctions.includes("ax_accept")); assert.ok(!executionFunctions.includes("ax_intent_v1"));
  const functions = (await pool.query("SELECT proname,prosecdef,proconfig,proacl::text[] AS acl FROM pg_proc WHERE pronamespace=$1::regnamespace", [schema])).rows;
  for (const fn of functions.filter(x => /^(org_|ax_)/.test(x.proname))) {
    assert.ok(fn.acl && !fn.acl.some((x: string) => x.startsWith("=")), fn.proname);
    if (fn.prosecdef) assert.deepEqual(fn.proconfig, [`search_path=${schema}, pg_temp`]);
  }
});

test("unstarted cancellation checks claim and absence of every effect before releasing the global slot", async () => {
  const wid = await create(); await join(wid); const accepted = await runs.submit(bob, input(), wid);
  const c = await call("ax_claim", ["controller", 30]); await org.removeMember(alice, wid, bob);
  await assert.rejects(call("ax_intent", [accepted.run_id, c.generation, "controller", "create"]), sqlError("workspace_access_revoked"));
  await assert.rejects(call("ax_cancel_unstarted", [accepted.run_id, c.generation + 1, "controller"]), sqlError("stale_claim"));
  assert.deepEqual(await call("ax_cancel_unstarted", [accepted.run_id, c.generation, "controller"]), { resolved: true, outcome: "not_started" });
  assert.deepEqual((await pool.query("SELECT phase,cleanup,resolved FROM ax_runs WHERE run_id=$1", [accepted.run_id])).rows[0], { phase: "not_started", cleanup: { egress_denied: false, suspended: false }, resolved: true });
  const next = await runs.submit(alice, input(), wid); const d = await call("ax_claim", ["controller", 30]);
  await call("ax_intent", [next.run_id, d.generation, "controller", "create"]);
  await assert.rejects(call("ax_cancel_unstarted", [next.run_id, d.generation, "controller"]), sqlError("execution_already_claimed"));
  assert.equal((await pool.query("SELECT run_id FROM ax_execution_slot")).rows[0].run_id, next.run_id);
});

test("additive v1 migration preserves NULL-workspace private chat and recovery while closing old runtime entry points", async () => {
  const oldSchema = `legacy_test_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${oldSchema}`);
  const old = new pg.Pool({ ...connection, options: `-c search_path=${oldSchema}` });
  try {
    await migrateAuth(old);
    const source = readFileSync(new URL("../data/schema.sql", import.meta.url), "utf8");
    const client = await old.connect();
    try {
      await client.query("BEGIN"); await client.query(source);
      await client.query("CREATE TABLE ax_migrations(version integer PRIMARY KEY,digest text NOT NULL)");
      await client.query("INSERT INTO ax_migrations VALUES(1,$1)", [createHash("sha256").update(source).digest("hex")]);
      await client.query("INSERT INTO users(id,status,display_name,verified_email) VALUES($1,'active','Alice','alice@example.test')", [alice]);
      await client.query("UPDATE ax_control SET accepting=true");
      await client.query("COMMIT");
    } finally { client.release(); }
    const cid = randomUUID(), rid = `ax-run-${randomBytes(8).toString("hex")}`;
    const body = { key: randomUUID(), parent_run_id: null, text: "以前の会話", allow_model: true as const };
    await old.query("SELECT ax_accept($1,'chat',$2,$3,$4,$5)", [alice, cid, JSON.stringify(body), image, rid]);
    const before = (await old.query("SELECT request_bytes,owner_user_id,accepted_at FROM ax_runs WHERE run_id=$1", [rid])).rows[0];
    const roles = (await old.query("SELECT rolname FROM pg_roles WHERE rolname IN ('ax_api','ax_execution')")).rows.map(x => x.rolname as string);
    for (const role of roles) await old.query(`GRANT EXECUTE ON FUNCTION ax_accept(uuid,text,uuid,jsonb,text,text), ax_intent(text,bigint,text,text) TO ${role}`);
    await migrateData(old); await migrateData(old);
    assert.deepEqual((await old.query("SELECT request_bytes,owner_user_id,accepted_at FROM ax_runs WHERE run_id=$1", [rid])).rows[0], before);
    assert.equal((await old.query("SELECT workspace_id FROM ax_runs WHERE run_id=$1", [rid])).rows[0].workspace_id, null);
    const legacy = new DataRepository(old, { image }); const organizations = new WorkspaceRepository(old);
    assert.equal((await legacy.getConversation(alice, cid)).can_send, false);
    await legacy.recover(alice, rid); assert.equal((await legacy.get(alice, rid)).summary.state, "not_started");
    const wid = (await organizations.create(alice, { key: randomUUID(), name: "新会社" })).workspace.id;
    assert.equal((await legacy.listConversations(alice)).conversations.length, 1);
    assert.equal((await legacy.listConversations(alice, wid)).conversations.length, 0);
    await assert.rejects(legacy.submitChat(alice, cid, { ...body, parent_run_id: rid }), errorCode("workspace_required"));
    await assert.rejects(legacy.submitChat(alice, cid, { ...body, parent_run_id: rid }, wid), errorCode("conversation_not_found"));
    for (const role of roles) {
      const checks = await old.query("SELECT has_function_privilege($1,'ax_accept(uuid,text,uuid,jsonb,text,text)','EXECUTE') AS accept,has_function_privilege($1,'ax_intent_v1(text,bigint,text,text)','EXECUTE') AS old_intent", [role]);
      assert.deepEqual(checks.rows[0], { accept: false, old_intent: false });
      const functions = role === "ax_api" ? apiFunctions : executionFunctions;
      for (const name of functions) {
        const signature = (await old.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname=$2", [oldSchema, name])).rows[0].signature;
        await old.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
      }
      assert.equal((await old.query("SELECT has_table_privilege($1,'ax_runs','SELECT,INSERT,UPDATE,DELETE') AS direct", [role])).rows[0].direct, false);
      const forbidden = role === "ax_api" ? "ax_intent(text,bigint,text,text)" : "ax_ws_accept(uuid,text,uuid,jsonb,text,text,uuid)";
      assert.equal((await old.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, forbidden])).rows[0].allowed, false);
    }
  } finally { await old.end(); await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`); }
});

test("organization HTTP routes enforce identity, methods, strict input and current permissions", async () => {
  const config = readConfig({ WEB_PORT: "3410", API_PORT: "3411", INTERNAL_API_TOKEN: "test-api-token-".repeat(4), LOCAL_SESSION_SECRET: "test-session-secret-".repeat(4) });
  const app = createApi(config, undefined, undefined, undefined, async token => token === "bob" ? bob : alice, org);
  const headers = { host: "127.0.0.1:3411", authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" };
  const request = (path: string, method = "GET", body?: unknown, extra = {}) => app.request(`${config.apiOrigin}${path}`, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await request("/v1/workspaces", "POST", { key: randomUUID(), name: "会社", access_level: "admin" })).status, 400);
  assert.equal((await request("/v1/workspaces", "POST", { key: randomUUID(), name: "会社" }, { origin: config.webOrigin })).status, 403);
  assert.equal((await request("/v1/workspaces", "POST", { key: randomUUID(), name: "会社" }, { authorization: "invalid" })).status, 401);
  const created = await request("/v1/workspaces", "POST", { key: randomUUID(), name: "会社" }); assert.equal(created.status, 200);
  const wid = (await created.json()).workspace.id;
  assert.equal((await request("/v1/workspaces")).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid.toUpperCase()}`)).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}`, "POST", { name: "変更" })).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}`, "POST", { name: "変更" }, { "x-ax-access-token": "bob" })).status, 404);
  const invitation = await (await request(`/v1/workspaces/${wid}/invitations`, "POST", { key: randomUUID(), email: "bob@example.test" })).json();
  assert.equal((await request("/v1/invitations/accept", "POST", { token: invitation.token }, { "x-ax-access-token": "bob" })).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/members/${bob}`, "POST", { access_level: "member", business_role: "developer" })).status, 200);
  const group = (await (await request(`/v1/workspaces/${wid}/groups`, "POST", { key: randomUUID(), name: "開発" })).json()).group.id;
  assert.equal((await request(`/v1/workspaces/${wid}/groups/${group}`, "POST", { name: "企画" })).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/groups/${group}/members/${bob}`, "POST", { member: true })).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/groups/${group}`, "DELETE")).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/invitations/${invitation.id}`, "DELETE")).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/members/${bob}`, "DELETE")).status, 200);
  assert.equal((await request(`/v1/workspaces/${wid}/leave`, "POST", {})).status, 409);
  assert.equal((await request("/v1/invitations/accept")).status, 404);
  assert.equal((await request("/v1/workspaces/invalid")).status, 400);
});

test("workspace chat remains private and cannot cross workspace on get, list, replay or continuation", async () => {
  const wid = await create(), other = await create(); await join(wid);
  await org.member(alice, wid, bob, {access_level:"admin",business_role:"general"});
  const cid=randomUUID(), body={key:randomUUID(),parent_run_id:null,text:"非公開の会話",allow_model:true as const};
  const accepted=await runs.submitChat(alice,cid,body,wid);
  assert.equal((await runs.listConversations(alice,wid)).conversations.length,1);
  assert.equal((await runs.listConversations(alice,other)).conversations.length,0);
  assert.equal((await runs.listConversations(bob,wid)).conversations.length,0);
  await assert.rejects(runs.getConversation(bob,cid,wid),errorCode("conversation_not_found"));
  await assert.rejects(runs.getConversation(alice,cid,other),errorCode("conversation_not_found"));
  await assert.rejects(runs.submitChat(alice,cid,body,other),errorCode("conversation_not_found"));
  await runs.recover(alice,accepted.run_id,wid);
  await assert.rejects(runs.submitChat(alice,cid,{...body,key:randomUUID(),parent_run_id:accepted.run_id},other),errorCode("conversation_not_found"));
  assert.equal((await runs.submitChat(alice,cid,body,wid)).replayed,true);
});

test("owner cannot leave, be removed or demoted, including direct database constraint paths", async () => {
  const wid=await create(); await join(wid); await org.member(alice,wid,bob,{access_level:"admin",business_role:"developer"});
  await assert.rejects(org.leave(alice,wid),errorCode("workspace_owner_cannot_leave"));
  await assert.rejects(org.removeMember(bob,wid,alice),errorCode("workspace_owner_cannot_leave"));
  await assert.rejects(org.member(bob,wid,alice,{access_level:"member",business_role:"general"}),errorCode("workspace_owner_cannot_leave"));
  await assert.rejects(org.proposeOwnership(bob,wid,{key:randomUUID(),to_user_id:alice}),errorCode("workspace_owner_required"));
  await assert.rejects(pool.query("UPDATE org_workspaces SET owner_user_id=NULL WHERE id=$1",[wid]),(e:any)=>e.code==="23502");
  await assert.rejects(pool.query("UPDATE org_memberships SET access_level='member' WHERE workspace_id=$1 AND user_id=$2",[wid,alice]),sqlError("invalid_workspace_owner"));
  await assert.rejects(pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[wid,alice]),(e:any)=>e.code==="23503" || e.message==="invalid_workspace_owner");
  await assert.rejects(pool.query("UPDATE org_workspaces SET owner_user_id=$1 WHERE id=$2",[carol,wid]),(e:any)=>e.code==="23503" || e.message==="invalid_workspace_owner");
  assert.equal((await org.get(alice,wid)).workspace.owner_user_id,alice);
});

test("ownership proposals serialize same-key and pending conflicts, visible only to the two participants", async () => {
  const wid=await create(); await join(wid); await join(wid,carol);
  await assert.rejects(org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:alice}),errorCode("ownership_transfer_invalid_recipient"));
  await assert.rejects(org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:randomUUID()}),errorCode("ownership_transfer_invalid_recipient"));
  const key=randomUUID();
  const values=await Promise.all(Array.from({length:6},()=>org.proposeOwnership(alice,wid,{key,to_user_id:bob})));
  assert.equal(new Set(values.map(x=>x.transfer.id)).size,1); assert.equal(values.filter(x=>!x.replayed).length,1);
  await assert.rejects(org.proposeOwnership(alice,wid,{key,to_user_id:carol}),errorCode("idempotency_conflict"));
  await assert.rejects(org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:carol}),errorCode("ownership_transfer_pending"));
  assert.equal((await org.get(alice,wid)).ownership_transfer?.id,values[0].transfer.id);
  assert.equal((await org.get(bob,wid)).ownership_transfer?.id,values[0].transfer.id);
  assert.equal((await org.get(carol,wid)).ownership_transfer,null);
  await assert.rejects(org.respondOwnership(carol,wid,values[0].transfer.id,"accept"),errorCode("ownership_transfer_forbidden"));
  await assert.rejects(org.respondOwnership(alice,wid,values[0].transfer.id,"accept"),errorCode("ownership_transfer_forbidden"));
});

test("acceptance preserves roles, groups and private run/chat owners, confirmed replay never reapplies ownership", async () => {
  const wid=await create(); await join(wid);
  await org.member(alice,wid,bob,{access_level:"member",business_role:"developer"});
  const group=(await org.createGroup(alice,wid,{key:randomUUID(),name:"開発"})).group;
  await org.groupMember(alice,wid,group.id,bob,{member:true});
  const cid=randomUUID(), body={key:randomUUID(),parent_run_id:null,text:"非公開",allow_model:true as const};
  const run=await runs.submitChat(alice,cid,body,wid); await runs.recover(alice,run.run_id,wid);
  const before=(await pool.query("SELECT row_to_json(r) AS value FROM ax_runs r WHERE run_id=$1",[run.run_id])).rows[0].value;
  const key=randomUUID(); const pending=await org.proposeOwnership(alice,wid,{key,to_user_id:bob});
  await org.respondOwnership(bob,wid,pending.transfer.id,"accept");
  const detail=await org.get(bob,wid);
  assert.equal(detail.workspace.owner_user_id,bob); assert.equal(detail.workspace.business_role,"developer"); assert.equal(detail.workspace.access_level,"admin");
  assert.deepEqual(detail.groups[0].member_user_ids,[bob]); assert.equal(detail.ownership_transfer,null);
  assert.equal((await org.get(alice,wid)).workspace.access_level,"admin");
  assert.deepEqual((await pool.query("SELECT row_to_json(r) AS value FROM ax_runs r WHERE run_id=$1",[run.run_id])).rows[0].value,before);
  assert.equal((await runs.getConversation(alice,cid,wid)).turns[0].user,"非公開");
  await assert.rejects(runs.getConversation(bob,cid,wid),errorCode("conversation_not_found"));
  await assert.rejects(runs.get(bob,run.run_id,wid),errorCode("run_not_found"));
  assert.equal((await org.proposeOwnership(alice,wid,{key,to_user_id:bob})).transfer.status,"accepted");
  await transfer(wid,alice,bob);
  await org.respondOwnership(bob,wid,pending.transfer.id,"accept");
  assert.equal((await org.get(alice,wid)).workspace.owner_user_id,alice);
  await assert.rejects(org.respondOwnership(bob,wid,pending.transfer.id,"reject"),errorCode("ownership_transfer_unavailable"));
});

test("cancel, reject and expiry are terminal, proposal replay returns every terminal state", async () => {
  const wid=await create(); await join(wid);
  for(const action of ["cancel","reject"] as const) {
    const key=randomUUID(); const proposal=await org.proposeOwnership(alice,wid,{key,to_user_id:bob});
    const actor=action==="cancel"?alice:bob;
    await org.respondOwnership(actor,wid,proposal.transfer.id,action); await org.respondOwnership(actor,wid,proposal.transfer.id,action);
    assert.equal((await org.get(alice,wid)).ownership_transfer,null);
    assert.equal((await org.proposeOwnership(alice,wid,{key,to_user_id:bob})).transfer.status,action==="cancel"?"cancelled":"rejected");
    await assert.rejects(org.respondOwnership(bob,wid,proposal.transfer.id,"accept"),errorCode("ownership_transfer_unavailable"));
  }
  const key=randomUUID(); const expired=await org.proposeOwnership(alice,wid,{key,to_user_id:bob});
  await pool.query("UPDATE org_ownership_transfers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.transfer.id]);
  assert.equal((await org.get(bob,wid)).ownership_transfer,null);
  assert.equal((await org.proposeOwnership(alice,wid,{key,to_user_id:bob})).transfer.status,"expired");
  await assert.rejects(org.respondOwnership(bob,wid,expired.transfer.id,"accept"),errorCode("ownership_transfer_unavailable"));
  assert.equal((await org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:bob})).transfer.status,"pending");
});

test("removing or leaving a recipient cancels pending ownership permanently across rejoining", async () => {
  const wid=await create(); await join(wid);
  for(const action of ["remove","leave"]) {
    const key=randomUUID(); const value=await org.proposeOwnership(alice,wid,{key,to_user_id:bob});
    if(action==="remove") await org.removeMember(alice,wid,bob); else await org.leave(bob,wid);
    await join(wid);
    assert.equal((await org.get(bob,wid)).ownership_transfer,null);
    assert.equal((await org.proposeOwnership(alice,wid,{key,to_user_id:bob})).transfer.status,"cancelled");
    await assert.rejects(org.respondOwnership(bob,wid,value.transfer.id,"accept"),errorCode("ownership_transfer_unavailable"));
  }
});

test("concurrent creation and two incoming transfers share the fiftieth ownership slot; invitations remain unlimited", async () => {
  for(let i=0;i<49;i++) await create(bob);
  const first=await create(),second=await create(); await join(first); await join(second);
  const a=await org.proposeOwnership(alice,first,{key:randomUUID(),to_user_id:bob});
  const b=await org.proposeOwnership(alice,second,{key:randomUUID(),to_user_id:bob});
  const results=await Promise.allSettled([create(bob),org.respondOwnership(bob,first,a.transfer.id,"accept"),org.respondOwnership(bob,second,b.transfer.id,"accept")]);
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(results.filter(x=>x.status==="rejected" && errorCode("workspace_ownership_limit")(x.reason)).length,2);
  const more=await create(); await join(more);
  const list=await org.list(bob); assert.equal(list.owned_count,50); assert.ok(list.workspaces.length>50);
});

test("concurrent accept/cancel and accept/removal have one coherent winner without reviving a transfer", async () => {
  const wid=await create(); await join(wid);
  let value=await org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:bob});
  const actions=await Promise.allSettled([org.respondOwnership(bob,wid,value.transfer.id,"accept"),org.respondOwnership(alice,wid,value.transfer.id,"cancel")]);
  assert.equal(actions.filter(x=>x.status==="fulfilled").length,1);
  let owner=(await org.get(alice,wid)).workspace.owner_user_id;
  if(owner===bob) await transfer(wid,alice,bob);
  value=await org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:bob});
  const membership=await Promise.allSettled([org.respondOwnership(bob,wid,value.transfer.id,"accept"),org.removeMember(alice,wid,bob)]);
  assert.equal(membership.filter(x=>x.status==="fulfilled").length,1);
  owner=(await org.get(alice,wid)).workspace.owner_user_id;
  const t=(await pool.query("SELECT status FROM org_ownership_transfers WHERE id=$1",[value.transfer.id])).rows[0].status;
  assert.equal(t,owner===bob?"accepted":"cancelled");
});

test("a disabled former sender cannot create a new ownership effect from an earlier proposal", async () => {
  const wid=await create(); await join(wid); const pending=await org.proposeOwnership(alice,wid,{key:randomUUID(),to_user_id:bob});
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1",[alice]);
  await assert.rejects(org.respondOwnership(bob,wid,pending.transfer.id,"accept"),errorCode("ownership_transfer_unavailable"));
  assert.equal((await org.get(bob,wid)).workspace.owner_user_id,alice);
  assert.equal((await org.list(bob)).owned_count,0);
  await org.respondOwnership(bob,wid,pending.transfer.id,"reject");
});

test("v3 migration rolls back completely for inactive, demoted or departed creators and preserves valid private records", async () => {
  const oldSchema=`ownership_migrate_${randomBytes(8).toString("hex")}`; await admin.query(`CREATE SCHEMA ${oldSchema}`);
  const old=new pg.Pool({...connection,options:`-c search_path=${oldSchema}`});
  try {
    await migrateAuth(old); const client=await old.connect();
    try {
      await client.query("BEGIN"); await client.query("CREATE TABLE ax_migrations(version integer PRIMARY KEY,digest text NOT NULL)");
      for(const [i,name] of ["schema.sql","schema-v2.sql"].entries()) {
        const source=readFileSync(new URL(`../data/${name}`,import.meta.url),"utf8"); await client.query(source);
        await client.query("INSERT INTO ax_migrations VALUES($1,$2)",[i+1,createHash("sha256").update(source).digest("hex")]);
      }
      await client.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Alice'),($2,'active','Bob'),($3,'active','Carol')",[alice,bob,carol]);
      await client.query("UPDATE ax_control SET accepting=true"); await client.query("COMMIT");
    } catch(e) {await client.query("ROLLBACK");throw e;} finally {client.release();}
    const valid=randomUUID(), invalid=randomUUID();
    await old.query("SELECT org_create($1,$2,'valid',$3)",[alice,randomUUID(),valid]);
    await old.query("SELECT org_create($1,$2,'invalid',$3)",[bob,randomUUID(),invalid]);
    await old.query("INSERT INTO org_memberships VALUES($1,$2,'admin','general')",[invalid,carol]);
    const rid=`ax-run-${randomBytes(8).toString("hex")}`;
    await old.query("SELECT ax_ws_accept($1,'run',NULL,$2,$3,$4,$5)",[alice,JSON.stringify(input()),image,rid,valid]);
    const before=(await old.query("SELECT row_to_json(r) AS value FROM ax_runs r WHERE run_id=$1",[rid])).rows[0].value;
    const roles=(await old.query("SELECT rolname FROM pg_roles WHERE rolname IN ('ax_api','ax_execution')")).rows.map(x=>x.rolname);
    for(const role of roles) await old.query(`GRANT EXECUTE ON FUNCTION org_detail(uuid,uuid),org_mutate(uuid,uuid,text,uuid,jsonb) TO ${role}`);
    for(const condition of ["inactive","demoted","departed"]) {
      if(condition==="inactive") await old.query("UPDATE users SET status='disabled' WHERE id=$1",[bob]);
      if(condition==="demoted") await old.query("UPDATE org_memberships SET access_level='member' WHERE workspace_id=$1 AND user_id=$2",[invalid,bob]);
      if(condition==="departed") await old.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[invalid,bob]);
      await assert.rejects(migrateData(old),sqlError("workspace_owner_migration_required"));
      assert.deepEqual((await old.query("SELECT version FROM ax_migrations ORDER BY version")).rows.map(x=>x.version),[1,2]);
      assert.equal((await old.query("SELECT count(*) AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='org_workspaces' AND column_name='owner_user_id'",[oldSchema])).rows[0].n,"0");
      assert.equal((await old.query("SELECT org_list($1) AS value",[alice])).rows[0].value.creation_limit,3);
      await old.query("UPDATE users SET status='active' WHERE id=$1",[bob]);
      await old.query("INSERT INTO org_memberships VALUES($1,$2,'admin','general') ON CONFLICT(workspace_id,user_id) DO UPDATE SET access_level='admin'",[invalid,bob]);
    }
    await migrateData(old); await migrateData(old);
    assert.deepEqual((await old.query("SELECT row_to_json(r) AS value FROM ax_runs r WHERE run_id=$1",[rid])).rows[0].value,before);
    assert.equal((await old.query("SELECT owner_user_id FROM org_workspaces WHERE id=$1",[valid])).rows[0].owner_user_id,alice);
    assert.equal((await old.query("SELECT owner_user_id FROM org_workspaces WHERE id=$1",[invalid])).rows[0].owner_user_id,bob);
    for(const role of roles) for(const name of ["org_detail_v2(uuid,uuid)","org_mutate_v2(uuid,uuid,text,uuid,jsonb)"]) {
      assert.equal((await old.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,name])).rows[0].allowed,false);
    }
  } finally {await old.end();await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`);}
});


test("restricted ax_api commits workspace creation and ownership acceptance with deferred constraints", async () => {
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ax_api`);
  const signatures=(await pool.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname=ANY($2)",[schema,apiFunctions])).rows;
  for(const {signature} of signatures) await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ax_api`);
  const transaction=(sql: string) => execFileSync("docker",["exec","-i",process.env.POSTGRES_CONTAINER ?? "ax-local-postgres","psql","-X","-At","-v","ON_ERROR_STOP=1","-U","postgres","-d","app_auth_test"],{
    input:`BEGIN; SET LOCAL search_path=${schema},pg_temp; SET LOCAL ROLE ax_api; SELECT current_user; ${sql} COMMIT;`,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:10000,
  });
  const wid=randomUUID(),transferId=randomUUID();
  const created=transaction(`SELECT org_create('${alice}','${randomUUID()}','Restricted','${wid}');`);
  assert.ok(created.includes("ax_api")); assert.ok(created.trim().endsWith("COMMIT"));
  assert.equal((await org.get(alice,wid)).workspace.owner_user_id,alice);
  await join(wid);
  transaction(`SELECT org_propose_ownership('${alice}','${wid}','${randomUUID()}','${bob}','${transferId}');`);
  const accepted=transaction(`SELECT org_respond_ownership('${bob}','${wid}','${transferId}','accept');`);
  assert.ok(accepted.trim().endsWith("COMMIT"));
  assert.equal((await org.get(bob,wid)).workspace.owner_user_id,bob);
  assert.equal((await org.get(bob,wid)).workspace.access_level,"admin");
  assert.throws(()=>transaction("SELECT * FROM org_workspaces;"),(e:any)=>e.status===3 && String(e.stderr).includes("permission denied for table org_workspaces"));
  assert.throws(()=>transaction(`SELECT org_mutate('${alice}','${wid}','remove_member','${bob}','{}');`),(e:any)=>e.status===3 && String(e.stderr).includes("workspace_owner_cannot_leave"));
});
