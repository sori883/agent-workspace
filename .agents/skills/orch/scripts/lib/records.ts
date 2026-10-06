import { current, requireThat, VERDICTS, type Request, type State, type Check } from "./model.ts";
import { actor, assertInputs, authenticate, checkCurrent, headCheck, isVerifier, manager, reason, unit, version } from "./policy.ts";
import { captureRefs, keys, member, optional, same, str, strings, target } from "./validation.ts";

export async function mutateRecord(s: State, r: Request): Promise<unknown> {
  const p = r.input ?? {};
  if (r.command === "inbox ack") {
    keys(p, ["reason"]); const m = s.messages.find(m => m.id === r.id); requireThat(m, "NOT_FOUND", "Unknown message");
    const u = unit(s, m.unit); authenticate(r, manager(s, u)); requireThat(actor(r).actor === m.to, "NOT_OWNER", "Message belongs to a different recipient");
    requireThat(m.kind !== "completion", "DECISION_REQUIRED", "Use accept/return for a completion message");
    requireThat(m.state === "pending", "ALREADY_PROCESSED", "Message is already processed"); m.state = "processed"; m.resolution = reason(p); return m;
  }
  if (r.command === "gate resolve") {
    keys(p, ["answer", "evidence"]); const g = s.gates.find(g => g.id === r.id); requireThat(g, "NOT_FOUND", "Unknown gate");
    const u = unit(s, g.unit); authenticate(r, manager(s, u)); requireThat(r.ifVersion === g.version, "VERSION_CONFLICT", `Expected gate version ${g.version}`, 3);
    requireThat(g.state === "open", "ALREADY_RESOLVED", "Gate is already resolved");
    const evidence = await captureRefs(s.project, p.evidence); requireThat(evidence.length, "EVIDENCE_REQUIRED", "Record the answer's source");
    g.history.push(structuredClone({ ...g, history: undefined })); g.answer = str(p.answer, "answer"); g.evidence = evidence; g.state = "resolved"; g.version++; g.at = new Date().toISOString(); u.version++; return g;
  }
  if (r.command === "gate park") {
    keys(p, ["unit", "question", "options", "recommendation", "respondent"]);
    const u = unit(s, str(p.unit, "unit")); const caller = actor(r);
    requireThat([u.owner, u.recorder, manager(s, u)].some(b => same(b, caller)), "NOT_OWNER", "Only this unit's participants may park a gate");
    requireThat(r.attempt === u.currentAttempt, "ATTEMPT_CONFLICT", "Use the current attempt", 3);
    const existing = s.gates.find(g => g.id === r.id); const history: unknown[] = [];
    if (existing) { requireThat(existing.unit === u.id && r.ifVersion === existing.version, "VERSION_CONFLICT", "Gate version mismatch", 3); history.push(...existing.history, { ...existing, history: undefined }); }
    else version(r, u);
    const value = { id: str(r.id, "gate id"), version: (existing?.version ?? 0) + 1, unit: u.id, question: str(p.question, "question"), options: strings(p.options, "options"), recommendation: optional(p.recommendation, "recommendation"), respondent: str(p.respondent, "respondent"), state: "open" as const, answer: "", evidence: [], history, at: new Date().toISOString() };
    if (existing) Object.assign(existing, value); else s.gates.push(value); u.version++; return value;
  }
  const u = unit(s, r.id); const a = current(u); version(r, u);
  requireThat(r.attempt === u.currentAttempt, "ATTEMPT_CONFLICT", "Use the current attempt", 3);
  if (r.command === "ledger record") {
    keys(p, ["condition", "verdict", "target", "evidence", "reason", "method", "environment", "observedAt", "performer", "supersedes", "reusedFrom", "reuseReason"]);
    requireThat(isVerifier(r, u), "NOT_OWNER", "Only assigned verifiers or the recorder may record checks");
    requireThat(["running", "waiting", "paused"].includes(a.state), "INVALID_TRANSITION", "Record checks in an active attempt");
    requireThat(a.inputs, "START_REQUIRED", "Start the attempt before recording checks");
    await assertInputs(s, u);
    const condition = u.conditions.find(c => c.id === p.condition); requireThat(condition, "INVALID_INPUT", "Unknown condition");
    const t = await target(s.project, p.target); requireThat(t.id === condition.target, "INVALID_INPUT", "Target ID does not match this condition");
    const verdict = member(p.verdict, VERDICTS, "verdict"); const evidence = await captureRefs(s.project, p.evidence);
    const why = optional(p.reason, "reason");
    requireThat(["pass", "fail"].includes(verdict) ? evidence.length > 0 : why.length > 0, "EVIDENCE_REQUIRED", "Provide evidence for pass/fail or a reason for unknown/not-applicable");
    const previous = headCheck(s, u, condition.id);
    requireThat(previous ? p.supersedes === previous.id : p.supersedes === undefined, "SUPERSEDED_CHECK", "Replace exactly the current record; reread it after a conflict", 3);
    const reusedFrom = p.reusedFrom === undefined ? null : str(p.reusedFrom, "reusedFrom");
    if (reusedFrom) {
      const old = s.checks.find(c => c.id === reusedFrom);
      requireThat(old && old.unit === u.id && old.condition === condition.id && old.target.id === t.id && old.target.version === t.version && old.verdict === verdict && !s.checks.some(c => c.supersedes === old.id), "INVALID_REUSE", "Reuse requires a non-superseded record of the same unit, condition, target version and verdict");
      requireThat(await checkCurrent(s, old), "INVALID_REUSE", "Reused target and evidence must still match the recorded version");
      str(p.reuseReason, "reuseReason");
    }
    const observedAt = str(p.observedAt, "observedAt"); requireThat(Number.isFinite(Date.parse(observedAt)), "INVALID_INPUT", "observedAt must be a timestamp");
    const c: Check = { id: crypto.randomUUID(), unit: u.id, attempt: a.number, condition: condition.id, target: t, verdict, evidence, reason: why, method: str(p.method, "method"), environment: str(p.environment, "environment"), observedAt, performer: optional(p.performer, "performer", actor(r).actor), recordedBy: actor(r), supersedes: previous?.id ?? null, reusedFrom, reuseReason: optional(p.reuseReason, "reuseReason"), at: new Date().toISOString() };
    s.checks.push(c); u.version++; return c;
  }
  if (r.command === "inbox push") {
    keys(p, ["kind", "body", "refs"]); requireThat([u.owner, u.recorder].some(b => same(b, actor(r))), "NOT_OWNER", "Only the assigned worker or recorder can report");
    const m = { id: crypto.randomUUID(), unit: u.id, attempt: a.number, from: actor(r), to: manager(s, u).actor, kind: member(p.kind, ["report", "help"] as const, "kind"), body: str(p.body, "body"), refs: await captureRefs(s.project, p.refs), submission: null, state: "pending" as const, resolution: "", at: new Date().toISOString() };
    s.messages.push(m); return m;
  }
  requireThat(false, "UNKNOWN_COMMAND", `Unknown command: ${r.command}`);
}
