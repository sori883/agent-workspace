import { readFileSync } from "node:fs";
import type pg from "pg";

export async function migrateAuth(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(714285901)");
    await client.query("CREATE TABLE IF NOT EXISTS auth_migrations(version integer PRIMARY KEY)");
    const { rows } = await client.query("SELECT version FROM auth_migrations ORDER BY version");
    if (rows.some((row) => row.version !== 1)) throw new Error("Unsupported authentication schema version");
    if (!rows.length) {
      await client.query(readFileSync(new URL("./auth-schema.sql", import.meta.url), "utf8"));
      await client.query("INSERT INTO auth_migrations(version) VALUES (1)");
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
