import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";

export async function migrateData(pool: pg.Pool) {
  const source = readFileSync(new URL("../data/schema.sql", import.meta.url), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(714285902)");
    await client.query("CREATE TABLE IF NOT EXISTS ax_migrations(version integer PRIMARY KEY, digest text NOT NULL)");
    const { rows } = await client.query("SELECT version,digest FROM ax_migrations ORDER BY version");
    if (rows.some((row) => row.version !== 1 || row.digest !== digest)) throw new Error("Unsupported application schema version or checksum.");
    if (!rows.length) {
      await client.query(source);
      await client.query("INSERT INTO ax_migrations(version,digest) VALUES(1,$1)", [digest]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
