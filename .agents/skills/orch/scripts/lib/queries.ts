import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { current, PROGRESS, requireThat, type Request, type State, type Unit } from "./model.ts";
import { assertInputs, checkCurrent, headCheck, startRequirements, submissionValid, unit } from "./policy.ts";
import { bool, captureRefs, keys, member, refsCurrent, str } from "./validation.ts";

function scope(s: State, input: Record<string, unknown>): Unit[] {
  let units = s.units;
  if (input.parent !== undefined) { unit(s, String(input.parent)); const descendants = new Set<string>([String(input.parent)]); let changed = true; while (changed) { changed = false; for (const u of units) if (u.parent && descendants.has(u.parent) && !descendants.has(u.id)) { descendants.add(u.id); changed = true; } } units = units.filter(u => descendants.has(u.id)); }
  return units.filter(u => (input.state === undefined || current(u).state === input.state) && (input.owner === undefined || u.owner.actor === input.owner) && (input.track === undefined || u.track === input.track));
}
async function checks(s: State, u: Unit) {
  let inputsCurrent = current(u).inputs !== null;
  try { await assertInputs(s, u); } catch { inputsCurrent = false; }
  return Promise.all(u.conditions.map(async condition => { const c = headCheck(s, u, condition.id); const valid = c && inputsCurrent ? await checkCurrent(s, c) : false; return { condition: condition.id, target: condition.target, recordId: c?.id ?? null, verdict: valid ? c!.verdict : "unknown", recordedVerdict: c?.verdict ?? null, stale: c !== undefined && !valid }; }));
}
async function unitStatus(s: State, u: Unit) {
    const submission = s.submissions.find(t => t.id === u.currentSubmission);
    const valid = submission ? await submissionValid(s, submission) : false;
    let blocked: string | null = null;
    try { await startRequirements(s, u); } catch (error) { blocked = error instanceof Error ? error.message : String(error); }
    return { id: u.id, parent: u.parent, size: u.size, owner: u.owner.actor, attempt: u.currentAttempt, state: current(u).state, acceptance: submission?.acceptance.state ?? "pending", acceptanceValid: valid && submission?.acceptance.state === "accepted", submission: submission?.id ?? null, blocked, conditions: await checks(s, u) };
}
export async function status(s: State, p: Record<string, unknown> = {}) {
  const units = await Promise.all(scope(s, p).map(u => unitStatus(s, u)));
  return { units, gates: s.gates.filter(g => g.state === "open" && units.some(u => u.id === g.unit)), inbox: s.messages.filter(m => m.state === "pending" && units.some(u => u.id === m.unit)) };
}
export async function query(s: State, r: Request): Promise<unknown> {
  const p = r.input ?? {};
  if (p.history !== undefined) bool(p.history, "history");
  for (const key of ["parent", "owner", "track", "recipient"]) if (p[key] !== undefined) str(p[key], key);
  if (p.state !== undefined) member(p.state, PROGRESS, "state");
  switch (r.command) {
    case "unit get": { keys(p, ["history"]); const u = unit(s, r.id); const view = await unitStatus(s, u); return p.history ? { unit: u, status: view, checks: s.checks.filter(c => c.unit === u.id), submissions: s.submissions.filter(t => t.unit === u.id), messages: s.messages.filter(m => m.unit === u.id), operations: s.operations.filter(o => o.affectedUnits.includes(u.id)) } : { ...u, status: view }; }
    case "unit list": keys(p, ["parent", "state", "owner", "track"]); return scope(s, p);
    case "unit counts": { keys(p, ["parent", "state", "owner", "track"]); const data = await status(s, p); const states: Record<string, number> = {}; for (const u of data.units) states[u.state] = (states[u.state] ?? 0) + 1; return { total: data.units.length, states, accepted: data.units.filter(u => u.acceptanceValid).length }; }
    case "unit ready": { keys(p, ["parent", "state", "owner", "track"]); const data = await status(s, p); return data.units.map(u => { const a = current(unit(s, u.id)); return { ...u, ready: ["pending", "waiting"].includes(a.state) && !u.blocked && !(a.state === "waiting" && a.reason), manualResumeRequired: a.state === "waiting" && Boolean(a.reason) }; }); }
    case "ledger check": keys(p, []); return { unit: r.id, attempt: unit(s, r.id).currentAttempt, conditions: await checks(s, unit(s, r.id)) };
    case "ledger summary": { keys(p, ["history"]); if (p.history) return s.checks; return Promise.all(s.units.map(async u => ({ unit: u.id, attempt: u.currentAttempt, conditions: await checks(s, u) }))); }
    case "inbox list": keys(p, ["recipient", "history"]); return s.messages.filter(m => (p.history || m.state === "pending") && (p.recipient === undefined || m.to === p.recipient));
    case "gate list": keys(p, ["history"]); return s.gates.filter(g => p.history || g.state === "open");
    case "status": keys(p, ["parent", "state", "owner", "track"]); return status(s, p);
    case "doctor": {
      keys(p, []); const problems: string[] = [];
      for (const u of s.units) {
        try { await captureRefs(s.project, [u.taskRef, u.planRef].filter((x): x is string => Boolean(x))); } catch (e) { problems.push(`${u.id}: ${e instanceof Error ? e.message : e}`); }
        if (!await refsCurrent(s.project, u.contractFiles)) problems.push(`${u.id}: contract files changed`);
        for (const condition of u.conditions) {
          const c = headCheck(s, u, condition.id);
          if (c && !await checkCurrent(s, c)) problems.push(`${u.id}: target or evidence changed/missing for ${condition.id} (${c.id})`);
        }
        const sub = s.submissions.find(t => t.id === u.currentSubmission);
        if (sub && !await refsCurrent(s.project, sub.refs)) problems.push(`${u.id}: submission references changed/missing`);
      }
      return { schemaVersion: s.schemaVersion, revision: s.revision, problems };
    }
    default: requireThat(false, "UNKNOWN_COMMAND", `Unknown query: ${r.command}`);
  }
}
function cell(value: unknown): string { return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n"); }
export async function exportState(store: string, s: State): Promise<{ directory: string; revision: number }> {
  const directory = join(store, "exports", String(s.revision)); const temporary = join(store, "exports", `.tmp-${crypto.randomUUID()}`);
  const summary = await status(s);
  const header = ["revision", "updated_at", "id", "parent", "owner", "attempt", "state", "acceptance", "acceptance_valid"];
  const rows = summary.units.map(u => [s.revision, s.updatedAt, u.id, u.parent, u.owner, u.attempt, u.state, u.acceptance, u.acceptanceValid]);
  const ledger = s.checks.map(c => [s.revision, s.updatedAt, c.id, c.unit, c.attempt, c.condition, c.target.id, c.target.version, c.verdict, c.supersedes ?? "", c.evidence.map(r => r.ref).join("; ")]);
  const files: Record<string, string> = {
    "units.tsv": [header, ...rows].map(row => row.map(cell).join("\t")).join("\n") + "\n",
    "ledger.tsv": [["revision", "updated_at", "id", "unit", "attempt", "condition", "target", "target_version", "verdict", "supersedes", "evidence"], ...ledger].map(row => row.map(cell).join("\t")).join("\n") + "\n",
    "status.md": `# 作業状況\n\n台帳revision: ${s.revision} / 更新時点: ${s.updatedAt}\n\n` + summary.units.map(u => `- ${cell(u.id)}: ${u.state}; 受け入れ=${u.acceptance}; 現在有効=${u.acceptanceValid}; ${u.conditions.map(c => `${c.condition}=${c.verdict}`).join(", ")}${u.blocked ? `; 前提=${cell(u.blocked)}` : ""}`).join("\n") + `\n\n未解決の判断: ${summary.gates.map(g => cell(g.id)).join(", ") || "なし"}\n未処理の報告: ${summary.inbox.length}\n`,
  };
  try {
    const existing = await Promise.all(Object.keys(files).map(name => readFile(join(directory, name), "utf8")));
    requireThat(existing.every((value,i) => value === files[Object.keys(files)[i]!]), "EXPORT_CONFLICT", "Existing export differs; it was not overwritten"); return { directory, revision: s.revision };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(temporary, { recursive: true });
  try { for (const [name, value] of Object.entries(files)) await writeFile(join(temporary, name), value, { flag: "wx" }); await rename(temporary, directory); }
  finally { await rm(temporary, { recursive: true, force: true }); }
  return { directory, revision: s.revision };
}
