export const STAGES = ["intake", "investigate", "design", "plan", "implement", "verify", "review", "deliver"] as const;
export const PROGRESS = ["pending", "running", "waiting", "paused", "completed", "cancelled"] as const;
export const VERDICTS = ["pass", "fail", "unknown", "not-applicable"] as const;
export type Progress = typeof PROGRESS[number];
export type Verdict = typeof VERDICTS[number];
export type Binding = { actor: string; session: string };
export type Ref = { ref: string; digest: string | null };
export type Target = { id: string; kind: "files" | "external"; refs: Ref[]; version: string };
export type Condition = { id: string; description: string; purpose: "delivery" | "assessment"; required: boolean; allowed: Verdict[]; target: string };
export type Stage = { selection: "execute" | "integrate" | "reuse" | "omit"; reason: string; state: Progress | "not-applicable"; refs: Ref[] };
export type Dependency = { on: string; reason: string; checks: { condition: string; verdict: Verdict }[] };
export type Inputs = { contractVersion: number; contractFiles: Ref[]; dependencies: { unit: string; submission: string }[] };
export type Attempt = { number: number; state: Progress; stages: Record<string, Stage>; inputs: Inputs | null; reason: string; next: string; resumeRef: Ref | null; createdAt: string };
export type Unit = {
  id: string; parent: string | null; size: "small" | "standard" | "large"; purpose: string; track: string;
  owner: Binding; recorder: Binding; verifiers: Binding[]; scope: string[];
  taskRef: string | null; planRef: string | null; contractFiles: Ref[];
  conditions: Condition[]; dependencies: Dependency[]; exclusions: { unit: string; reason: string }[];
  version: number; contractVersion: number; attempts: Attempt[]; currentAttempt: number; currentSubmission: string | null;
  contractHistory: { version: number; snapshot: unknown; reason: string; at: string }[];
};
export type Check = {
  id: string; unit: string; attempt: number; condition: string; target: Target; verdict: Verdict;
  evidence: Ref[]; reason: string; method: string; environment: string; observedAt: string;
  performer: string; recordedBy: Binding; supersedes: string | null; reusedFrom: string | null; reuseReason: string; at: string;
};
export type Submission = {
  id: string; unit: string; attempt: number; contractVersion: number; inputs: Inputs; checks: string[];
  outputs: Target[]; report: string; refs: Ref[]; children: { unit: string; submission: string }[];
  active: boolean; obsoleteReason: string; successor: string | null; createdBy: Binding; at: string;
  acceptance: { state: "pending" | "accepted" | "changes-requested"; reason: string; actor: Binding | null; at: string | null };
};
export type Message = { id: string; unit: string; attempt: number; from: Binding; to: string; kind: "report" | "help" | "completion"; body: string; refs: Ref[]; submission: string | null; state: "pending" | "processed" | "obsolete"; resolution: string; at: string };
export type Gate = { id: string; version: number; unit: string; question: string; options: string[]; recommendation: string; respondent: string; state: "open" | "resolved"; answer: string; evidence: Ref[]; history: unknown[]; at: string };
export type State = {
  schemaVersion: 1; revision: number; project: string; coordinator: Binding; createdAt: string; updatedAt: string;
  units: Unit[]; checks: Check[]; submissions: Submission[]; messages: Message[]; gates: Gate[];
  operations: { id: string; hash: string; actor: Binding; command: string; request: Request; affectedUnits: string[]; evidence: Ref[]; revision: number; data: unknown; at: string }[];
};
export type Request = {
  command: string; id?: string; stage?: string; actor?: string; session?: string; operationId?: string;
  ifVersion?: number; attempt?: number; input?: Record<string, unknown>;
};
export type Result = { revision: number; data: unknown; replayed?: boolean };
export class OrchError extends Error {
  constructor(public code: string, message: string, public exitCode = 2) { super(message); }
}
export function requireThat(value: unknown, code: string, message: string, exitCode = 2): asserts value {
  if (!value) throw new OrchError(code, message, exitCode);
}
export function current(unit: Unit): Attempt {
  const attempt = unit.attempts.find(a => a.number === unit.currentAttempt);
  requireThat(attempt, "CORRUPT_STATE", `Missing attempt for ${unit.id}`);
  return attempt;
}
