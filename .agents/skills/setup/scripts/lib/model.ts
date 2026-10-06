export type Mode = "copy" | "managed-block" | "merge-index" | "seed";
export const instructionFiles = { codex: "AGENTS.md", "claude-code": "CLAUDE.md", copilot: ".github/copilot-instructions.md" } as const;
export type Product = keyof typeof instructionFiles;
export function setupPlugins(plugin: string): string[] { return plugin === "koto" ? ["koto", "agent-gear"] : [plugin]; }
export function isProduct(value: unknown): value is Product { return typeof value === "string" && Object.hasOwn(instructionFiles, value); }
export interface Entry { source: string; destination: string; mode: Mode }
export interface Manifest { schemaVersion: 1; plugin: string; product: Product; version: string; files: Entry[] }
export interface Installed extends Entry { hash: string; indexSource?: string }
export interface State { schemaVersion: 1; plugin: string; product: Product; version: string; entries: Installed[] }
export interface Operation { destination: string; beforeHash: string | null; content: string }
export interface Pending { schemaVersion: 1; manifestHash: string; beforeStateHash: string | null; nextState: State; operations: Operation[] }
export interface Action { destination: string; mode: Mode; action: "create" | "update" | "unchanged" | "retain"; reason: string }
export interface Conflict { destination: string; reason: string }
export interface Result { plugin: string; product: Product; version: string; project: string; actions: Action[]; conflicts: Conflict[]; pending: boolean; locked: boolean }
export class SetupError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
