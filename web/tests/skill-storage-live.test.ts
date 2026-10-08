import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { AwsClient } from "aws4fetch";
import { S3SkillObjectStore, type SkillObjectStoreConfig } from "../api/skill-object-store";
import { DefinitionRepository } from "../data/definitions";
import { WorkspaceRepository } from "../data/workspaces";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { prepareTestAuth } from "./prepare-auth";

function storageConfig(role: string): SkillObjectStoreConfig {
  const env = Object.fromEntries(readFileSync(new URL(`../../ax-local/.state/object-storage/${role}.env`, import.meta.url), "utf8").split("\n").filter(line => line && !line.startsWith("#")).map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  return { endpoint: env.APP_SKILL_STORAGE_ENDPOINT, bucket: env.APP_SKILL_STORAGE_BUCKET, region: env.APP_SKILL_STORAGE_REGION,
    forcePathStyle: env.APP_SKILL_STORAGE_FORCE_PATH_STYLE === "true", storeId: env.APP_SKILL_STORAGE_STORE_ID, allowInsecureHttp: env.APP_SKILL_STORAGE_ALLOW_INSECURE_HTTP === "true",
    accessKeyId: env.APP_SKILL_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.APP_SKILL_STORAGE_SECRET_ACCESS_KEY };
}

test("real RustFS signs, saves, publishes and hydrates an isolated skill revision", { skip: process.env.RUN_SKILL_STORAGE_LIVE !== "1" }, async () => {
  const { caPath, ...database } = prepareTestAuth().database;
  const connection = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, statement_timeout: 15000 };
  const schema = `skill_live_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(connection), pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
  const apiConfig = storageConfig("api"), store = new S3SkillObjectStore(apiConfig), keys = new Set<string>();
  const maintenance = storageConfig("maintenance");
  const cleanup = new AwsClient({ accessKeyId: maintenance.accessKeyId, secretAccessKey: maintenance.secretAccessKey, region: maintenance.region, service: "s3", retries: 0 });
  let workspace: string | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); await migrateAuth(pool); await migrateData(pool);
    const owner = randomUUID(); await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Storage verification')", [owner]);
    workspace = (await new WorkspaceRepository(pool).create(owner, { key: randomUUID(), name: "Storage verification" })).workspace.id;
    const repo = new DefinitionRepository(pool, { storeId: store.storeId, get: (key, bytes) => store.get(key, bytes), async putImmutable(key, bytes, type) {
      assert.ok(key.startsWith(`workspaces/${workspace}/skills/`)); keys.add(key); await store.putImmutable(key, bytes, type);
    } });
    const content = { name: "rustfs-verification", description: "実原本の署名・公開確認", instructions: "保存された原本を読み出す。\n", files: [{ path: "references/example.md", content: "日本語の参考資料\n" }, { path: "assets/empty.txt", content: "" }] };
    const request = { key: randomUUID(), kind: "skill" as const, visibility: "personal" as const, content };
    const created = await repo.create(owner, workspace, request);
    assert.deepEqual((await repo.get(owner, workspace, created.definition.id)).draft?.content, content);
    const published = await repo.publish(owner, workspace, created.definition.id, { key: randomUUID(), expected_revision: 1 });
    assert.deepEqual(published.version?.content, content);
    assert.deepEqual((await repo.getVersion(owner, workspace, published.version!.id)).content, content);
    const replay = await repo.create(owner, workspace, request); assert.equal(replay.replayed, true); assert.equal(replay.definition.id, created.definition.id);
    const raw = (await pool.query("SELECT draft FROM ax_definitions WHERE id=$1", [created.definition.id])).rows[0].draft;
    assert.equal(raw.instructions, undefined); assert.equal(raw.files[0].content, undefined);
    const mainKey = [...keys].find(key => key.endsWith("SKILL.md"))!;
    const main = await store.get(mainKey, raw.files[0].size_bytes);
    await store.putImmutable(mainKey, main, "text/plain; charset=utf-8");
    await assert.rejects(store.putImmutable(mainKey, new TextEncoder().encode("altered"), "text/plain; charset=utf-8"), /skill_storage_integrity/);
    const controller = storageConfig("controller"); controller.endpoint = apiConfig.endpoint;
    const reader = new S3SkillObjectStore(controller);
    assert.deepEqual(await reader.get(mainKey, main.length), main);
    await assert.rejects(reader.putImmutable(mainKey, main, "text/plain; charset=utf-8"), /skill_storage_unavailable/);
    assert.deepEqual((await repo.getVersion(owner, workspace, published.version!.id)).content, content);
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    for (const key of keys) {
      assert.ok(workspace && key.startsWith(`workspaces/${workspace}/skills/`));
      const response = await fetch(await cleanup.sign(`${apiConfig.endpoint}/${apiConfig.bucket}/${key}`, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5000) }));
      await response.body?.cancel(); assert.ok(response.ok, `Temporary object cleanup failed: ${response.status}`);
    }
  }
});
