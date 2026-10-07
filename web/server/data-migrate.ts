import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";

export async function migrateData(pool: pg.Pool) {
  const migrations = ["schema.sql", "schema-v2.sql", "schema-v3.sql", "schema-v4.sql"].map((name, index) => {
    const source = readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8");
    return { version: index + 1, source, digest: createHash("sha256").update(source).digest("hex") };
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(714285902)");
    await client.query("CREATE TABLE IF NOT EXISTS ax_migrations(version integer PRIMARY KEY, digest text NOT NULL)");
    const { rows } = await client.query("SELECT version,digest FROM ax_migrations ORDER BY version");
    if (rows.some((row, index) => row.version !== index + 1 || migrations[index]?.digest !== row.digest)) throw new Error("Unsupported application schema version or checksum.");
    for (const migration of migrations.slice(rows.length)) {
      await client.query(migration.source);
      await client.query("INSERT INTO ax_migrations(version,digest) VALUES($1,$2)", [migration.version, migration.digest]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
