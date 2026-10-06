import { readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { OrchError, requireThat, type Request, type Result, type State } from "./model.ts";
import { captureRefs, hash, object, stable, str, keys } from "./validation.ts";
import { load, writeTransaction } from "./store.ts";
import { actor, assertNoCycles, authenticate } from "./policy.ts";
import { mutateUnit } from "./units.ts";
import { mutateRecord } from "./records.ts";
import { exportState, query } from "./queries.ts";

export const READ_COMMANDS = ["unit get", "unit list", "unit counts", "unit ready", "ledger check", "ledger summary", "inbox list", "gate list", "status", "doctor"];
export const WRITE_COMMANDS = ["init", "unit add", "unit update", "unit assign", "unit start", "unit set", "unit stage", "unit submit", "unit accept", "unit return", "unit reopen", "dependency add", "dependency remove", "ledger record", "inbox push", "inbox ack", "gate park", "gate resolve"];

export async function execute(storePath: string, request: Request): Promise<Result> {
  const store = resolve(storePath); const r = structuredClone(request);
  requireThat([...READ_COMMANDS, ...WRITE_COMMANDS, "export"].includes(r.command), "UNKNOWN_COMMAND", `Unknown command: ${r.command}`);
  if (READ_COMMANDS.includes(r.command)) {
    const state = await load(store); assertNoCycles(state); const data = await query(state, r);
    if (r.command === "doctor") {
      let lock: unknown = null; try { lock = JSON.parse(await readFile(join(store, ".orch.lock"), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") lock = "Unreadable lock; do not remove without inspection"; }
      return { revision: state.revision, data: { ...(data as object), lock } };
    }
    return { revision: state.revision, data };
  }
  if (r.command === "export") { const state = await load(store); authenticate(r, state.coordinator); keys(r.input ?? {}, []); return { revision: state.revision, data: await exportState(store, state) }; }
  const who = actor(r); const operationId = str(r.operationId, "operationId"); const fingerprint = hash(stable(r));
  return writeTransaction<Result>(store, async () => {
    let s: State;
    try { s = await load(store); }
    catch (error) {
      if (!(error instanceof OrchError && error.code === "NOT_INITIALIZED" && r.command === "init")) throw error;
      keys(r.input ?? {}, ["project"]); const project = resolve(str(r.input?.project, "project")); requireThat((await stat(project)).isDirectory(), "INVALID_INPUT", "project must be a directory");
      const now = new Date().toISOString(); s = { schemaVersion: 1, revision: 0, project, coordinator: who, createdAt: now, updatedAt: now, units: [], checks: [], submissions: [], messages: [], gates: [], operations: [] };
    }
    const previous = s.operations.find(op => op.id === operationId);
    if (previous) { requireThat(previous.hash === fingerprint, "OPERATION_CONFLICT", "Operation ID was reused with different input", 3); return { state: s, unchanged: true, result: { revision: previous.revision, data: previous.data, replayed: true } }; }
    assertNoCycles(s);
    const versions = new Map(s.units.map(u => [u.id, u.version]));
    let data: unknown;
    if (r.command === "init") { keys(r.input ?? {}, ["project"]); authenticate(r, s.coordinator); requireThat(resolve(str(r.input?.project, "project")) === s.project, "PROJECT_MISMATCH", "Store already belongs to another project"); data = { project: s.project, coordinator: s.coordinator, store }; }
    else if (r.command.startsWith("unit ") || r.command.startsWith("dependency ")) data = await mutateUnit(s, r);
    else data = await mutateRecord(s, r);
    assertNoCycles(s); s.revision++; s.updatedAt = new Date().toISOString();
    const saved = structuredClone(data);
    const affectedUnits = s.units.filter(u => versions.get(u.id) !== u.version || u.id === r.id || u.id === (data as { unit?: string })?.unit).map(u => u.id);
    const evidenceRefs: string[] = [];
    if (r.command === "unit assign") {
      const handoff = object(r.input?.handoff);
      evidenceRefs.push(str(handoff.stoppedRef, "stoppedRef"));
      if (handoff.authorityRef !== undefined) evidenceRefs.push(str(handoff.authorityRef, "authorityRef"));
    }
    if (r.command === "unit reopen" && r.input?.scopeRef !== undefined) evidenceRefs.push(str(r.input.scopeRef, "scopeRef"));
    const evidence = await captureRefs(s.project, [...new Set(evidenceRefs)]);
    s.operations.push({ id: operationId, hash: fingerprint, actor: who, command: r.command, request: r, affectedUnits, evidence, revision: s.revision, data: saved, at: s.updatedAt });
    return { state: s, result: { revision: s.revision, data: saved } };
  }, { initialize: r.command === "init" });
}
