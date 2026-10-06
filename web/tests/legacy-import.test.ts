import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLegacyRecords } from "../server/legacy-import";

test("legacy import rejects unknown ledger entries while preserving pending records outside the queue", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ax-import-")));
  try {
    mkdirSync(join(root, ".pending-interrupted"));
    writeFileSync(join(root, ".lock"), "");
    assert.deepEqual(readLegacyRecords(root), []);
    mkdirSync(join(root, "corrupt-run"));
    assert.throws(() => readLegacyRecords(root), /unknown entry/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy import refuses artifacts outside the locked and backed-up directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ax-import-")));
  const external = realpathSync(mkdtempSync(join(tmpdir(), "ax-external-")));
  try {
    const id = "ax-run-0000000000000001";
    const run = join(root, id);
    mkdirSync(run);
    const content = Buffer.from("原文\0😀");
    const result = { artifact: { name: "reply.txt", size_bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") } };
    writeFileSync(join(run, "receipt.json"), JSON.stringify({ run_id: id, result }));
    writeFileSync(join(run, "request.json"), JSON.stringify({ run_id: id }));
    writeFileSync(join(run, "manifest.json"), "{}");
    writeFileSync(join(run, "result.json"), JSON.stringify(result));
    writeFileSync(join(external, "reply.txt"), content);
    symlinkSync(external, join(run, "artifacts"));
    assert.throws(() => readLegacyRecords(root), /ancestor/);
    rmSync(join(run, "artifacts"));
    mkdirSync(join(run, "artifacts"));
    symlinkSync(join(external, "reply.txt"), join(run, "artifacts/reply.txt"));
    assert.throws(() => readLegacyRecords(root), /file type/);
    rmSync(join(run, "artifacts/reply.txt"));
    writeFileSync(join(run, "artifacts/reply.txt"), content);
    const [record] = readLegacyRecords(root);
    assert.equal(record!.invalid, false);
    assert.deepEqual(record!.artifact, content);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
});
