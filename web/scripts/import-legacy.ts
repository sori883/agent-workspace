import { cpSync, fstatSync, lstatSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";
import { readLegacyRecords, importLegacyRecords } from "../server/legacy-import";

async function run() {
  const root = resolve(process.env.AX_LEGACY_RUNS ?? "../ax-local/.state/runs");
  const dryRun = process.argv.slice(2).length === 1 && process.argv[2] === "--dry-run";
  if (!dryRun && process.argv.length !== 2) throw new Error("Use --dry-run or the locked migration wrapper.");
  if (!dryRun) {
    if (!lstatSync(resolve(root, "..", "execution/managed")).isFile()) throw new Error("Legacy admission must be retired before importing.");
    const fd = Number(process.env.AX_LEGACY_LOCK_FD);
    if (!Number.isInteger(fd) || fd < 3) throw new Error("Migration requires the legacy file lock.");
    const held = fstatSync(fd);
    const expected = lstatSync(join(root, ".lock"));
    if (!held.isFile() || held.dev !== expected.dev || held.ino !== expected.ino) throw new Error("Legacy file lock mismatch.");
  }
  const records = readLegacyRecords(root);
  if (dryRun) { console.info(JSON.stringify({ event: "legacy_preview", runs: records.length, quarantined: records.filter((record) => record.invalid).length })); return; }
  const backup = resolve(root, "..", `migration-backup-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(backup, { mode: 0o700 });
  cpSync(root, join(backup, "runs"), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  const pool = createPool(readAuthConfig());
  try { console.info(JSON.stringify({ event: "legacy_imported", ...await importLegacyRecords(pool, records) })); }
  finally { await pool.end(); }
}
try { await run(); }
catch { console.error("Legacy migration stopped. Admission was not opened; inspect the saved records and migration prerequisites."); process.exitCode = 1; }
