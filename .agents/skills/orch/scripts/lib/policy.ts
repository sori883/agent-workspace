import { current, requireThat, type State, type Unit, type Request, type Binding, type Inputs, type Check, type Submission } from "./model.ts";
import { binding, same, refsCurrent, targetCurrent, stable, str, captureRefs } from "./validation.ts";

export function unit(s: State, id: string | undefined): Unit { const u = s.units.find(u => u.id === id); requireThat(u, "NOT_FOUND", `Unknown unit: ${id}`); return u; }
export function actor(r: Request): Binding { return binding({ actor: r.actor, session: r.session }); }
export function authenticate(r: Request, expected: Binding): void {
  const actual = actor(r); requireThat(actual.actor === expected.actor, "NOT_OWNER", "This role does not own this operation");
  requireThat(actual.session === expected.session, "SESSION_MISMATCH", "Use the registered session or an explicit handoff", 3);
}
export function manager(s: State, u: Unit): Binding { return u.parent ? unit(s, u.parent).owner : s.coordinator; }
export function version(r: Request, u: Unit): void { requireThat(r.ifVersion === u.version, "VERSION_CONFLICT", `Expected current version ${u.version}`, 3); }
export function worker(r: Request, u: Unit): void {
  authenticate(r, u.recorder); version(r, u); requireThat(r.attempt === u.currentAttempt, "ATTEMPT_CONFLICT", `Expected attempt ${u.currentAttempt}`, 3);
}
export function headCheck(s: State, u: Unit, condition: string): Check | undefined {
  const checks = s.checks.filter(c => c.unit === u.id && c.attempt === u.currentAttempt && c.condition === condition);
  const heads = checks.filter(c => !checks.some(next => next.supersedes === c.id));
  requireThat(heads.length <= 1, "CORRUPT_STATE", "Multiple current verification records"); return heads[0];
}
export async function checkCurrent(s: State, c: Check): Promise<boolean> { return await targetCurrent(s.project, c.target) && await refsCurrent(s.project, c.evidence); }
export function assertNoCycles(s: State): void {
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(u: Unit) {
    requireThat(!visiting.has(u.id), "DEPENDENCY_CYCLE", `Cycle through ${u.id}`);
    if (visited.has(u.id)) return;
    visiting.add(u.id);
    for (const id of [...u.dependencies.map(d => d.on), ...s.units.filter(c => c.parent === u.id && !u.exclusions.some(e => e.unit === c.id)).map(c => c.id)]) visit(unit(s, id));
    visiting.delete(u.id); visited.add(u.id);
  }
  for (const u of s.units) visit(u);
}
export async function submissionValid(s: State, sub: Submission, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(sub.id)) return false;
  const u = unit(s, sub.unit);
  if (!sub.active || sub.id !== u.currentSubmission || sub.attempt !== u.currentAttempt || sub.contractVersion !== u.contractVersion || current(u).state !== "completed") return false;
  if (s.gates.some(g => g.unit === u.id && g.state === "open")) return false;
  if (!await refsCurrent(s.project, sub.inputs.contractFiles) || !await refsCurrent(s.project, sub.refs)) return false;
  if (stable(sub.inputs.contractFiles) !== stable(u.contractFiles)) return false;
  if (!await Promise.all(sub.outputs.map(t => targetCurrent(s.project, t))).then(v => v.every(Boolean))) return false;
  for (const checkId of sub.checks) {
    const c = s.checks.find(c => c.id === checkId);
    if (!c || headCheck(s, u, c.condition)?.id !== c.id || !await checkCurrent(s, c)) return false;
  }
  const expectedChildren = s.units.filter(c => c.parent === u.id && !u.exclusions.some(e => e.unit === c.id));
  if (stable(expectedChildren.map(c => c.id).sort()) !== stable(sub.children.map(c => c.unit).sort())) return false;
  if (stable(u.dependencies.map(d => d.on).sort()) !== stable(sub.inputs.dependencies.map(d => d.unit).sort())) return false;
  const nextSeen = new Set(seen).add(sub.id);
  for (const link of [...sub.inputs.dependencies, ...sub.children]) {
    const upstream = s.submissions.find(t => t.id === link.submission && t.unit === link.unit);
    if (!upstream || upstream.acceptance.state !== "accepted" || !await submissionValid(s, upstream, nextSeen)) return false;
  }
  return true;
}
export async function acceptedSubmission(s: State, id: string): Promise<Submission> {
  const u = unit(s, id), sub = s.submissions.find(t => t.id === u.currentSubmission);
  requireThat(sub && sub.acceptance.state === "accepted" && await submissionValid(s, sub), "DEPENDENCY_UNMET", `${id} needs a current accepted submission`);
  return sub;
}
export async function snapshotInputs(s: State, u: Unit): Promise<Inputs> {
  requireThat(await refsCurrent(s.project, u.contractFiles), "CONTRACT_CHANGED", "Contract files changed; update the contract and reopen");
  const dependencies: Inputs["dependencies"] = [];
  for (const d of u.dependencies) {
    const sub = await acceptedSubmission(s, d.on);
    for (const required of d.checks) requireThat(sub.checks.some(id => s.checks.some(c => c.id === id && c.condition === required.condition && c.verdict === required.verdict)), "DEPENDENCY_UNMET", `Required verdict from ${d.on}: ${required.condition}`);
    dependencies.push({ unit: d.on, submission: sub.id });
  }
  return { contractVersion: u.contractVersion, contractFiles: structuredClone(u.contractFiles), dependencies: dependencies.sort((a,b) => a.unit.localeCompare(b.unit)) };
}
export async function assertInputs(s: State, u: Unit): Promise<Inputs> {
  const inputs = await snapshotInputs(s, u);
  if (current(u).inputs) requireThat(stable(inputs) === stable(current(u).inputs), "INPUTS_CHANGED", "Contract or inputs changed; reopen is required");
  return inputs;
}
export async function startRequirements(s: State, u: Unit): Promise<Inputs> {
  requireThat(!s.gates.some(g => g.unit === u.id && g.state === "open"), "GATE_OPEN", "Resolve this unit's gates before continuing");
  requireThat(Object.keys(current(u).stages).length > 0, "STAGES_REQUIRED", "Select the stages before starting");
  requireThat(u.scope.length > 0 && u.conditions.some(c => c.required), "CONDITIONS_UNMET", "Scope and delivery conditions are required");
  if (u.size !== "small") { requireThat(u.taskRef, "DOCUMENT_REQUIRED", "A standard/large unit needs task.md"); await captureRefs(s.project, [u.taskRef]); }
  if (u.size === "large") { requireThat(u.planRef, "DOCUMENT_REQUIRED", "A large unit needs plan.md"); await captureRefs(s.project, [u.planRef]); }
  return assertInputs(s, u);
}
export function rotate(s: State, u: Unit, reason: string): void {
  const previous = current(u);
  for (const sub of s.submissions.filter(t => t.unit === u.id && t.active)) { sub.active = false; sub.obsoleteReason = reason; }
  for (const message of s.messages.filter(m => m.unit === u.id && m.kind === "completion" && m.state === "pending")) { message.state = "obsolete"; message.resolution = reason; }
  u.currentAttempt++;
  const stages = Object.fromEntries(Object.entries(previous.stages).map(([name, stage]) => [name, { ...structuredClone(stage), state: stage.selection === "omit" ? "not-applicable" as const : "pending" as const, refs: [] }]));
  u.attempts.push({ number: u.currentAttempt, state: "pending", stages, inputs: null, reason, next: "", resumeRef: null, createdAt: new Date().toISOString() });
  u.currentSubmission = null;
}
export function changeContract(s: State, u: Unit, reason: string): void {
  requireThat(current(u).state !== "running", "STOP_REQUIRED", "Pause the unit before changing its contract");
  u.contractHistory.push({ version: u.contractVersion, snapshot: structuredClone({ purpose: u.purpose, scope: u.scope, conditions: u.conditions, dependencies: u.dependencies, contractFiles: u.contractFiles, exclusions: u.exclusions }), reason, at: new Date().toISOString() });
  u.contractVersion++;
  if (current(u).inputs || ["completed", "cancelled"].includes(current(u).state)) rotate(s, u, reason);
}
export function reason(input: Record<string, unknown>): string { return str(input.reason, "reason"); }
export function isVerifier(r: Request, u: Unit): boolean { return [u.recorder, ...u.verifiers].some(b => same(b, actor(r))); }
