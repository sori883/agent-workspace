import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import pg from "pg";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { prepareTestAuth } from "./prepare-auth";
import { startOidcFixture } from "./helpers/oidc-fixture";
import { AuthStore, createPool } from "../server/auth-store";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { WorkspaceRepository } from "../data/workspaces";
import { createRuntime } from "../api/runtime";
import { parseApiSettings, type ApiSettings } from "../api/settings";
import { postgresOptions } from "../api/postgres";
import workerAdapter from "../api/worker";

const schema = `runtime_test_${randomBytes(8).toString("hex")}`;
const directory = mkdtempSync(join(tmpdir(), "ax-worker-test-"));
let admin: pg.Pool;
let pool: pg.Pool;
let settings: ApiSettings;
let fixture: Awaited<ReturnType<typeof startOidcFixture>>;
let worker: Miniflare;
let workerOptions: ConstructorParameters<typeof Miniflare>[0];
let workerConnectionString: string;
let workspace: string;
let alice: string;
let bob: string;
let node: ReturnType<typeof createRuntime>;
let workerErrors = 0;
const pendingRequests = new Set<Promise<Response>>();

before(async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const auth = prepareTestAuth();
  admin = createPool(auth);
  await admin.query(`CREATE SCHEMA ${schema}`);
  fixture = await startOidcFixture(auth.clientSecret);
  const { caPath, ...database } = auth.database;
  settings = parseApiSettings({ apiOrigin: `http://127.0.0.1:${port}`, apiToken: randomBytes(32).toString("hex"),
    identity: { issuer: fixture.issuer, clientId: auth.clientId, audience: auth.audience }, databaseSchema: schema,
    database: { ...database, ca: caPath ? readFileSync(caPath, "utf8") : null },
    image: JSON.parse(readFileSync(new URL("../../ax-local/versions.json", import.meta.url), "utf8")).runner_task });
  pool = new pg.Pool(postgresOptions(settings));
  await migrateAuth(pool);
  await migrateData(pool);
  await pool.query("UPDATE ax_control SET accepting=true");
  const store = new AuthStore(pool, auth.encryptionKey);
  await store.identify(fixture.issuer, "runtime-alice", "Alice", "alice@example.test");
  await store.identify(fixture.issuer, "runtime-bob", "Bob", "bob@example.test");
  const ownerId = (await pool.query("SELECT user_id FROM identities WHERE subject='runtime-alice'")).rows[0].user_id;
  const otherId = (await pool.query("SELECT user_id FROM identities WHERE subject='runtime-bob'")).rows[0].user_id;
  workspace = (await new WorkspaceRepository(pool).create(ownerId, {key:randomUUID(),name:"Runtime"})).workspace.id;
  await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')", [workspace,otherId]);
  alice = await fixture.accessToken("runtime-alice");
  bob = await fixture.accessToken("runtime-bob");
  node = createRuntime(settings, pool);
  const scriptPath = join(directory, "worker.mjs");
  await build({ stdin: { contents: `
    import worker from ${JSON.stringify(new URL("../api/worker.ts", import.meta.url).pathname)};
    export default { async fetch(request, env) {
      const connection = new URL(env.POSTGRES.connectionString);
      connection.searchParams.set("application_name", ${JSON.stringify(schema)});
      return worker.fetch(request, {...env, POSTGRES:{connectionString:connection.href}});
    }};
  `, resolveDir: new URL("..", import.meta.url).pathname, loader: "ts" }, outfile: scriptPath, bundle: true,
    platform: "node", conditions: ["workerd"], format: "esm", target: "es2022", external: [...builtinModules, "node:*", "cloudflare:*", "pg-native"],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/");' }, logLevel: "silent" });
  const connection = new URL(`postgresql://${settings.database.host}:${settings.database.port}/${settings.database.database}`);
  connection.username = settings.database.user;
  connection.password = settings.database.password;
  connection.searchParams.set("sslmode", caPath ? "verify-full" : "disable");
  if (caPath) connection.searchParams.set("sslrootcert", caPath);
  connection.searchParams.set("application_name", schema);
  workerConnectionString = connection.href;
  const { database: _, ...application } = settings;
  workerOptions = { ...convertV4MiniflareOptions({ modules: true, script: readFileSync(scriptPath, "utf8"), port, compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"], cf: false,
    bindings: { API_SETTINGS: JSON.stringify(application) }, hyperdrives: { POSTGRES: connection.href } }), telemetry: { enabled: false },
    handleStructuredLogs(log) { if (log.level === "error") workerErrors++; } };
  await startWorker();
});

async function startWorker() {
  worker = new Miniflare(workerOptions);
  try { await worker.ready; }
  catch { throw new Error("Worker runtime could not start."); }
}

async function stopWorker() {
  try { await Promise.all([...pendingRequests]); }
  finally { await worker.dispose(); }
}

after(async () => {
  if (worker) await stopWorker();
  await fixture?.close();
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  rmSync(directory, { recursive: true, force: true });
});

async function bufferedRequest(runtime: "node" | "worker", path: string, token: string, body?: unknown) {
  const headers = { host: new URL(settings.apiOrigin).host, authorization: `Bearer ${settings.apiToken}`,
    "X-AX-Workspace-ID": workspace, "X-AX-Access-Token": token, "content-type": "application/json" };
  const url = `${settings.apiOrigin}${path}`;
  const init = { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const response = await (runtime === "node" ? node.fetch(new Request(url, init)) : worker.dispatchFetch(url, init));
  const content = await response.arrayBuffer();
  return new Response(content, {status:response.status,statusText:response.statusText,headers:Array.from(response.headers.entries())});
}

function request(runtime: "node" | "worker", path: string, token: string, body?: unknown): Promise<Response> {
  const pending = bufferedRequest(runtime,path,token,body).finally(()=>pendingRequests.delete(pending));
  pendingRequests.add(pending);
  return pending;
}

test("Node and workerd share PostgreSQL acceptance, replay, ownership and restart persistence", async () => {
  for (const runtime of ["node", "worker"] as const) {
    assert.equal((await request(runtime, "/v1/status", "")).status, 200, `${runtime} readiness`);
    assert.equal((await request(runtime, "/v1/runs", "invalid")).status, 401);
    const response = await request(runtime, "/v1/runs", alice);
    assert.equal(response.status, 200, `${runtime} can authenticate and read PostgreSQL`);
  }
  const input = { key: randomUUID(), mode: "offline", instruction: "runtime persistence", input_text: "saved", output_name: "reply.txt", allow_model: false };
  const accepted = await request("worker", "/v1/runs", alice, input);
  assert.equal(accepted.status, 202);
  const first = await accepted.json() as { run_id: string; replayed: boolean };
  assert.equal(first.replayed, false);
  const replay = await request("node", "/v1/runs", alice, input);
  assert.deepEqual(await replay.json(), { ...first, replayed: true });
  assert.equal((await request("worker", "/v1/runs", alice, { ...input, instruction: "different" })).status, 409);
  assert.equal((await request("worker", `/v1/runs/${first.run_id}`, bob)).status, 404);
  assert.equal((await request("worker", `/v1/runs/${first.run_id}/artifact`, bob)).status, 404);
  assert.equal((await request("worker", `/v1/runs/${first.run_id}/recover`, bob, {})).status, 404);
  node = createRuntime(settings, pool);
  assert.equal((await request("node", `/v1/runs/${first.run_id}`, alice)).status, 200);
  await stopWorker();
  await startWorker();
  assert.equal((await request("worker", `/v1/runs/${first.run_id}`, alice)).status, 200);
  assert.deepEqual(await (await request("worker", "/v1/runs", alice, input)).json(), { ...first, replayed: true });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ax_jobs")).rows[0].n, 1);

});

test("Worker fixture drains outstanding responses before restart", async () => {
  const reads = Promise.allSettled(Array.from({length:12},()=>request("worker","/v1/runs",alice)));
  await stopWorker();
  assert.ok((await reads).every(result=>result.status === "fulfilled" && result.value.status===200));
  await startWorker();
});

for (const runtime of ["node", "workerd"] as const) test(`${runtime} Worker adapter refuses an interrupted PostgreSQL connection without retrying admission`, { timeout: 10_000 }, async () => {
  const beforeErrors = workerErrors;
  const beforeCount = (await pool.query("SELECT count(*)::int AS n FROM ax_jobs")).rows[0].n;
  const input = { key: randomUUID(), mode: "offline", instruction: "interrupted request", input_text: "saved", output_name: "reply.txt", allow_model: false };
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  let body: ReadableStreamDefaultController<Uint8Array>;
  const init = {
    method: "POST", headers: { authorization: `Bearer ${settings.apiToken}`, "X-AX-Workspace-ID": workspace, "X-AX-Access-Token": alice, "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({ start(controller) { body = controller; controller.enqueue(encoded.slice(0, 1)); } }),
    duplex: "half" as const,
  };
  const { database: _, ...application } = settings;
  const pending = runtime === "workerd" ? worker.dispatchFetch(`${settings.apiOrigin}/v1/runs`, init)
    : workerAdapter.fetch(new Request(`${settings.apiOrigin}/v1/runs`, { ...init, headers: { ...init.headers, host: new URL(settings.apiOrigin).host }, body: init.body as unknown as BodyInit }),
      { API_SETTINGS: JSON.stringify(application), POSTGRES: { connectionString: workerConnectionString } });
  try {
    let pid: number | undefined;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name=$1 AND state='idle'", [schema]);
      assert.ok(result.rows.length <= 1, "Only the request's isolated test connection can be terminated");
      pid = result.rows[0]?.pid;
      if (pid !== undefined) break;
      await delay(20);
    }
    assert.ok(pid !== undefined, "The request must authenticate before its body is released");
    const terminated = await admin.query<{ stopped: boolean }>("SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND usename=current_user AND application_name=$2", [pid, schema]);
    assert.equal(terminated.rows[0]?.stopped, true);
    await delay(50);
  } finally {
    body!.enqueue(encoded.slice(1));
    body!.close();
  }
  const response = await pending;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "bridge_unavailable" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ax_jobs")).rows[0].n, beforeCount);
  assert.equal((await request("worker", "/v1/runs", alice)).status, 200);
  assert.equal(workerErrors, beforeErrors, "A disconnected client must not emit an unhandled Worker error");
});

test("workerd and Node share workspace idempotency and one-time invitation tokens", async () => {
  const body = { key: randomUUID(), name: "Worker会社" };
  const first = await (await request("worker", "/v1/workspaces", alice, body)).json() as { workspace: {id:string}; replayed:boolean };
  assert.equal(first.replayed, false);
  assert.deepEqual(await (await request("node", "/v1/workspaces", alice, body)).json(), {...first,replayed:true});
  const path = `/v1/workspaces/${first.workspace.id}/invitations`;
  const inviteBody = {key:randomUUID(),email:"bob@example.test"};
  const invite = await (await request("worker", path, alice, inviteBody)).json() as {id:string;token:string;expires_at:string;replayed:boolean};
  assert.equal(invite.token.length,43);
  assert.deepEqual(await (await request("node", path, alice, inviteBody)).json(), {...invite,token:null,replayed:true});
  const accepted = await request("worker", "/v1/invitations/accept", bob, {token:invite.token});
  assert.equal(accepted.status,200);
  const detail = await (await request("node", `/v1/workspaces/${first.workspace.id}`, bob)).json() as {workspace:{access_level:string};invitations:unknown[]};
  assert.equal(detail.workspace.access_level,"member"); assert.deepEqual(detail.invitations,[]);
});

test("disabled identities are refused by both runtimes", async () => {
  await pool.query("UPDATE users SET status='disabled' WHERE id=(SELECT user_id FROM identities WHERE subject='runtime-bob')");
  for (const runtime of ["node", "worker"] as const) assert.equal((await request(runtime, "/v1/runs", bob)).status, 401);
});
