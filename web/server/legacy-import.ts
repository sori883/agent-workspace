import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type pg from "pg";

export type LegacyRecord = { id: string; sortAt: string; receipt: Buffer; request: Buffer; result: Buffer | null; manifest: Buffer; artifact: Buffer | null; invalid: boolean; sourceHash: string };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function read(path: string, optional = false): Buffer | null {
  directory(dirname(path));
  let info;
  try { info = lstatSync(path); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Legacy file unavailable."); }
  if (!info.isFile() || info.size > 1_048_576) throw new Error("Legacy file type or size is invalid.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 1_048_576 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("Legacy file changed while reading.");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function directory(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (!lstatSync(current).isDirectory()) throw new Error("Legacy directory or ancestor is invalid.");
    if (dirname(current) === current) break;
  }
}

export function readLegacyRecords(root: string): LegacyRecord[] {
  directory(root);
  const names = readdirSync(root);
  if (names.some((name) => !name.startsWith(".") && !/^ax-run-[a-f0-9]{16}$/.test(name))) throw new Error("Legacy ledger contains an unknown entry.");
  return names.filter((name) => /^ax-run-[a-f0-9]{16}$/.test(name)).sort().map((id) => {
    const directory = join(root, id);
    if (!lstatSync(directory).isDirectory()) throw new Error("Legacy run directory is invalid.");
    const receipt = read(join(directory, "receipt.json"))!;
    const request = read(join(directory, "request.json"))!;
    const result = read(join(directory, "result.json"), true);
    const manifest = read(join(directory, "manifest.json"))!;
    let saved, input;
    try { saved = JSON.parse(receipt.toString("utf8")); input = JSON.parse(request.toString("utf8")); }
    catch { throw new Error(`Legacy record ${id} needs manual inspection.`); }
    if (saved.run_id !== id || input.run_id !== id) throw new Error(`Legacy record ${id} has an inconsistent identity.`);
    const name = saved.result?.artifact?.name;
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name))) throw new Error(`Legacy record ${id} has an invalid artifact name.`);
    const artifact = name ? read(join(directory, "artifacts", name), true) : null;
    let invalid = false;
    if (saved.result) {
      try { invalid = !result || JSON.stringify(JSON.parse(result.toString("utf8"))) !== JSON.stringify(saved.result); }
      catch { invalid = true; }
      if (name) invalid ||= artifact === null || artifact.length !== saved.result.artifact.size_bytes || digest(artifact) !== saved.result.artifact.sha256;
    } else if (result) invalid = true;
    const sourceHash = digest(Buffer.from(JSON.stringify([receipt, request, result, manifest, artifact].map((value) => value?.toString("hex") ?? null))));
    return { id, sortAt: lstatSync(directory).mtime.toISOString(), receipt, request, result, manifest, artifact, invalid, sourceHash };
  });
}

export async function importLegacyRecords(pool: pg.Pool, records: LegacyRecord[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(714285902)");
    for (const record of records) {
      const { rows } = await client.query("SELECT ax_import_run($1,$2,$3,$4,$5,$6) AS value", [
        { sort_at: record.sortAt, invalid: record.invalid }, record.receipt, record.request, record.result, record.manifest, record.artifact,
      ]);
      if (rows[0]?.value?.run_id !== record.id || rows[0]?.value?.source_hash !== record.sourceHash) throw new Error("Imported source verification failed.");
    }
    await client.query("SELECT ax_complete_import()");
    const { rows } = await client.query("SELECT count(*)::int AS count, count(*) FILTER (WHERE invalid)::int AS quarantined, count(*) FILTER (WHERE NOT resolved)::int AS unresolved FROM ax_runs");
    if (rows[0].count !== records.length) throw new Error("Imported record count does not match the closed legacy ledger.");
    await client.query("COMMIT");
    return rows[0] as { count: number; quarantined: number; unresolved: number };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
