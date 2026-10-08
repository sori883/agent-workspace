import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import pg from "pg";
import { DefinitionRepository } from "../data/definitions";
import { WorkbenchRepository } from "../data/workbench";
import { WorkspaceRepository } from "../data/workspaces";
import { canonical } from "../data/canonical";
import type { SkillObjectStore } from "../shared/skill-storage-contracts";
import { prepareTestAuth } from "./prepare-auth";

const image = `localhost:5001/runner@sha256:${"a".repeat(64)}`, controller = "storage-boundary", token = "b".repeat(64);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const usage = { prompt_token_count: 100, candidates_token_count: 20, thoughts_token_count: 0, total_token_count: 120, model_call_count: 1 };
const expires = () => Math.floor(Date.now() / 1000) + 3600;
const content = { name: "object-skill", description: "集計の指示", instructions: "OBJECT-BODY-ONLY", files: [{ path: "references/rules.md", content: "OBJECT-REFERENCE-ONLY" }] };
const denied = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
class MemoryStore implements SkillObjectStore {
  readonly storeId = "test-skills";
  readonly data = new Map<string, Uint8Array>();
  async putImmutable(key: string, bytes: Uint8Array) { const old = this.data.get(key); if (old) assert.deepEqual(old, bytes); else this.data.set(key, bytes.slice()); }
  async get(key: string, size: number) { const bytes = this.data.get(key); assert.ok(bytes); assert.equal(bytes.length, size); return bytes; }
}
async function setup(t: TestContext, version = 11) {
  const schema = `workbench_storage_${randomBytes(8).toString("hex")}`;
  const { caPath, ...database } = prepareTestAuth().database;
  const config = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 5, statement_timeout: 10000 };
  const admin = new pg.Pool(config); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const migrate = async (files: string[]) => { const client = await pool.connect(); try { await client.query("BEGIN"); for (const file of files) await client.query(readFileSync(new URL(file, import.meta.url), "utf8")); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } };
  await migrate(["../server/auth-schema.sql", "../server/auth-schema-v2.sql", ...Array.from({ length: version }, (_, index) => `../data/schema${index ? `-v${index + 1}` : ""}.sql`)]);
  const owner = randomUUID(), member = randomUUID(); await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Owner'),($2,'active','Member')", [owner, member]);
  const workspace = (await new WorkspaceRepository(pool).create(owner, { key: randomUUID(), name: "Storage boundary" })).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace, member]);
  await pool.query("UPDATE ax_control SET accepting=true"); await pool.query("UPDATE ax_workbench_control SET trial_enabled=false,python_enabled=false,runtime_image=$1,code_image=$1,code_profile='host-quota-8m-v1'", [image]);
  const call = async (name: string, args: unknown[] = []): Promise<any> => (await pool.query(`SELECT ${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) value`, args)).rows[0].value;
  const repo = new WorkbenchRepository(pool);
  const effect = async (claim: any, operation: string) => { const op = await call("ax_intent", [claim.run_id, claim.generation, controller, operation]); await call("ax_evidence", [claim.run_id, claim.generation, controller, op.operation_id, operation === "suspend" ? { phase: "SUSPENDED", worker_assignment: null, actor: claim.run_id } : operation === "egress_deny" ? { egress_denied: true, actor: claim.run_id } : { confirmed: true, actor: claim.run_id }]); };
  const start = async () => { const claim = await call("ax_claim", [controller, 30]); for (const operation of ["create", "resume", "stage", "egress_prepare", "start"]) await effect(claim, operation); return claim; };
  const finish = async (claim: any, proposal: any) => {
    for (const sequence of [1, 2]) {
      const bytes = Buffer.from(JSON.stringify({ version: 2, run_id: claim.run_id, sequence, kind: sequence === 1 ? "model" : "tool", body: sequence === 1 ? {} : proposal }));
      await call("ax_agent_reserve", [claim.run_id, claim.generation, controller, sequence, bytes]);
      const body = sequence === 1 ? { response: { candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 120 } } } : { accepted: true };
      await call("ax_agent_settle", [claim.run_id, claim.generation, controller, sequence, { version: 2, run_id: claim.run_id, sequence, request_sha256: hash(bytes), status: "ok", body }, sequence === 1 ? usage : {}, 1, {}]);
    }
    await call("ax_collect", [claim.run_id, claim.generation, controller, { schema_version: 2, run_id: claim.run_id, adapter: "interactive", status: "succeeded", exit_code: 0, error_type: null, summary: "done", usage, estimated_usd: 0 }, null]);
    await effect(claim, "egress_deny"); await effect(claim, "suspend"); await call("ax_finish", [claim.run_id, claim.generation, controller]);
  };
  const publish = async (objects: boolean) => { const definitions = new DefinitionRepository(pool, objects ? new MemoryStore() : undefined, { legacyWrites: !objects }); const draft = await definitions.create(owner, workspace, { key: randomUUID(), kind: "skill", visibility: "workspace", content }); const result = await definitions.publish(owner, workspace, draft.definition.id, { key: randomUUID(), expected_revision: draft.definition.revision! }); return { definitions, draft, version: result.version! }; };
  const begin = (skills: string[] = [], actor = owner) => repo.start(actor, workspace, { key: randomUUID(), text: "集計", skill_version_ids: skills }, expires(), token);
  return { pool, migrate, owner, member, workspace, repo, call, start, finish, publish, begin, effect };
}

test("new runs pin storage metadata, hydrate authorization is current, and legacy agents remain disabled", async t => {
  const f = await setup(t), skill = await f.publish(true);
  const agents = new DefinitionRepository(f.pool, undefined, { legacyWrites: true });
  const agent = await agents.create(f.owner, f.workspace, { key: randomUUID(), kind: "agent", visibility: "workspace", content: { name: "legacy-agent", instructions: "old", skill_version_ids: [skill.version.id], allowed_tools: [] } });
  const published = await agents.publish(f.owner, f.workspace, agent.definition.id, { key: randomUUID(), expected_revision: agent.definition.revision! });
  await assert.rejects(f.call("ax_workbench_start", [f.owner, f.workspace, { key: randomUUID(), text: "legacy", mode: "preview", input_file_ids: [], agent_version_id: published.version!.id }, `ax-run-${randomBytes(8).toString("hex")}`, expires(), token]), denied("agent_selection_disabled"));
  await f.begin([skill.version.id], f.member); const claim = await f.start(), context = claim.workbench.descriptor.skill_context;
  assert.equal(context.version, 2); assert.equal(context.loaded_skills.length, 0); assert.equal(context.loaded_files.length, 0);
  assert.equal(context.objects.length, 1); assert.deepEqual(context.objects[0].loaded_paths, ["SKILL.md"]);
  assert.ok(!JSON.stringify(claim).includes(content.instructions)); assert.ok(!JSON.stringify(claim).includes(content.files[0].content));
  assert.equal(hash(canonical(claim.workbench.descriptor, true)), claim.request.descriptor_sha256);
  assert.deepEqual(await f.call("ax_workbench_skill_object", [claim.run_id, claim.generation, controller, skill.version.id]), context.objects[0]);
  await assert.rejects(f.call("ax_workbench_skill_object", [claim.run_id, claim.generation + 1, controller, skill.version.id]));
  await f.pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2", [f.workspace, f.member]);
  await assert.rejects(f.call("ax_workbench_skill_object", [claim.run_id, claim.generation, controller, skill.version.id]));
});

test("discovery, supplemental reads and new task continuation keep the same manifest", async t => {
  const f = await setup(t), skill = await f.publish(true); await f.begin();
  const initial = await f.start(); assert.deepEqual(initial.workbench.descriptor.skill_context.objects, []);
  await assert.rejects(f.call("ax_workbench_skill_object", [initial.run_id, initial.generation, controller, skill.version.id]), denied("skill_not_loaded"));
  await f.finish(initial, { kind: "read_skills", skill_ids: [skill.version.id] });
  const main = await f.start(), source = main.workbench.descriptor.skill_context.objects[0].source;
  assert.deepEqual(main.workbench.descriptor.skill_context.objects[0].loaded_paths, ["SKILL.md"]);
  await f.finish(main, { kind: "read_skill_file", skill_id: skill.version.id, path: "references/rules.md" });
  const reference = await f.start(), object = reference.workbench.descriptor.skill_context.objects[0];
  assert.deepEqual(object.source, source); assert.deepEqual(object.loaded_paths, ["SKILL.md", "references/rules.md"]);
  assert.deepEqual(await f.call("ax_workbench_skill_object", [reference.run_id, reference.generation, controller, skill.version.id]), object);
  await f.finish(reference, { kind: "question", text: "続けますか" });
  const root = (await f.pool.query("SELECT id,question_id,revision FROM ax_agent_roots")).rows[0];
  await f.repo.answer(f.owner, f.workspace, root.id, { key: randomUUID(), question_id: root.question_id, expected_revision: root.revision, text: "はい" }, expires(), token);
  const resumed = await f.start(); assert.deepEqual(resumed.workbench.descriptor.skill_context.objects[0], object);
  await skill.definitions.archive(f.owner, f.workspace, skill.draft.definition.id, { key: randomUUID(), expected_revision: (await skill.definitions.get(f.owner, f.workspace, skill.draft.definition.id)).definition.revision! });
  await assert.rejects(f.call("ax_workbench_skill_object", [resumed.run_id, resumed.generation, controller, skill.version.id]), denied("definition_archived"));
});

test("v11 leaves old v9 receipts, body context and paused continuation unchanged", async t => {
  const f = await setup(t, 9), skill = await f.publish(false), accepted = await f.begin([skill.version.id]);
  const original = await f.start(); await f.finish(original, { kind: "question", text: "続けますか" });
  const tables = ["ax_runs", "ax_agent_segments", "ax_definition_versions"];
  const snapshots = await Promise.all(tables.map(table => f.pool.query(`SELECT to_jsonb(t) value FROM ${table} t ORDER BY to_jsonb(t)::text`)));
  await f.migrate(["../data/schema-v10.sql", "../data/schema-v11.sql"]);
  for (let index = 0; index < tables.length; index++) assert.deepEqual((await f.pool.query(`SELECT to_jsonb(t) value FROM ${tables[index]} t ORDER BY to_jsonb(t)::text`)).rows, snapshots[index].rows);
  const root = await f.repo.get(f.owner, f.workspace, accepted.root_id);
  await f.repo.answer(f.owner, f.workspace, accepted.root_id, { key: randomUUID(), question_id: root.question_id!, expected_revision: root.revision, text: "はい" }, expires(), token);
  const resumed = await f.start(); assert.equal(resumed.workbench.descriptor.skill_context.version, 1); assert.equal(resumed.workbench.descriptor.skill_context.objects, undefined);
  assert.deepEqual(resumed.workbench.descriptor.skill_context, original.workbench.descriptor.skill_context);
  assert.equal(resumed.image, original.image); assert.equal(hash(canonical(resumed.workbench.descriptor, true)), resumed.request.descriptor_sha256);
  await f.finish(resumed, { kind: "output", text: "完了" });
  assert.equal((await f.repo.get(f.owner, f.workspace, accepted.root_id)).state, "succeeded");
});

test("known prompt overflow without a model mailbox releases the execution slot with zero cost", async t => {
  const f = await setup(t), skill = await f.publish(true);
  await f.pool.query("UPDATE ax_workbench_control SET trial_enabled=true");
  const accepted = await f.call("ax_workbench_start", [f.owner, f.workspace, { key: randomUUID(), text: "集計", mode: "model", allow_model: true, input_file_ids: [], skill_version_ids: [skill.version.id] }, `ax-run-${randomBytes(8).toString("hex")}`, expires(), token]);
  const claim = await f.start(), zero = { prompt_token_count: 0, candidates_token_count: 0, thoughts_token_count: 0, total_token_count: 0, model_call_count: 0 };
  await f.call("ax_collect", [claim.run_id, claim.generation, controller, { schema_version: 2, run_id: claim.run_id, adapter: "interactive", status: "failed", exit_code: 1, error_type: "skill_context_too_large", summary: "", usage: zero, estimated_usd: 0 }, null]);
  await f.effect(claim, "egress_deny"); await f.effect(claim, "suspend");
  assert.equal((await f.call("ax_finish", [claim.run_id, claim.generation, controller])).resolved, true);
  const root = await f.repo.get(f.owner, f.workspace, accepted.root_id);
  assert.equal(root.state, "failed"); assert.equal(root.failure_reason, "skill_context_too_large"); assert.equal(root.estimated_usd, 0); assert.equal(root.model_calls, 0);
  assert.equal(Number((await f.pool.query("SELECT count(*) n FROM ax_agent_operations WHERE run_id=$1", [claim.run_id])).rows[0].n), 0);
  assert.equal((await f.pool.query("SELECT run_id FROM ax_execution_slot WHERE id")).rows[0].run_id, null);
  assert.ok((await f.begin()).run_id);
});
