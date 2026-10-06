import { current, requireThat, STAGES, VERDICTS, type State, type Unit, type Request, type Condition, type Stage, type Submission } from "./model.ts";
import { array, binding, bool, captureRefs, id, keys, member, object, optional, same, stable, str, strings } from "./validation.ts";
import { acceptedSubmission, actor, assertInputs, assertNoCycles, authenticate, changeContract, checkCurrent, headCheck, manager, reason, rotate, startRequirements, submissionValid, unit, version, worker } from "./policy.ts";

function conditions(value: unknown): Condition[] {
  const result = array(value, "conditions").map(v => {
    const o = object(v); keys(o, ["id", "description", "purpose", "required", "allowed", "target"]);
    const allowed = array(o.allowed ?? ["pass"], "allowed").map(v => member(v, VERDICTS, "verdict"));
    requireThat(allowed.length > 0, "INVALID_INPUT", "At least one allowed verdict is required");
    return { id: id(o.id), description: str(o.description, "condition.description"), purpose: member(o.purpose, ["delivery", "assessment"] as const, "condition.purpose"), required: bool(o.required, "condition.required"), allowed, target: id(o.target) };
  });
  requireThat(result.some(c => c.required) && new Set(result.map(c => c.id)).size === result.length, "INVALID_INPUT", "Unique conditions and a required completion condition are needed");
  return result;
}
async function stageValue(s: State, value: unknown): Promise<Stage> {
  const o = object(value); keys(o, ["selection", "reason", "state", "refs"]);
  const selection = member(o.selection, ["execute", "integrate", "reuse", "omit"] as const, "selection");
  const state = member(o.state ?? (selection === "omit" ? "not-applicable" : "pending"), ["pending", "running", "waiting", "paused", "completed", "cancelled", "not-applicable"] as const, "stage state");
  requireThat((selection === "omit") === (state === "not-applicable"), "INVALID_INPUT", "Only omitted stages use not-applicable");
  return { selection, reason: str(o.reason, "stage.reason"), state, refs: await captureRefs(s.project, o.refs) };
}
async function documents(s: State, size: Unit["size"], taskRef: string | null, planRef: string | null) {
  requireThat(size === "small" || taskRef, "DOCUMENT_REQUIRED", "Standard/large units require an existing task.md reference");
  requireThat(size !== "large" || planRef, "DOCUMENT_REQUIRED", "Large units require an existing plan.md reference");
  await captureRefs(s.project, [taskRef, planRef].filter((v): v is string => v !== null));
}

export async function mutateUnit(s: State, r: Request): Promise<unknown> {
  const p = r.input ?? {};
  if (r.command === "unit add") {
    keys(p, ["parent", "size", "purpose", "track", "owner", "recorder", "verifiers", "scope", "taskRef", "planRef", "contractFiles", "conditions", "stages"]);
    const unitId = id(r.id); requireThat(!s.units.some(u => u.id === unitId), "ALREADY_EXISTS", `Unit exists: ${unitId}`);
    const parent = p.parent === undefined ? null : unit(s, str(p.parent, "parent"));
    authenticate(r, parent?.owner ?? s.coordinator);
    if (parent) requireThat(!["completed", "cancelled"].includes(current(parent).state), "REOPEN_PARENT", "Reopen parent before adding work");
    const owner = binding(p.owner); const size = member(p.size, ["small", "standard", "large"] as const, "size");
    const taskRef = p.taskRef === undefined ? null : str(p.taskRef, "taskRef"), planRef = p.planRef === undefined ? null : str(p.planRef, "planRef");
    await documents(s, size, taskRef, planRef);
    const stages: Record<string, Stage> = {};
    for (const [name, spec] of Object.entries(object(p.stages ?? {}))) { member(name, STAGES, "stage"); stages[name] = await stageValue(s, spec); }
    const u: Unit = { id: unitId, parent: parent?.id ?? null, size, purpose: str(p.purpose, "purpose"), track: optional(p.track, "track"), owner, recorder: p.recorder ? binding(p.recorder) : owner, verifiers: array(p.verifiers ?? [], "verifiers").map(binding), scope: strings(p.scope, "scope"), taskRef, planRef, contractFiles: await captureRefs(s.project, p.contractFiles), conditions: conditions(p.conditions), dependencies: [], exclusions: [], version: 1, contractVersion: 1, attempts: [{ number: 1, state: "pending", stages, inputs: null, reason: "", next: "", resumeRef: null, createdAt: new Date().toISOString() }], currentAttempt: 1, currentSubmission: null, contractHistory: [] };
    requireThat(u.scope.length, "INVALID_INPUT", "scope cannot be empty"); s.units.push(u); assertNoCycles(s); return u;
  }
  const u = unit(s, r.id); const a = current(u);
  if (r.command === "unit assign") {
    keys(p, ["owner", "recorder", "verifiers", "coordinator", "handoff", "reason"]);
    version(r, u);
    if (p.coordinator !== undefined) {
      const next = binding(p.coordinator); const caller = actor(r);
      requireThat(u.parent === null && next.actor === s.coordinator.actor && same(next, caller), "NOT_OWNER", "Coordinator recovery must retain the root coordinator role");
      requireThat(p.handoff, "HANDOFF_REQUIRED", "Recovery requires old session, stoppedRef, and authorityRef");
      const handoff = object(p.handoff); keys(handoff, ["previousSession", "stoppedRef", "authorityRef"]);
      requireThat(handoff.previousSession === s.coordinator.session && next.session !== s.coordinator.session, "SESSION_MISMATCH", "Coordinator session changed", 3);
      await captureRefs(s.project, [str(handoff.stoppedRef, "stoppedRef"), str(handoff.authorityRef, "authorityRef")]);
      requireThat(p.owner === undefined && p.recorder === undefined && p.verifiers === undefined, "INVALID_INPUT", "Recovery only transfers the coordinator session");
      const previous = s.coordinator; s.coordinator = next;
      const why = reason(p);
      for (const affected of s.units) {
        const ownsWork = same(affected.owner, previous) || same(affected.recorder, previous);
        const verifies = affected.verifiers.some(b => same(b, previous));
        if (same(affected.owner, previous)) affected.owner = next;
        if (same(affected.recorder, previous)) affected.recorder = next;
        affected.verifiers = affected.verifiers.map(b => same(b, previous) ? next : b);
        if (ownsWork) rotate(s, affected, why);
        if (affected.id !== u.id && (ownsWork || verifies)) affected.version++;
      }
    } else {
      authenticate(r, manager(s, u)); requireThat(a.state !== "running", "STOP_REQUIRED", "Pause before changing assignments");
      requireThat(p.owner !== undefined || p.recorder !== undefined || p.verifiers !== undefined, "INVALID_INPUT", "Assignment is empty");
      const handoff = object(p.handoff); keys(handoff, ["stoppedRef"]); await captureRefs(s.project, [str(handoff.stoppedRef, "handoff.stoppedRef")]);
      if (p.owner) u.owner = binding(p.owner);
      if (p.recorder) u.recorder = binding(p.recorder);
      else if (p.owner) u.recorder = u.owner;
      if (p.verifiers) u.verifiers = array(p.verifiers, "verifiers").map(binding);
      rotate(s, u, reason(p));
    }
  } else if (r.command === "unit update") {
    keys(p, ["purpose", "scope", "track", "size", "taskRef", "planRef", "contractFiles", "conditions", "exclusions", "reason"]);
    authenticate(r, manager(s, u)); version(r, u); changeContract(s, u, reason(p));
    if (p.purpose !== undefined) u.purpose = str(p.purpose, "purpose");
    if (p.scope !== undefined) { u.scope = strings(p.scope, "scope"); requireThat(u.scope.length, "INVALID_INPUT", "scope cannot be empty"); }
    if (p.track !== undefined) u.track = str(p.track, "track");
    if (p.size !== undefined) u.size = member(p.size, ["small", "standard", "large"] as const, "size");
    if (p.taskRef !== undefined) u.taskRef = str(p.taskRef, "taskRef");
    if (p.planRef !== undefined) u.planRef = str(p.planRef, "planRef");
    if (p.contractFiles !== undefined) u.contractFiles = await captureRefs(s.project, p.contractFiles);
    if (p.conditions !== undefined) u.conditions = conditions(p.conditions);
    if (p.exclusions !== undefined) u.exclusions = array(p.exclusions, "exclusions").map(v => { const e = object(v); keys(e, ["unit", "reason"]); const child = unit(s, str(e.unit, "exclusion.unit")); requireThat(child.parent === u.id && current(child).state === "cancelled", "INVALID_INPUT", "Only cancelled direct children can be excluded"); return { unit: child.id, reason: reason(e) }; });
    await documents(s, u.size, u.taskRef, u.planRef); assertNoCycles(s);
  } else if (r.command.startsWith("dependency ")) {
    keys(p, ["on", "reason", "checks"]); authenticate(r, manager(s, u)); version(r, u);
    const upstream = unit(s, str(p.on, "on")); changeContract(s, u, reason(p));
    if (r.command === "dependency add") {
      requireThat(!u.dependencies.some(d => d.on === upstream.id), "ALREADY_EXISTS", "Dependency exists");
      const checks = array(p.checks ?? [], "checks").map(v => { const o = object(v); keys(o, ["condition", "verdict"]); const condition = str(o.condition, "condition"); requireThat(upstream.conditions.some(c => c.id === condition), "INVALID_INPUT", "Unknown upstream condition"); return { condition, verdict: member(o.verdict, VERDICTS, "verdict") }; });
      u.dependencies.push({ on: upstream.id, reason: reason(p), checks });
    } else { requireThat(u.dependencies.some(d => d.on === upstream.id), "NOT_FOUND", "Dependency not found"); u.dependencies = u.dependencies.filter(d => d.on !== upstream.id); }
    assertNoCycles(s);
  } else if (r.command === "unit accept" || r.command === "unit return") {
    keys(p, ["submission", "reason"]); authenticate(r, manager(s, u)); version(r, u);
    const sub = s.submissions.find(sub => sub.id === p.submission && sub.unit === u.id);
    requireThat(sub && sub.active && sub.id === u.currentSubmission && sub.attempt === u.currentAttempt && a.state === "completed", "STALE_SUBMISSION", "Only the current completed submission can be decided");
    requireThat(sub.acceptance.state === "pending", "ALREADY_DECIDED", "This submission already has a decision");
    if (r.command === "unit accept") requireThat(await submissionValid(s, sub), "STALE_SUBMISSION", "Submission inputs, outputs or evidence changed");
    sub.acceptance = { state: r.command === "unit accept" ? "accepted" : "changes-requested", actor: actor(r), reason: reason(p), at: new Date().toISOString() };
    for (const m of s.messages.filter(m => m.submission === sub.id && m.state === "pending")) { m.state = "processed"; m.resolution = `${sub.acceptance.state}: ${sub.acceptance.reason}`; }
    u.version++; return sub;
  } else {
    worker(r, u);
    if (r.command === "unit start") {
      keys(p, ["resumeRef"]); requireThat(["pending", "waiting", "paused"].includes(a.state), "INVALID_TRANSITION", "Unit is not startable");
      const inputs = await startRequirements(s, u);
      if (a.state === "waiting" && a.reason) { const refs = await captureRefs(s.project, [str(p.resumeRef, "resumeRef")]); a.resumeRef = refs[0]!; }
      if (a.inputs === null) a.inputs = inputs;
      a.state = "running"; a.next = "";
    } else if (r.command === "unit set") {
      keys(p, ["state", "reason", "next"]); requireThat(!["completed", "cancelled"].includes(a.state), "INVALID_TRANSITION", "Reopen finished work first");
      a.state = member(p.state, ["waiting", "paused", "cancelled"] as const, "state"); a.reason = reason(p); a.next = optional(p.next, "next");
    } else if (r.command === "unit stage") {
      requireThat(!["completed", "cancelled"].includes(a.state), "INVALID_TRANSITION", "Reopen finished work first");
      const name = member(r.stage, STAGES, "stage"); const stage = await stageValue(s, p);
      requireThat(stage.state !== "completed" || a.state === "running", "INVALID_TRANSITION", "Start before completing a stage"); a.stages[name] = stage;
    } else if (r.command === "unit reopen") {
      keys(p, ["reason", "scopeRef"]); requireThat(["completed", "paused", "cancelled", "waiting"].includes(a.state), "INVALID_TRANSITION", "Pause active work before reopening");
      if (a.state === "cancelled") await captureRefs(s.project, [str(p.scopeRef, "scopeRef")]); rotate(s, u, reason(p));
    } else if (r.command === "unit submit") {
      keys(p, ["checks", "report", "refs"]); requireThat(a.state === "running", "INVALID_TRANSITION", "Only running work can be submitted");
      await startRequirements(s, u); const inputs = await assertInputs(s, u);
      requireThat(Object.values(a.stages).every(t => t.selection === "omit" || t.state === "completed"), "STAGES_INCOMPLETE", "Finish the selected stages");
      const checkIds = strings(p.checks, "checks"); requireThat(new Set(checkIds).size === checkIds.length, "INVALID_INPUT", "Duplicate check ID");
      const selected = checkIds.map(id => { const c = s.checks.find(c => c.id === id); requireThat(c && c.unit === u.id && c.attempt === u.currentAttempt, "STALE_CHECK", "Check belongs to another unit/attempt"); requireThat(headCheck(s, u, c.condition)?.id === c.id, "SUPERSEDED_CHECK", "A newer check supersedes this record"); return c; });
      for (const c of selected) requireThat(await checkCurrent(s, c), "ARTIFACT_CHANGED", "Target or evidence changed after verification");
      const targets = new Map<string, string>();
      for (const c of selected) {
        const snapshot = stable(c.target), previous = targets.get(c.target.id);
        requireThat(previous === undefined || previous === snapshot, "TARGET_VERSION_CONFLICT", `Checks disagree about target ${c.target.id}; recheck against one version`);
        targets.set(c.target.id, snapshot);
      }
      for (const c of u.conditions) {
        const selectedCheck = selected.find(k => k.condition === c.id);
        if (c.required) requireThat(selectedCheck && c.allowed.includes(selectedCheck.verdict), "CONDITIONS_UNMET", `Completion condition is unmet: ${c.id}`);
        if (headCheck(s, u, c.id)) requireThat(selectedCheck, "CHECK_OMITTED", `Include the current assessment: ${c.id}`);
      }
      const children = [];
      for (const child of s.units.filter(c => c.parent === u.id && !u.exclusions.some(e => e.unit === c.id))) children.push({ unit: child.id, submission: (await acceptedSubmission(s, child.id)).id });
      const sub: Submission = { id: crypto.randomUUID(), unit: u.id, attempt: u.currentAttempt, contractVersion: u.contractVersion, inputs, checks: checkIds, outputs: selected.map(c => structuredClone(c.target)), report: str(p.report, "report"), refs: await captureRefs(s.project, p.refs), children, active: true, obsoleteReason: "", successor: null, createdBy: actor(r), at: new Date().toISOString(), acceptance: { state: "pending", reason: "", actor: null, at: null } };
      for (const old of s.submissions.filter(t => t.unit === u.id && !t.active && t.successor === null)) old.successor = sub.id;
      s.submissions.push(sub); u.currentSubmission = sub.id; a.state = "completed"; u.version++;
      s.messages.push({ id: crypto.randomUUID(), unit: u.id, attempt: u.currentAttempt, from: actor(r), to: manager(s, u).actor, kind: "completion", body: sub.report, refs: sub.refs, submission: sub.id, state: "pending", resolution: "", at: sub.at });
      return sub;
    } else requireThat(false, "UNKNOWN_COMMAND", `Unknown command: ${r.command}`);
  }
  u.version++; return u;
}
