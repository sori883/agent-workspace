import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { DefinitionRepository } from "../data/definitions";
import { FileRepository } from "../data/files";
import { DataRepository } from "../data/repository";
import { WorkspaceRepository } from "../data/workspaces";
import { canonical } from "../data/canonical";
import { RunServiceError } from "../api/run-service";
import { definitionCreateSchema, renderSkillMarkdown, type SkillContent, type AgentContent } from "../shared/definition-contracts";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { prepareTestAuth } from "./prepare-auth";

const schema = `definitions_test_${randomBytes(8).toString("hex")}`;
const owner = randomUUID(), member = randomUUID(), adminId = randomUUID(), stranger = randomUUID();
let pool: pg.Pool, admin: pg.Pool, connection: pg.PoolConfig, repo: DefinitionRepository, org: WorkspaceRepository, workspace: string, second: string;
const skill = (name = "csv-summary"): SkillContent => ({ name, description: "CSV の集計", instructions: "入力を確認し、集計してください。", files: [{ path: "references/columns.md", content: "列は売上と部門です。\n" }, { path: "scripts/sample.py", content: "print('not executed')\n" }] });
const agent = (skills: string[] = []): AgentContent => ({ name: "集計担当", instructions: "渡されたCSVを集計してください。", skill_version_ids: skills, allowed_tools: ["python"] });
const denied = (code: string) => (e: unknown) => e instanceof RunServiceError && e.code === code;
const sqlDenied = (code: string) => (e: unknown) => e instanceof Error && e.message === code;
const rev = (revision: number) => ({ key: randomUUID(), expected_revision: revision });
async function create(visibility: "personal" | "workspace" = "personal", actor = owner, wid = workspace, content = skill()) {
  return repo.create(actor, wid, { key: randomUUID(), kind: "skill", visibility, content });
}
async function published(visibility: "personal" | "workspace" = "personal", actor = owner, wid = workspace) {
  const created = await create(visibility, actor, wid);
  return repo.publish(actor, wid, created.definition.id, rev(created.definition.revision!));
}
before(async () => {
  const { caPath, ...database } = prepareTestAuth().database;
  connection = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 12, statement_timeout: 15000 };
  admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  await migrateAuth(pool); await migrateData(pool);
  if (!(await pool.query("SELECT to_regclass('ax_definitions') present")).rows[0].present) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query(readFileSync(new URL("../data/schema-v7.sql", import.meta.url), "utf8")); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Owner'),($2,'active','Member'),($3,'active','Admin'),($4,'active','Stranger')", [owner, member, adminId, stranger]);
  org = new WorkspaceRepository(pool); repo = new DefinitionRepository(pool, undefined, { legacyWrites: true });
  workspace = (await org.create(owner, { key: randomUUID(), name: "A" })).workspace.id;
  second = (await org.create(owner, { key: randomUUID(), name: "B" })).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general'),($1,$3,'admin','general')", [workspace, member, adminId]);
});
beforeEach(async () => {
  await pool.query("TRUNCATE ax_definitions CASCADE");
  await pool.query("UPDATE users SET status='active'");
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general'),($1,$3,'admin','general') ON CONFLICT (workspace_id,user_id) DO UPDATE SET access_level=EXCLUDED.access_level", [workspace, member, adminId]);
});
after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

test("private draft and immutable published skill round-trip with deterministic SKILL.md", async () => {
  const created = await create(), id = created.definition.id;
  assert.equal(created.definition.revision, 1); assert.equal(created.definition.can_edit, true); assert.equal(created.version, null);
  const detail = await repo.get(owner, workspace, id); assert.deepEqual(detail.draft?.content, skill()); assert.equal(detail.version, null);
  const first = await repo.publish(owner, workspace, id, rev(1)); assert.equal(first.version?.version, 1); assert.equal(first.definition.revision, 2);
  assert.equal(first.version?.sha256, createHash("sha256").update(canonical(skill(), true)).digest("hex"));
  assert.deepEqual((await repo.getVersion(owner, workspace, first.version!.id)).content, skill());
  const changed = { ...skill("renamed-draft"), instructions: "新しい指示" };
  await repo.updateDraft(owner, workspace, id, { ...rev(2), content: changed });
  assert.deepEqual((await repo.getVersion(owner, workspace, first.version!.id)).content, skill());
  const updated = await repo.get(owner, workspace, id);
  assert.equal(updated.draft?.revision, 3);
  assert.equal(updated.definition.name, "renamed-draft");
  assert.equal(updated.definition.latest_version?.name, "csv-summary");
  assert.equal((await repo.list(owner, workspace)).definitions[0].latest_version?.name, "csv-summary");
  assert.equal(renderSkillMarkdown(skill()), '---\nname: "csv-summary"\ndescription: "CSV の集計"\n---\n\n入力を確認し、集計してください。\n');
  await assert.rejects(pool.query("UPDATE ax_definition_versions SET content='{}' WHERE id=$1", [first.version!.id]), sqlDenied("immutable_definition"));
  await assert.rejects(pool.query("DELETE FROM ax_definition_versions WHERE id=$1", [first.version!.id]), sqlDenied("immutable_definition"));
  await assert.rejects(pool.query("UPDATE ax_definitions SET visibility='workspace' WHERE id=$1", [id]), sqlDenied("immutable_definition"));
});

test("private definitions remain private from admins and across workspaces for every operation", async () => {
  const p = await published(), id = p.definition.id;
  for (const [who, wid] of [[member, workspace], [adminId, workspace], [owner, second], [stranger, workspace]]) {
    await assert.rejects(repo.get(who, wid, id), denied("definition_not_found"));
    await assert.rejects(repo.getVersion(who, wid, p.version!.id), denied("definition_not_found"));
    await assert.rejects(repo.updateDraft(who, wid, id, { ...rev(2), content: skill() }), e => e instanceof RunServiceError && ["definition_not_found", "workspace_not_found"].includes(e.code));
    await assert.rejects(repo.publish(who, wid, id, rev(2)), e => e instanceof RunServiceError && ["definition_not_found", "workspace_not_found"].includes(e.code));
    await assert.rejects(repo.archive(who, wid, id, rev(2)), e => e instanceof RunServiceError && ["definition_not_found", "workspace_not_found"].includes(e.code));
  }
  assert.deepEqual((await repo.list(adminId, workspace)).definitions, []);
  assert.deepEqual((await repo.list(owner, second)).definitions, []);
});

test("members register shared skills; only creator and current admins see and change drafts", async () => {
  const c = await create("workspace", member), id = c.definition.id;
  assert.equal((await repo.get(adminId, workspace, id)).draft?.revision, 1);
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace, stranger]);
  assert.deepEqual((await repo.list(stranger, workspace)).definitions, []);
  await assert.rejects(repo.get(stranger, workspace, id), denied("definition_not_found"));
  await assert.rejects(repo.publish(stranger, workspace, id, rev(1)), denied("definition_forbidden"));
  const p = await repo.publish(adminId, workspace, id, rev(1));
  await repo.updateDraft(member, workspace, id, { ...rev(2), content: skill("hidden-draft") });
  const read = await repo.get(stranger, workspace, id);
  assert.equal(read.draft, null); assert.equal(read.definition.revision, null); assert.equal(read.definition.name, "csv-summary"); assert.equal(read.definition.can_edit, false);
  assert.deepEqual((await repo.getVersion(stranger, workspace, p.version!.id, { forUse: true })).content, skill());
  await org.removeMember(owner, workspace, member);
  assert.equal((await repo.get(stranger, workspace, id)).version!.id, p.version!.id);
  await assert.rejects(repo.get(member, workspace, id), denied("workspace_not_found"));
  await repo.updateDraft(adminId, workspace, id, { ...rev(3), content: skill("admin-updated") });
  await pool.query("UPDATE org_memberships SET access_level='member' WHERE workspace_id=$1 AND user_id=$2", [workspace, adminId]);
  assert.equal((await repo.get(adminId, workspace, id)).draft, null);
  await assert.rejects(repo.archive(adminId, workspace, id, rev(4)), denied("definition_forbidden"));
});

test("mutation keys and CAS prevent duplicates and lost writes, including retries after archive", async () => {
  const input = { key: randomUUID(), kind: "skill" as const, visibility: "workspace" as const, content: skill() };
  const created = await Promise.all(Array.from({ length: 6 }, () => repo.create(owner, workspace, input)));
  assert.equal(new Set(created.map(x => x.definition.id)).size, 1); assert.equal(created.filter(x => !x.replayed).length, 1);
  const id = created[0].definition.id;
  await assert.rejects(repo.create(owner, second, input), denied("idempotency_conflict"));
  await assert.rejects(repo.create(owner, workspace, { ...input, content: skill("different") }), denied("idempotency_conflict"));
  const edits = await Promise.allSettled([repo.updateDraft(owner, workspace, id, { ...rev(1), content: skill("one") }), repo.updateDraft(adminId, workspace, id, { ...rev(1), content: skill("two") })]);
  assert.equal(edits.filter(x => x.status === "fulfilled").length, 1);
  assert.ok(edits.some(x => x.status === "rejected" && denied("definition_revision_conflict")(x.reason)));
  const publishKey = rev(2), published = await Promise.all(Array.from({ length: 5 }, () => repo.publish(owner, workspace, id, publishKey)));
  assert.equal(new Set(published.map(x => x.version!.id)).size, 1); assert.equal(published.filter(x => !x.replayed).length, 1);
  const archiveKey = rev(3), archived = await repo.archive(owner, workspace, id, archiveKey);
  assert.ok(archived.definition.archived_at); assert.equal((await repo.archive(owner, workspace, id, archiveKey)).replayed, true);
  assert.equal((await repo.publish(owner, workspace, id, publishKey)).version!.id, published[0].version!.id);
  await assert.rejects(repo.updateDraft(owner, workspace, id, { ...rev(4), content: skill() }), denied("definition_archived"));
  assert.equal((await repo.list(owner, workspace)).definitions.length, 0); assert.equal((await repo.list(owner, workspace, { include_archived: true })).definitions.length, 1);
  await assert.rejects(repo.getVersion(owner, workspace, published[0].version!.id, { forUse: true }), denied("definition_archived"));
  assert.ok(await repo.getVersion(member, workspace, published[0].version!.id));
});

test("agent dependencies enforce workspace and shared closure at draft, publish and new use", async () => {
  const personal = await published(), shared = await published("workspace"), foreign = await published("workspace", owner, second);
  const privateAgent = await repo.create(owner, workspace, { key: randomUUID(), kind: "agent", visibility: "personal", content: agent([personal.version!.id, shared.version!.id]) });
  const sharedAgent = await repo.create(member, workspace, { key: randomUUID(), kind: "agent", visibility: "workspace", content: agent([shared.version!.id]) });
  for (const bad of [personal.version!.id, foreign.version!.id, randomUUID()]) {
    await assert.rejects(repo.create(owner, workspace, { key: randomUUID(), kind: "agent", visibility: "workspace", content: agent([bad]) }), denied("definition_dependency_unavailable"));
  }
  await assert.rejects(repo.create(member, workspace, { key: randomUUID(), kind: "agent", visibility: "personal", content: agent([personal.version!.id]) }), denied("definition_dependency_unavailable"));
  const pv = await repo.publish(owner, workspace, privateAgent.definition.id, rev(1));
  const sv = await repo.publish(member, workspace, sharedAgent.definition.id, rev(1));
  await assert.rejects(repo.updateDraft(member, workspace, sharedAgent.definition.id, { ...rev(2), content: agent([personal.version!.id]) }), denied("definition_dependency_unavailable"));
  await assert.rejects(repo.create(owner, workspace, { key: randomUUID(), kind: "agent", visibility: "personal", content: agent([pv.version!.id]) }), denied("definition_dependency_unavailable"));
  await repo.archive(owner, workspace, shared.definition.id, rev(2));
  await assert.rejects(repo.publish(member, workspace, sharedAgent.definition.id, rev(2)), denied("definition_dependency_unavailable"));
  await assert.rejects(repo.getVersion(member, workspace, sv.version!.id, { forUse: true }), denied("definition_dependency_unavailable"));
  assert.ok(await repo.getVersion(member, workspace, sv.version!.id));
});

test("membership and active-user revocation applies to mutation replay and version reads", async () => {
  const input = { key: randomUUID(), kind: "skill" as const, visibility: "workspace" as const, content: skill() };
  const c = await repo.create(member, workspace, input), p = await repo.publish(member, workspace, c.definition.id, rev(1));
  await org.removeMember(owner, workspace, member);
  await assert.rejects(repo.create(member, workspace, input), denied("workspace_not_found"));
  await assert.rejects(repo.list(member, workspace), denied("workspace_not_found"));
  await assert.rejects(repo.getVersion(member, workspace, p.version!.id), denied("workspace_not_found"));
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace, member]);
  assert.equal((await repo.create(member, workspace, input)).replayed, true);
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [member]);
  await assert.rejects(repo.create(member, workspace, input), denied("invalid_owner_user_id"));
  await assert.rejects(repo.getVersion(member, workspace, p.version!.id), denied("invalid_owner_user_id"));
});

test("payload bounds reject traversal, duplicates, nontext data, unknown fields and mismatched kinds", async () => {
  const invalid: unknown[] = [
    { ...skill(), name: "Upper" }, { ...skill(), instructions: "" }, { ...skill(), instructions: "\u00a0\u3000" }, { ...skill(), instructions: "あ".repeat(5462) },
    { ...skill(), description: "a".repeat(1025) }, { ...skill(), files: [{ path: "scripts/../run.py", content: "x" }] },
    { ...skill(), files: [{ path: "SKILL.md", content: "x" }] }, { ...skill(), files: [{ path: "/assets/a", content: "x" }] },
    { ...skill(), files: [{ path: "references//x", content: "x" }] }, { ...skill(), files: [{ path: "assets/x", content: "a".repeat(32769) }] },
    { ...skill(), files: [{ path: "assets/x", content: "a" }, { path: "assets/x", content: "b" }] },
    { ...skill(), files: Array.from({ length: 17 }, (_, i) => ({ path: `assets/${i}`, content: "" })) },
    { ...skill(), file_id: randomUUID() }, { ...skill(), files: [{ path: "assets/x", content: 3 }] },
    { ...skill(), files: Array.from({ length: 4 }, (_, i) => ({ path: `assets/${i}`, content: "a".repeat(32768) })) },
  ];
  for (const content of invalid) {
    const input = { key: randomUUID(), kind: "skill", visibility: "personal", content };
    assert.equal(definitionCreateSchema.safeParse(input).success, false);
    await assert.rejects(pool.query("SELECT ax_definition_create($1,$2,$3,$4)", [owner, workspace, input, randomUUID()]), sqlDenied("invalid_request"));
  }
  for (const value of ["\0", "\ud800"]) assert.equal(definitionCreateSchema.safeParse({ key: randomUUID(), kind: "skill", visibility: "personal", content: { ...skill(), instructions: value } }).success, false);
  const d = await create();
  await assert.rejects(repo.updateDraft(owner, workspace, d.definition.id, { ...rev(1), content: agent() }), denied("invalid_request"));
  for (const content of [{ ...agent(), allowed_tools: ["shell"] }, { ...agent(), skill_version_ids: Array(9).fill(randomUUID()) }, { ...agent(), skill_version_ids: [owner, owner] }]) {
    await assert.rejects(pool.query("SELECT ax_definition_create($1,$2,$3,$4)", [owner, workspace, { key: randomUUID(), kind: "agent", visibility: "personal", content }, randomUUID()]), sqlDenied("invalid_request"));
  }
});

test("list filters and cursor never expose another personal draft or unpublished shared draft", async () => {
  await create("personal", member);
  await create("workspace", member);
  for (let i = 0; i < 4; i++) await published("workspace");
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING", [workspace, stranger]);
  const page = await repo.list(stranger, workspace, { kind: "skill", filter: "workspace", limit: 2 });
  assert.equal(page.definitions.length, 2); assert.ok(page.next_cursor);
  const next = await repo.list(stranger, workspace, { before: page.next_cursor!, limit: 2 });
  assert.equal(next.definitions.length, 2); assert.equal(next.next_cursor, null);
  assert.equal(new Set([...page.definitions, ...next.definitions].map(x => x.id)).size, 4);
  assert.equal((await repo.list(stranger, workspace, { filter: "personal" })).definitions.length, 0);
  assert.equal((await repo.list(stranger, workspace, { kind: "agent" })).definitions.length, 0);
  const privateId = (await create()).definition.id;
  await assert.rejects(repo.list(stranger, workspace, { before: privateId }), denied("definition_not_found"));
  for (const options of [{ kind: null }, { filter: null }, { limit: 51 }, { owner_user_id: owner }]) await assert.rejects(pool.query("SELECT ax_definition_list($1,$2,$3)", [owner, workspace, options]), sqlDenied("invalid_request"));
});

test("one hundred definitions include archived records and serialize concurrent creation", async () => {
  for (let i = 0; i < 99; i++) await create();
  const results = await Promise.allSettled([create(), create()]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.ok(results.some(x => x.status === "rejected" && denied("definition_count_limit")(x.reason)));
  const first = (await repo.list(owner, workspace)).definitions[0]; await repo.archive(owner, workspace, first.id, rev(first.revision!));
  await assert.rejects(create(), denied("definition_count_limit"));
  assert.ok(await create("personal", owner, second)); assert.ok(await create("personal", member));
});

test("one hundred published versions cannot be bypassed by concurrent publish or retries", async () => {
  const p = await published(), id = p.definition.id;
  await pool.query("INSERT INTO ax_definition_versions SELECT gen_random_uuid(),definition_id,n,content,content_bytes,sha256,published_by_user_id,clock_timestamp() FROM ax_definition_versions CROSS JOIN generate_series(2,99) n WHERE id=$1", [p.version!.id]);
  const attempts = await Promise.allSettled([repo.publish(owner, workspace, id, rev(2)), repo.publish(owner, workspace, id, rev(2))]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const value = attempts.find(x => x.status === "fulfilled")!; assert.equal(value.value.version!.version, 100);
  await assert.rejects(repo.publish(owner, workspace, id, rev(3)), denied("definition_version_limit"));
  assert.equal(Number((await pool.query("SELECT count(*) n FROM ax_definition_versions WHERE definition_id=$1", [id])).rows[0].n), 100);
});

function sizedContent(size: number): SkillContent {
  const content: SkillContent = { name: "padding", description: "", instructions: "x", files: Array.from({ length: 4 }, (_, i) => ({ path: `assets/${i}`, content: "" })) };
  let remaining = size - Buffer.byteLength(canonical(content, true)); assert.ok(remaining >= 0);
  for (const file of content.files) { file.content = "x".repeat(Math.min(32768, remaining)); remaining -= file.content.length; }
  assert.equal(remaining, 0); assert.equal(Buffer.byteLength(canonical(content, true)), size);
  return content;
}

test("canonical payload accepts 131072 bytes and rejects the next byte in both boundaries", async () => {
  const content = sizedContent(131072);
  const input = { key: randomUUID(), kind: "skill" as const, visibility: "personal" as const, content };
  assert.equal(definitionCreateSchema.safeParse(input).success, true);
  const c = await repo.create(owner, workspace, input);
  const p = await repo.publish(owner, workspace, c.definition.id, rev(1));
  assert.deepEqual((await repo.getVersion(owner, workspace, p.version!.id)).content, content);
  const oversized = sizedContent(131073), invalid = { ...input, key: randomUUID(), content: oversized };
  assert.equal(definitionCreateSchema.safeParse(invalid).success, false);
  await assert.rejects(pool.query("SELECT ax_definition_create($1,$2,$3,$4)", [owner, workspace, invalid, randomUUID()]), sqlDenied("invalid_request"));
});

test("128 MiB canonical content quota includes every draft and published version atomically", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push((await create()).definition.id);
  const draftBytes = Number((await pool.query("SELECT sum(draft_bytes) n FROM ax_definitions")).rows[0].n);
  const acceptedBytes = Buffer.byteLength(canonical(skill(), true));
  const available = 134217728 - draftBytes - acceptedBytes;
  let full = Math.floor(available / 120000), rest = available % 120000;
  if (rest < 256) { full--; rest += 120000; }
  const padding = sizedContent(120000);
  await pool.query("INSERT INTO ax_definition_versions SELECT gen_random_uuid(),($1::uuid[])[i/100+1],i%100+1,$2::jsonb,120000,encode(sha256(convert_to(ax_definition_canonical($2::jsonb),'UTF8')),'hex'),$3,clock_timestamp() FROM generate_series(0,$4::integer-1) i", [ids, padding, owner, full]);
  const tail = sizedContent(rest);
  await pool.query("INSERT INTO ax_definition_versions VALUES($1,$2,$3,$4,$5,encode(sha256(convert_to(ax_definition_canonical($4::jsonb),'UTF8')),'hex'),$6,clock_timestamp())", [randomUUID(), ids[Math.floor(full / 100)], full % 100 + 1, tail, rest, owner]);
  const results = await Promise.allSettled([create(), create("personal", member)]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.ok(results.some(x => x.status === "rejected" && denied("definition_quota_exceeded")(x.reason)));
  assert.equal(Number((await pool.query("SELECT (SELECT sum(draft_bytes) FROM ax_definitions)+(SELECT sum(content_bytes) FROM ax_definition_versions) n")).rows[0].n), 134217728);
  await assert.rejects(repo.publish(owner, workspace, ids[11], rev(1)), denied("definition_quota_exceeded"));
  await repo.updateDraft(owner, workspace, ids[11], { ...rev(1), content: skill("same-length") });
});

test("limited API role can commit public operations but cannot access tables or private helpers", async () => {
  const names = ["ax_definition_list", "ax_definition_get", "ax_definition_create", "ax_definition_update", "ax_definition_publish", "ax_definition_archive", "ax_definition_version"];
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ax_api,ax_execution`);
  const fns = (await pool.query("SELECT oid::regprocedure::text signature,proname,prosecdef,proconfig,has_function_privilege('public',oid,'EXECUTE') public FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'ax_definition_%'", [schema])).rows;
  for (const f of fns) {
    assert.equal(f.public, false);
    if (names.includes(f.proname)) { assert.equal(f.prosecdef, true); assert.ok(f.proconfig.some((v: string) => v.startsWith("search_path="))); await pool.query(`GRANT EXECUTE ON FUNCTION ${f.signature} TO ax_api`); }
  }
  const transaction = (role: string, sql: string) => execFileSync("docker", ["exec", process.env.POSTGRES_CONTAINER ?? "ax-local-postgres", "psql", "-U", "postgres", "-d", "app_auth_test", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", `BEGIN; SET LOCAL ROLE ${role}; SET LOCAL search_path=${schema}; ${sql} COMMIT;`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const id = randomUUID(), input = { key: randomUUID(), kind: "skill", visibility: "personal", content: skill("role-test") };
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_definition_create('${owner}','${workspace}','${JSON.stringify(input).replaceAll("'", "''")}'::jsonb,'${id}');`)).definition.id, id);
  const p = JSON.parse(transaction("ax_api", `SELECT ax_definition_publish('${owner}','${workspace}','${id}','${JSON.stringify(rev(1))}','${randomUUID()}');`));
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_definition_version('${owner}','${workspace}','${p.version.id}',true);`)).id, p.version.id);
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_definition_get('${owner}','${workspace}','${id}');`)).definition.id, id);
  assert.equal(JSON.parse(transaction("ax_api", `SELECT ax_definition_list('${owner}','${workspace}','{}');`)).definitions.length, 1);
  transaction("ax_api", `SELECT ax_definition_update('${owner}','${workspace}','${id}','${JSON.stringify({ ...rev(2), content: skill("changed-role") }).replaceAll("'", "''")}');`);
  transaction("ax_api", `SELECT ax_definition_archive('${owner}','${workspace}','${id}','${JSON.stringify(rev(3))}');`);
  const permission = (e: unknown) => !!e && typeof e === "object" && "stderr" in e && String(e.stderr).includes("permission denied");
  assert.throws(() => transaction("ax_api", "SELECT * FROM ax_definitions;"), permission);
  assert.throws(() => transaction("ax_api", `SELECT ax_definition_mutate('${owner}','${workspace}','archive','${id}','{}');`), permission);
  assert.throws(() => transaction("ax_execution", `SELECT ax_definition_get('${owner}','${workspace}','${id}');`), permission);
});

test("v7 leaves existing v1-v6 checksums, runs, workspaces and file bytes untouched", async () => {
  const oldSchema = `definitions_v6_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${oldSchema}`); const old = new pg.Pool({ ...connection, options: `-c search_path=${oldSchema}` });
  try {
    await migrateAuth(old); const client = await old.connect();
    try {
      await client.query("BEGIN"); await client.query("CREATE TABLE ax_migrations(version integer PRIMARY KEY,digest text NOT NULL)");
      for (const [index, name] of ["schema.sql", "schema-v2.sql", "schema-v3.sql", "schema-v4.sql", "schema-v5.sql", "schema-v6.sql"].entries()) {
        const source = readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"); await client.query(source); await client.query("INSERT INTO ax_migrations VALUES($1,$2)", [index + 1, createHash("sha256").update(source).digest("hex")]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await old.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','old')", [owner]);
    const wid = (await new WorkspaceRepository(old).create(owner, { key: randomUUID(), name: "Old" })).workspace.id;
    await old.query("UPDATE ax_control SET accepting=true");
    await new DataRepository(old, { image: `localhost:5001/runner@sha256:${"a".repeat(64)}` }).submit(owner, { key: randomUUID(), mode: "offline", instruction: "old run", input_text: "old", output_name: "old.txt", allow_model: false }, wid);
    const files = new FileRepository(old), bytes = new Uint8Array([0, 255, 128]);
    const f = await files.begin(owner, wid, { key: randomUUID(), name: "old.xlsx", size_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await files.putChunk(owner, wid, f.file.id, 0, bytes); await files.seal(owner, wid, f.file.id);
    const tables = ["ax_migrations", "ax_runs", "org_workspaces", "ax_files", "ax_file_chunks"];
    const snapshots = await Promise.all(tables.map(table => old.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)));
    const migration = await old.connect();
    try { await migration.query("BEGIN"); await migration.query(readFileSync(new URL("../data/schema-v7.sql", import.meta.url), "utf8")); await migration.query("COMMIT"); }
    catch (error) { await migration.query("ROLLBACK"); throw error; } finally { migration.release(); }
    for (let i = 0; i < tables.length; i++) assert.deepEqual((await old.query(`SELECT to_jsonb(t) value FROM ${tables[i]} t ORDER BY to_jsonb(t)::text`)).rows, snapshots[i].rows);
    assert.deepEqual(await files.readChunk(owner, wid, f.file.id, 0), bytes);
    const definitions = new DefinitionRepository(old, undefined, { legacyWrites: true }); assert.deepEqual((await definitions.list(owner, wid)).definitions, []);
    assert.ok(await definitions.create(owner, wid, { key: randomUUID(), kind: "skill", visibility: "personal", content: skill() }));
  } finally { await old.end(); await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`); }
});

async function waitBlocked(pid: number) {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 blocked", [pid])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected workspace lock contention");
}

test("committed membership loss blocks waiting publication without creating a version", async () => {
  const c = await create("workspace", member);
  const removing = await pool.connect(), publishing = await pool.connect();
  try {
    await removing.query("BEGIN"); await removing.query("SELECT 1 FROM org_workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    await new WorkspaceRepository(removing).removeMember(owner, workspace, member);
    const pid = (await publishing.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const pending = new DefinitionRepository(publishing, undefined, { legacyWrites: true }).publish(member, workspace, c.definition.id, rev(1)); pending.catch(() => {});
    await waitBlocked(pid); await removing.query("COMMIT");
    await assert.rejects(pending, denied("workspace_not_found"));
    assert.equal((await repo.get(owner, workspace, c.definition.id)).version, null);
  } finally { await removing.query("ROLLBACK"); removing.release(); publishing.release(); }
});

test("concurrent dependency archive and publish cannot admit use of an archived skill", async () => {
  const s = await published("workspace");
  const a = await repo.create(member, workspace, { key: randomUUID(), kind: "agent", visibility: "workspace", content: agent([s.version!.id]) });
  const values = await Promise.allSettled([repo.archive(owner, workspace, s.definition.id, rev(2)), repo.publish(member, workspace, a.definition.id, rev(1))]);
  assert.equal(values[0].status, "fulfilled");
  if (values[1].status === "fulfilled") await assert.rejects(repo.getVersion(member, workspace, values[1].value.version!.id, { forUse: true }), denied("definition_dependency_unavailable"));
  else assert.ok(denied("definition_dependency_unavailable")(values[1].reason));
});
