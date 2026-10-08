import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { RunServiceError } from "../api/run-service";
import { DefinitionRepository } from "../data/definitions";
import { WorkspaceRepository } from "../data/workspaces";
import { canonical, sha256, utf8 } from "../data/canonical";
import { SkillStorage } from "../data/skill-storage";
import { skillManifestSchema, storedSkillContentSchema, type SkillObjectStore } from "../shared/skill-storage-contracts";
import type { SkillContent } from "../shared/definition-contracts";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { prepareTestAuth } from "./prepare-auth";

class MemoryStore implements SkillObjectStore {
  readonly storeId = "test-skills";
  readonly objects = new Map<string, Uint8Array>();
  reads = 0; fail = false;
  beforePut?: (key: string) => Promise<void>;
  beforeGet?: (key: string) => Promise<void>;
  async putImmutable(key: string, bytes: Uint8Array) {
    await this.beforePut?.(key);
    if (this.fail) throw new RunServiceError("skill_storage_unavailable");
    const previous = this.objects.get(key);
    if (previous) assert.deepEqual(previous, bytes);
    else this.objects.set(key, bytes.slice());
  }
  async get(key: string, expected: number) {
    await this.beforeGet?.(key);
    this.reads++;
    const bytes = this.objects.get(key);
    if (this.fail) throw new RunServiceError("skill_storage_unavailable");
    if (!bytes || bytes.length !== expected) throw new RunServiceError("skill_storage_integrity");
    return bytes.slice();
  }
}
const schema = `skill_storage_${randomUUID().replaceAll("-", "")}`;
const owner = randomUUID(), member = randomUUID(), stranger = randomUUID();
let pool: pg.Pool, admin: pg.Pool, workspace: string, store: MemoryStore, repo: DefinitionRepository;
const content = (instructions = "Do the work.\n日本語の本文"): SkillContent => ({ name: "sample-skill", description: "概要 \"quotes\"\nnext line", instructions, files: [{ path: "references/a.md", content: "参考資料\n" }, { path: "scripts/test.py", content: "print('not run')\n" }, { path: "assets/empty.txt", content: "" }] });
const input = (value = content()) => ({ key: randomUUID(), kind: "skill" as const, visibility: "workspace" as const, content: value });
const rev = (expected_revision: number) => ({ key: randomUUID(), expected_revision });
const denied = (code: string) => (error: unknown) => error instanceof RunServiceError && error.code === code;
before(async () => {
  const { caPath, ...database } = prepareTestAuth().database;
  const config = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 12, statement_timeout: 15000 };
  admin = new pg.Pool(config); await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  await migrateAuth(pool); await migrateData(pool);
  await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Owner'),($2,'active','Member'),($3,'active','Stranger')", [owner, member, stranger]);
  workspace = (await new WorkspaceRepository(pool).create(owner, { key: randomUUID(), name: "Skills" })).workspace.id;
});
beforeEach(async () => {
  await pool.query("TRUNCATE ax_skill_save_requests,ax_definitions CASCADE");
  await pool.query("UPDATE ax_skill_storage_control SET physical_limit_bytes=268435456");
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT (workspace_id,user_id) DO UPDATE SET access_level='member'", [workspace, member]);
  store = new MemoryStore(); repo = new DefinitionRepository(pool, store);
});
after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

test("object-backed drafts and immutable versions round-trip without storing skill body in PostgreSQL", async () => {
  const created = await repo.create(owner, workspace, input()), id = created.definition.id;
  const raw = (await pool.query("SELECT draft FROM ax_definitions WHERE id=$1", [id])).rows[0].draft;
  assert.equal(raw.source.type, "skill-object-v1"); assert.equal(raw.instructions, undefined); assert.equal(raw.files[1].content, undefined);
  assert.equal(store.objects.size, 5);
  assert.deepEqual((await repo.get(owner, workspace, id)).draft?.content, content());
  const published = await repo.publish(owner, workspace, id, rev(1));
  assert.deepEqual(published.version?.content, content());
  assert.equal(published.version?.sha256, await sha256(utf8(canonical(content(), true))));
  assert.deepEqual((await repo.getVersion(member, workspace, published.version!.id)).content, content());
  const oldBytes = new Map(store.objects);
  await repo.updateDraft(owner, workspace, id, { ...rev(2), content: content("new body") });
  assert.deepEqual((await repo.get(owner, workspace, id)).draft?.content, content("new body"));
  for (const [key, bytes] of oldBytes) assert.deepEqual(store.objects.get(key), bytes);
  assert.deepEqual((await repo.getVersion(owner, workspace, published.version!.id)).content, content());
  await assert.rejects(pool.query("UPDATE ax_skill_revisions SET total_bytes=1"), /immutable_definition/);
  await assert.rejects(pool.query("UPDATE ax_definition_versions SET content='{}'"), /immutable_definition/);
});

test("list uses metadata while missing or altered originals fail closed on read and publish", async () => {
  const created = await repo.create(owner, workspace, input()), id = created.definition.id;
  const key = [...store.objects.keys()].find(key => key.endsWith("SKILL.md"))!;
  const bytes = store.objects.get(key)!; store.objects.set(key, utf8("x".repeat(bytes.length)));
  const before = store.reads;
  assert.equal((await repo.list(owner, workspace)).definitions[0].name, "sample-skill"); assert.equal(store.reads, before);
  await assert.rejects(repo.get(owner, workspace, id), denied("skill_storage_integrity"));
  await assert.rejects(repo.publish(owner, workspace, id, rev(1)), denied("skill_storage_integrity"));
  assert.equal((await pool.query("SELECT count(*) n FROM ax_definition_versions")).rows[0].n, "0");
  store.objects.delete(key);
  await assert.rejects(repo.get(owner, workspace, id), denied("skill_storage_integrity"));
});

test("same-key save and publication converge, changed payload conflicts, publish replay verifies its original revision", async () => {
  const request = input();
  const first = await repo.create(owner, workspace, request), id = first.definition.id;
  store.fail = true;
  const replay = await repo.create(owner, workspace, request); assert.equal(replay.definition.id, id); assert.equal(replay.replayed, true);
  store.fail = false;
  await assert.rejects(repo.create(owner, workspace, { ...request, content: content("different") }), denied("idempotency_conflict"));
  const publish = rev(1), version = await repo.publish(owner, workspace, id, publish);
  await repo.updateDraft(owner, workspace, id, { ...rev(2), content: content("updated") });
  const current = (await pool.query("SELECT draft FROM ax_definitions WHERE id=$1", [id])).rows[0].draft;
  store.objects.delete(current.source.manifest_key);
  const repeated = await repo.publish(owner, workspace, id, publish);
  assert.equal(repeated.replayed, true); assert.equal(repeated.version!.id, version.version!.id);
});

test("an interrupted save leaves a reservation but no visible definition; retry reuses its revision", async () => {
  const request = input(); let puts = 0;
  store.beforePut = async () => { if (++puts === 2) throw new RunServiceError("skill_storage_unavailable"); };
  await assert.rejects(repo.create(owner, workspace, request), denied("skill_storage_unavailable"));
  assert.equal((await repo.list(owner, workspace)).definitions.length, 0);
  const pending = (await pool.query("SELECT * FROM ax_skill_save_requests")).rows[0];
  assert.equal(pending.state, "pending"); assert.ok(pending.reserved_bytes > 0);
  store.beforePut = undefined;
  const saved = await repo.create(owner, workspace, request);
  assert.equal(saved.definition.id, pending.definition_id);
  const record = (await pool.query("SELECT * FROM ax_skill_save_requests")).rows[0];
  assert.equal(record.revision_id, pending.revision_id); assert.equal(record.generation, 2); assert.equal(record.state, "committed");
});

test("membership and editor authority are rechecked after upload, including request replay", async () => {
  const request = input();
  store.beforePut = async key => { if (key.endsWith("manifest.json")) await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, member]); };
  await assert.rejects(repo.create(member, workspace, request), denied("workspace_not_found"));
  assert.equal((await pool.query("SELECT count(*) n FROM ax_definitions")).rows[0].n, "0");
  assert.equal((await pool.query("SELECT state FROM ax_skill_save_requests")).rows[0].state, "pending");
  store.beforePut = undefined;
  await assert.rejects(repo.create(member, workspace, request), denied("workspace_not_found"));
  const saved = await repo.create(owner, workspace, input());
  await assert.rejects(repo.get(stranger, workspace, saved.definition.id), denied("workspace_not_found"));
});

test("concurrent writers cannot publish a stale draft or commit an older lease generation", async () => {
  const created = await repo.create(owner, workspace, input()), id = created.definition.id;
  let superseded = false;
  store.beforePut = async key => {
    if (!superseded && key.endsWith("manifest.json")) {
      superseded = true; store.beforePut = undefined;
      await repo.updateDraft(owner, workspace, id, { ...rev(1), content: content("winner") });
    }
  };
  await assert.rejects(repo.updateDraft(owner, workspace, id, { ...rev(1), content: content("loser") }), denied("definition_revision_conflict"));
  assert.deepEqual((await repo.get(owner, workspace, id)).draft?.content, content("winner"));
  const request = input(); let nested = false;
  store.beforePut = async () => {
    if (!nested) { nested = true; store.beforePut = undefined; await repo.create(owner, workspace, request); }
  };
  const replay = await repo.create(owner, workspace, request);
  assert.equal(replay.replayed, true);
  assert.equal((await pool.query("SELECT generation FROM ax_skill_save_requests WHERE request_key=$1", [request.key])).rows[0].generation, 2);
});

test("retained revisions and pending uploads consume physical quota", async () => {
  await pool.query("UPDATE ax_skill_storage_control SET physical_limit_bytes=163840");
  const large = { ...content(), files: Array.from({ length: 3 }, (_, i) => ({ path: `assets/file${i}.txt`, content: "x".repeat(32768) })) };
  const first = await repo.create(owner, workspace, input(large));
  await assert.rejects(repo.updateDraft(owner, workspace, first.definition.id, { ...rev(1), content: large }), denied("definition_quota_exceeded"));
  await repo.archive(owner, workspace, first.definition.id, rev(1));
  await assert.rejects(repo.create(owner, workspace, input(large)), denied("definition_quota_exceeded"));
});

test("a replaced writer lease cannot commit while the replacement is still pending", async () => {
  const request = input(); let replaced = false;
  store.beforePut = async () => {
    if (!replaced) {
      replaced = true; store.beforePut = undefined; store.fail = true;
      await assert.rejects(repo.create(owner, workspace, request), denied("skill_storage_unavailable"));
      store.fail = false;
    }
  };
  await assert.rejects(repo.create(owner, workspace, request), denied("skill_save_superseded"));
  assert.equal((await repo.list(owner, workspace)).definitions.length, 0);
  const result = await repo.create(owner, workspace, request);
  assert.equal(result.definition.revision, 1);
  const saved = (await pool.query("SELECT * FROM ax_skill_save_requests WHERE request_key=$1", [request.key])).rows[0];
  const source = (await pool.query("SELECT source FROM ax_skill_revisions WHERE id=$1", [saved.revision_id])).rows[0].source;
  await assert.rejects(pool.query("SELECT ax_skill_save_commit($1,$2,$3,$4,$5,$6)", [owner, workspace, request.key, saved.lease_token, saved.generation, { ...source, manifest_sha256: "0".repeat(64) }]), /idempotency_conflict/);
});

test("old published JSON stays intact when its draft moves to objects; missing configuration refuses new writes", async () => {
  const legacy = new DefinitionRepository(pool, undefined, { legacyWrites: true });
  const created = await legacy.create(owner, workspace, input()), id = created.definition.id;
  const published = await legacy.publish(owner, workspace, id, rev(1));
  const before = (await pool.query("SELECT to_jsonb(v) value FROM ax_definition_versions v WHERE id=$1", [published.version!.id])).rows[0].value;
  await repo.updateDraft(owner, workspace, id, { ...rev(2), content: content("external") });
  assert.deepEqual((await pool.query("SELECT to_jsonb(v) value FROM ax_definition_versions v WHERE id=$1", [published.version!.id])).rows[0].value, before);
  const missing = new DefinitionRepository(pool);
  assert.deepEqual((await missing.getVersion(owner, workspace, published.version!.id)).content, content());
  assert.throws(() => missing.create(owner, workspace, input()), denied("skill_storage_unavailable"));
  assert.throws(() => missing.updateDraft(owner, workspace, id, { ...rev(3), content: content() }), denied("skill_storage_unavailable"));
  await assert.rejects(missing.get(owner, workspace, id), denied("skill_storage_unavailable"));
});

test("an administrator demoted during object reads cannot receive the unpublished draft", async () => {
  const created = await repo.create(owner, workspace, input()), id = created.definition.id;
  await repo.publish(owner, workspace, id, rev(1));
  await repo.updateDraft(owner, workspace, id, { ...rev(2), content: content("unpublished secret") });
  await pool.query("UPDATE org_memberships SET access_level='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, member]);
  store.beforeGet = async () => {
    store.beforeGet = undefined;
    await pool.query("UPDATE org_memberships SET access_level='member' WHERE workspace_id=$1 AND user_id=$2", [workspace, member]);
  };
  await assert.rejects(repo.get(member, workspace, id), denied("definition_forbidden"));
  assert.equal((await repo.get(member, workspace, id)).draft, null);
});

test("publishing an external draft without storage rejects before a version or revision is committed", async () => {
  const created = await repo.create(owner, workspace, input()), id = created.definition.id;
  const missing = new DefinitionRepository(pool);
  await assert.rejects(missing.publish(owner, workspace, id, rev(1)), denied("skill_storage_unavailable"));
  assert.equal((await pool.query("SELECT count(*) n FROM ax_definition_versions WHERE definition_id=$1", [id])).rows[0].n, "0");
  assert.equal((await pool.query("SELECT revision FROM ax_definitions WHERE id=$1", [id])).rows[0].revision, 1);
});

test("membership lost while hydrating a committed publication prevents returning its body", async () => {
  const created = await repo.create(member, workspace, input()), id = created.definition.id;
  store.beforeGet = async key => {
    if (key.endsWith("manifest.json") && (await pool.query("SELECT count(*) n FROM ax_definition_versions WHERE definition_id=$1", [id])).rows[0].n === "1") {
      store.beforeGet = undefined;
      await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, member]);
    }
  };
  const request = rev(1);
  await assert.rejects(repo.publish(member, workspace, id, request), denied("workspace_not_found"));
  assert.equal((await pool.query("SELECT count(*) n FROM ax_definition_versions WHERE definition_id=$1", [id])).rows[0].n, "1");
  await assert.rejects(repo.publish(member, workspace, id, request), denied("workspace_not_found"));
});

test("external saves reject file-directory collisions before reserving or uploading while keeping inline versions readable", async () => {
  const collision = { ...content(), files: [{ path: "references/a", content: "one" }, { path: "references/a/b", content: "two" }] };
  for (const files of [collision.files, [...collision.files].reverse()]) {
    await assert.rejects(repo.create(owner, workspace, input({ ...collision, files })), denied("invalid_request"));
  }
  assert.equal((await pool.query("SELECT count(*) n FROM ax_skill_save_requests")).rows[0].n, "0");
  assert.equal(store.objects.size, 0);
  const legacy = new DefinitionRepository(pool, undefined, { legacyWrites: true });
  const created = await legacy.create(owner, workspace, input(collision));
  const published = await legacy.publish(owner, workspace, created.definition.id, rev(1));
  assert.deepEqual((await repo.getVersion(owner, workspace, published.version!.id)).content, collision);
  const valid = { ...content(), files: [{ path: "references/a", content: "one" }, { path: "references/ab/b", content: "two" }, { path: "references/a_/b", content: "three" }] };
  const saved = await repo.create(owner, workspace, input(valid));
  assert.deepEqual((await repo.get(owner, workspace, saved.definition.id)).draft?.content, valid);
});

test("manifest, stored metadata and SQL reject path collisions in either order without wildcard matching", async () => {
  const saved = await repo.create(owner, workspace, input());
  const stored = (await pool.query("SELECT draft FROM ax_definitions WHERE id=$1", [saved.definition.id])).rows[0].draft;
  const manifest = JSON.parse(new TextDecoder().decode(store.objects.get(stored.source.manifest_key)!));
  const metadata = (await pool.query("SELECT metadata FROM ax_skill_save_requests WHERE definition_id=$1", [saved.definition.id])).rows[0].metadata;
  const files = [stored.files[0], { ...stored.files[1], path: "references/a_" }, { ...stored.files[2], path: "references/a_/b" }];
  for (const ordered of [files, [files[0], files[2], files[1]]]) {
    assert.equal(skillManifestSchema.safeParse({ ...manifest, files: ordered }).success, false);
    assert.equal(storedSkillContentSchema.safeParse({ ...stored, files: ordered }).success, false);
    await assert.rejects(new SkillStorage(store).hydrate({ ...stored, files: ordered }), /skill_storage_integrity/);
    await assert.rejects(pool.query("SELECT ax_skill_metadata($1,true)", [{ ...metadata, files: ordered, file_bytes: ordered.reduce((sum, f) => sum + f.size_bytes, 0) }]), /invalid_request/);
  }
  const siblings = [files[0], files[1], { ...files[2], path: "references/ab/b" }];
  assert.equal(skillManifestSchema.safeParse({ ...manifest, files: siblings }).success, true);
  assert.equal(storedSkillContentSchema.safeParse({ ...stored, files: siblings }).success, true);
  await pool.query("SELECT ax_skill_metadata($1,true)", [{ ...metadata, files: siblings, file_bytes: siblings.reduce((sum, f) => sum + f.size_bytes, 0) }]);
});

test("leading UTF-8 BOMs survive draft and published skill hydration with unchanged semantic hashes", async () => {
  const value = { ...content("\uFEFFinstructions"), files: [{ path: "references/bom.txt", content: "\uFEFF日本語\n" }, { path: "assets/double.txt", content: "\uFEFF\uFEFF" }, { path: "assets/plain.txt", content: "plain" }, { path: "assets/empty.txt", content: "" }] };
  const saved = await repo.create(owner, workspace, input(value));
  assert.deepEqual((await repo.get(owner, workspace, saved.definition.id)).draft?.content, value);
  const published = await repo.publish(owner, workspace, saved.definition.id, rev(1));
  assert.deepEqual(published.version!.content, value);
  assert.equal(published.version!.sha256, await sha256(utf8(canonical(value, true))));
  assert.deepEqual((await repo.getVersion(owner, workspace, published.version!.id)).content, value);
  const file = [...store.objects.entries()].find(([key]) => key.endsWith("references/bom.txt"))![1];
  assert.deepEqual(file, utf8(value.files[0].content));
});
