import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { OrchError, requireThat, PROGRESS, STAGES, VERDICTS, type Binding, type Ref, type Target, type State } from "./model.ts";

export function object(value: unknown, label = "input"): Record<string, unknown> {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_INPUT", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function str(value: unknown, label: string): string {
  requireThat(typeof value === "string" && value.trim().length > 0, "INVALID_INPUT", `${label} must be a nonempty string`);
  return value;
}
export function optional(value: unknown, label: string, fallback = ""): string { return value === undefined ? fallback : str(value, label); }
export function array(value: unknown, label: string): unknown[] {
  requireThat(Array.isArray(value), "INVALID_INPUT", `${label} must be an array`); return value;
}
export function strings(value: unknown, label: string): string[] { return array(value, label).map(v => str(v, label)); }
export function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  requireThat(typeof value === "string" && values.includes(value as T), "INVALID_INPUT", `${label} must be one of ${values.join(", ")}`); return value as T;
}
export function bool(value: unknown, label: string): boolean { requireThat(typeof value === "boolean", "INVALID_INPUT", `${label} must be boolean`); return value; }
export function integer(value: unknown, label: string, min = 1): number { requireThat(Number.isSafeInteger(value) && (value as number) >= min, "INVALID_INPUT", `${label} must be an integer >= ${min}`); return value as number; }
export function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) requireThat(allowed.includes(key), "INVALID_INPUT", `Unknown field: ${key}`);
}
export function binding(value: unknown): Binding { const o = object(value, "binding"); keys(o, ["actor", "session"]); return { actor: str(o.actor, "actor"), session: str(o.session, "session") }; }
export function same(a: Binding, b: Binding): boolean { return a.actor === b.actor && a.session === b.session; }
export function id(value: unknown): string { const s = str(value, "id"); requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(s), "INVALID_INPUT", "ID must contain letters, numbers, '.', '_' or '-'"); return s; }
export function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
export async function captureRefs(project: string, value: unknown = []): Promise<Ref[]> {
  return Promise.all(strings(value, "refs").map(async ref => {
    if (/^https?:\/\//.test(ref)) { new URL(ref); return { ref, digest: null }; }
    const path = resolve(project, ref);
    try { requireThat((await stat(path)).isFile(), "INVALID_REFERENCE", `Not a file: ${ref}`); return { ref, digest: hash(await readFile(path)) }; }
    catch (error) { if (error instanceof OrchError) throw error; throw new OrchError("INVALID_REFERENCE", `Cannot read reference: ${ref}`); }
  }));
}
export async function refsCurrent(project: string, refs: Ref[]): Promise<boolean> {
  try { return stable(await captureRefs(project, refs.map(r => r.ref))) === stable(refs); } catch { return false; }
}
export async function target(project: string, value: unknown): Promise<Target> {
  const o = object(value, "target"); keys(o, ["id", "kind", "files", "ref", "version"]);
  const kind = member(o.kind, ["files", "external"] as const, "target.kind");
  if (kind === "files") {
    const files = strings(o.files, "target.files"); requireThat(files.length && new Set(files).size === files.length && files.every(f => !/^https?:/.test(f)), "INVALID_INPUT", "files must be distinct local files");
    const refs = await captureRefs(project, [...files].sort()); const version = hash(stable(refs));
    requireThat(o.version === undefined || o.version === version, "ARTIFACT_CHANGED", "Target differs from the supplied version");
    return { id: id(o.id), kind, refs, version };
  }
  return { id: id(o.id), kind, refs: [{ ref: str(o.ref, "target.ref"), digest: null }], version: str(o.version, "target.version") };
}
export async function targetCurrent(project: string, t: Target): Promise<boolean> { return t.kind === "external" || await refsCurrent(project, t.refs); }

type Validator = (v: unknown) => void;
const string: Validator = v => { requireThat(typeof v === "string", "CORRUPT_STATE", "Expected string"); };
const number: Validator = v => { integer(v, "stored integer", 0); };
const boolean: Validator = v => { bool(v, "stored boolean"); };
const any: Validator = () => {};
const nullable = (v: Validator): Validator => x => { if (x !== null) v(x); };
const list = (v: Validator): Validator => x => { array(x, "stored array").forEach(v); };
const enumeration = (values: readonly string[]): Validator => x => { member(x, values, "stored enum"); };
const shape = (fields: Record<string, Validator>): Validator => x => { const o = object(x, "stored object"); keys(o, Object.keys(fields)); for (const [k,v] of Object.entries(fields)) v(o[k]); };
const bind = shape({ actor: string, session: string });
const ref = shape({ ref: string, digest: nullable(string) });
const tgt = shape({ id: string, kind: enumeration(["files", "external"]), refs: list(ref), version: string });
const condition = shape({ id: string, description: string, purpose: enumeration(["delivery", "assessment"]), required: boolean, allowed: list(enumeration(VERDICTS)), target: string });
const stage = shape({ selection: enumeration(["execute", "integrate", "reuse", "omit"]), reason: string, state: enumeration([...PROGRESS, "not-applicable"]), refs: list(ref) });
const stages: Validator = x => { const o = object(x); keys(o, [...STAGES]); Object.values(o).forEach(stage); };
const dependency = shape({ on: string, reason: string, checks: list(shape({ condition: string, verdict: enumeration(VERDICTS) })) });
const link = shape({ unit: string, submission: string });
const inputs = shape({ contractVersion: number, contractFiles: list(ref), dependencies: list(link) });
const attempt = shape({ number, state: enumeration(PROGRESS), stages, inputs: nullable(inputs), reason: string, next: string, resumeRef: nullable(ref), createdAt: string });
const unit = shape({ id: string, parent: nullable(string), size: enumeration(["small", "standard", "large"]), purpose: string, track: string, owner: bind, recorder: bind, verifiers: list(bind), scope: list(string), taskRef: nullable(string), planRef: nullable(string), contractFiles: list(ref), conditions: list(condition), dependencies: list(dependency), exclusions: list(shape({ unit: string, reason: string })), version: number, contractVersion: number, attempts: list(attempt), currentAttempt: number, currentSubmission: nullable(string), contractHistory: list(shape({ version: number, snapshot: any, reason: string, at: string })) });
const check = shape({ id: string, unit: string, attempt: number, condition: string, target: tgt, verdict: enumeration(VERDICTS), evidence: list(ref), reason: string, method: string, environment: string, observedAt: string, performer: string, recordedBy: bind, supersedes: nullable(string), reusedFrom: nullable(string), reuseReason: string, at: string });
const submission = shape({ id: string, unit: string, attempt: number, contractVersion: number, inputs, checks: list(string), outputs: list(tgt), report: string, refs: list(ref), children: list(link), active: boolean, obsoleteReason: string, successor: nullable(string), createdBy: bind, at: string, acceptance: shape({ state: enumeration(["pending", "accepted", "changes-requested"]), reason: string, actor: nullable(bind), at: nullable(string) }) });
const message = shape({ id: string, unit: string, attempt: number, from: bind, to: string, kind: enumeration(["report", "help", "completion"]), body: string, refs: list(ref), submission: nullable(string), state: enumeration(["pending", "processed", "obsolete"]), resolution: string, at: string });
const gate = shape({ id: string, version: number, unit: string, question: string, options: list(string), recommendation: string, respondent: string, state: enumeration(["open", "resolved"]), answer: string, evidence: list(ref), history: list(any), at: string });
const state = shape({ schemaVersion: number, revision: number, project: string, coordinator: bind, createdAt: string, updatedAt: string, units: list(unit), checks: list(check), submissions: list(submission), messages: list(message), gates: list(gate), operations: list(shape({ id: string, hash: string, actor: bind, command: string, request: v => { object(v, "operation.request"); }, affectedUnits: list(string), evidence: list(ref), revision: number, data: any, at: string })) });
export function validateState(value: unknown): asserts value is State {
  try {
    requireThat(object(value).schemaVersion === 1, "SCHEMA_VERSION", "Unsupported schemaVersion"); state(value);
    const s = value as State;
    for (const collection of [s.units, s.checks, s.submissions, s.messages, s.gates, s.operations]) requireThat(new Set(collection.map(x => x.id)).size === collection.length, "CORRUPT_STATE", "Duplicate ID");
    for (const u of s.units) {
      requireThat(u.attempts.some(a => a.number === u.currentAttempt) && new Set(u.attempts.map(a => a.number)).size === u.attempts.length, "CORRUPT_STATE", "Invalid attempts");
      requireThat(!u.parent || s.units.some(p => p.id === u.parent), "CORRUPT_STATE", "Missing parent");
      requireThat(u.conditions.length && new Set(u.conditions.map(c => c.id)).size === u.conditions.length, "CORRUPT_STATE", "Invalid conditions");
      for (const d of u.dependencies) requireThat(s.units.some(p => p.id === d.on), "CORRUPT_STATE", "Missing dependency");
      if (u.currentSubmission) requireThat(s.submissions.some(p => p.id === u.currentSubmission && p.unit === u.id), "CORRUPT_STATE", "Missing submission");
    }
    for (const c of [...s.checks, ...s.submissions, ...s.messages, ...s.gates]) requireThat(s.units.some(u => u.id === c.unit), "CORRUPT_STATE", "Missing unit");
  } catch (error) { if (error instanceof OrchError && error.code === "SCHEMA_VERSION") throw error; throw new OrchError("CORRUPT_STATE", `Invalid store: ${error instanceof Error ? error.message : error}`); }
}
