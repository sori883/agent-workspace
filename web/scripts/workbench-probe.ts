import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { readAuthConfig } from "../server/auth-config";
import { migrateAuth } from "../server/auth-migrate";
import { migrateData } from "../server/data-migrate";
import { WorkspaceRepository } from "../data/workspaces";
import { WorkbenchRepository } from "../data/workbench";
import { FileRepository } from "../data/files";
import { executionFunctions } from "../data/permissions";

const { values } = parseArgs({ options: { schema: { type: "string" }, "execution-role": { type: "string" }, runtime: { type: "string" }, code: { type: "string" }, scenario: { type: "string", default: "csv-xlsx" } }, strict: true, allowPositionals: false });
const schema = values.schema;
const scenario = values.scenario!;
if (!["csv-xlsx", "copy-8m-1", "copy-8m-4", "isolation-boundary"].includes(scenario)) throw new Error("A fixed probe scenario is required");
const instruction = scenario === "isolation-boundary" ? "AX workbench isolated boundary probe v1" : scenario === "csv-xlsx" ? "AX workbench isolated tabular probe v1" : `AX workbench isolated 8MiB ${scenario === "copy-8m-1" ? "single" : "four"}-copy probe v1`;
const fixtureFiles: [string, Buffer][] = scenario === "isolation-boundary" ? [["sales.csv", Buffer.from("amount\n100\n200\n")]] : scenario === "csv-xlsx" ? [["sales.csv", Buffer.from("amount\n100\n200\n")], ["sample.xlsx", readFileSync(new URL("../tests/fixtures/workbench-input.xlsx", import.meta.url))]] : (scenario === "copy-8m-1" ? [8388608] : [1048577, 2097155, 3145733, 2097143]).map((size, index) => {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset++) bytes[offset] = (offset + 17 * (index + 1)) % 256;
  return [`copy-input-${index + 1}.csv`, bytes];
});
const image = /^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
if (!schema || !/^ax_workbench_probe_[a-z0-9_]{8,40}$/.test(schema) || values["execution-role"] !== schema || !image.test(values.runtime ?? "") || !image.test(values.code ?? "") || !process.env.AUTH_CONFIG_FILE) throw new Error("Explicit isolated schema and matching dedicated role, pinned images and AUTH_CONFIG_FILE are required");
const { caPath, ...database } = readAuthConfig().database;
const config = { ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false, max: 2, statement_timeout: 15000 };
const admin = new pg.Pool(config), pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
try {
  const role = (await admin.query("SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS inherited FROM pg_roles r WHERE rolname=$1", [schema])).rows[0];
  if (!role?.rolcanlogin || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.inherited) throw new Error("A dedicated restricted login role must be prepared separately");
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`);
  await migrateAuth(pool);
  await migrateData(pool);
  await pool.query("UPDATE ax_control SET accepting=true");
  await pool.query("UPDATE ax_workbench_control SET trial_enabled=false,python_enabled=true,code_profile='host-quota-8m-v1',runtime_image=$1,code_image=$2", [values.runtime, values.code]);
  const owner = randomUUID();
  await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','Isolated AX probe')", [owner]);
  const workspace = (await new WorkspaceRepository(pool).create(owner, { key: randomUUID(), name: "Synthetic AX validation only" })).workspace.id;
  const files = new FileRepository(pool), ids: string[] = [], inputs: object[] = [];
  for (const [name, bytes] of fixtureFiles) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = (await files.begin(owner, workspace, { key: randomUUID(), name, size_bytes: bytes.length, sha256 })).file;
    for (let offset = 0; offset < bytes.length; offset += 32768) await files.putChunk(owner, workspace, file.id, offset / 32768, bytes.subarray(offset, offset + 32768));
    await files.seal(owner, workspace, file.id); ids.push(file.id); inputs.push({ alias: `input_${ids.length}`, file_id: file.id, name, size_bytes: bytes.length, sha256 });
  }
  const root = await new WorkbenchRepository(pool).start(owner, workspace, { key: randomUUID(), text: instruction, mode: "preview", input_file_ids: ids }, Math.floor(Date.now() / 1000) + 3600, createHash("sha256").update(randomUUID()).digest("hex"));
  const pinned = (await pool.query("SELECT runtime_image,code_image,code_profile,mode FROM ax_agent_roots WHERE id=$1", [root.root_id])).rows[0];
  if (pinned?.runtime_image !== values.runtime || pinned.code_image !== values.code || pinned.code_profile !== "host-quota-8m-v1" || pinned.mode !== "preview") throw new Error("Probe root configuration does not match the fixed images and profile");
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${schema}" FROM PUBLIC`);
  await admin.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE "${database.database.replaceAll('"', '""')}" TO "${schema}"`);
  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${schema}"`);
  const { rows } = await pool.query("SELECT p.proname,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[])", [schema, executionFunctions]);
  if (rows.length !== executionFunctions.length) throw new Error("Incomplete execution contract");
  for (const row of rows) await pool.query(`GRANT EXECUTE ON FUNCTION ${row.signature} TO "${schema}"`);
  console.info(JSON.stringify({ schema, owner, workspace, ...root, inputs, runtime_image: values.runtime, code_image: values.code, code_profile: pinned.code_profile, external_model: false, fixture: { version: 1, schema, root_id: root.root_id, scenario, inputs } }));
} finally { await pool.end(); await admin.end(); }
