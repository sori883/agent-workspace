import { apiFunctions, executionFunctions } from "../data/permissions";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";
import { migrateData } from "../server/data-migrate";

async function run() {
  const auth = readAuthConfig();
  if (!["localhost", "127.0.0.1"].includes(auth.database.host) || auth.database.port !== 55432) throw new Error("This helper prepares only the local Docker database.");
  const pool = createPool(auth);
  const secrets = resolve("../ax-local/.state/postgres/secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const sql = (input: string) => execFileSync("docker", ["exec", "-i", "ax-local-postgres", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    await migrateData(pool);
    for (const role of ["ax_api", "ax_execution"]) {
      const path = resolve(secrets, `${role}.password`);
      const exists = sql(`SELECT 1 FROM pg_roles WHERE rolname='${role}';`) === "1";
      if (exists && !existsSync(path)) throw new Error("A runtime role exists without its saved credential.");
      if (!exists) {
        const password = existsSync(path) ? readFileSync(path, "utf8").trim() : randomBytes(32).toString("base64url");
        if (!/^[A-Za-z0-9_-]{40,}$/.test(password)) throw new Error("Invalid saved credential.");
        if (!existsSync(path)) writeFileSync(path, password, { mode: 0o600, flag: "wx" });
        sql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}';`);
      }
      await pool.query(`GRANT CONNECT ON DATABASE "${auth.database.database.replaceAll('"', '""')}" TO ${role}`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    }
    await pool.query("GRANT SELECT ON users,identities TO ax_api");
    const api = apiFunctions;
    const execution = executionFunctions;
    const { rows } = await pool.query("SELECT p.proname,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1)", [[...api, ...execution]]);
    if (rows.length !== api.length + execution.length) throw new Error("Runtime database contract is incomplete.");
    for (const row of rows) await pool.query(`GRANT EXECUTE ON FUNCTION ${row.signature} TO ${api.includes(row.proname) ? "ax_api" : "ax_execution"}`);
    const config = { issuer: auth.issuer, clientId: auth.clientId, audience: auth.audience,
      database: { ...auth.database, user: "ax_api", password: readFileSync(resolve(secrets, "ax_api.password"), "utf8").trim() } };
    writeFileSync(resolve("../ax-local/.state/auth/api.json"), JSON.stringify(config), { mode: 0o600 });
    console.info("Restricted API and execution roles prepared; admission is unchanged.");
  } finally { await pool.end(); }
}
try { await run(); }
catch { console.error("Local runtime preparation failed. No admission was opened."); process.exitCode = 1; }
