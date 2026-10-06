import type { Entry, Manifest, State, Pending } from "./model.ts";
import { instructionFiles, isProduct, setupPlugins, SetupError } from "./model.ts";
import { relativePath } from "./files.ts";

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupError("INVALID_DATA", "Expected object"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new SetupError("INVALID_DATA", `Unknown field: ${key}`); }
function text(value: unknown): string { if (typeof value !== "string" || !value.trim()) throw new SetupError("INVALID_DATA", "Expected nonempty text"); return value; }
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new SetupError("INVALID_DATA", "Invalid hash"); return value; }
export function allowedEntry(value: unknown, manifest: Pick<Manifest, "plugin" | "product">, installed = false): Entry {
  const entry = object(value); exact(entry, installed ? ["source", "destination", "mode", "hash", "indexSource"] : ["source", "destination", "mode"]);
  const source = relativePath(entry.source), destination = relativePath(entry.destination);
  if (!["copy", "managed-block", "merge-index", "seed"].includes(String(entry.mode))) throw new SetupError("INVALID_DATA", "Invalid entry mode");
  const index = /^\.space\/babel\/(?:(?:rules|principles|knowledge|procedures|decisions)\/(?:[^/]+\/)*)?index\.md$/.test(destination);
  const document = /^\.space\/babel\/(rules|principles|knowledge|procedures|decisions)\/.+\.md$/.test(destination) && !/\/(index|log)\.md$/.test(destination);
  const allowed = entry.mode === "managed-block" ? destination === instructionFiles[manifest.product]
    : entry.mode === "merge-index" ? index
    : entry.mode === "seed" ? [".space/babel/log.md", ".space/babel/LICENSE"].includes(destination)
    : document || (installed ? setupPlugins(manifest.plugin) : [manifest.plugin]).some(plugin => destination.startsWith(`.space/babel/vendor/${plugin}/`)) || manifest.product === "codex" && destination.startsWith(".codex/agents/");
  if (!allowed) throw new SetupError("DESTINATION", `Destination is outside allowed locations: ${destination}`);
  if (entry.indexSource !== undefined && (entry.mode !== "merge-index" || typeof entry.indexSource !== "string")) throw new SetupError("INVALID_DATA", "Invalid index source baseline");
  return { source, destination, mode: entry.mode as Entry["mode"] };
}
function identity(value: Record<string, unknown>) {
  if (value.schemaVersion !== 1 || typeof value.plugin !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.plugin) || !isProduct(value.product)) throw new SetupError("INVALID_DATA", "Invalid schema, plugin, or product");
  text(value.version);
}
function noDuplicates(entries: Entry[]) {
  const paths = entries.map(e => e.destination.toLocaleLowerCase("en-US"));
  if (new Set(paths).size !== paths.length || paths.some(path => paths.some(other => path !== other && other.startsWith(path + "/")))) throw new SetupError("INVALID_DATA", "Duplicate or overlapping destination");
}
export function parseManifest(value: unknown): Manifest {
  const m = object(value); exact(m, ["schemaVersion", "plugin", "product", "version", "files"]); identity(m);
  if (!Array.isArray(m.files)) throw new SetupError("INVALID_DATA", "files must be an array");
  const manifest = m as unknown as Manifest; manifest.files = m.files.map(e => allowedEntry(e, manifest)); noDuplicates(manifest.files); return manifest;
}
export function parseState(value: unknown, manifest: Manifest): State {
  const s = object(value); exact(s, ["schemaVersion", "plugin", "product", "version", "entries"]); identity(s);
  if (s.plugin !== manifest.plugin || s.product !== manifest.product || !Array.isArray(s.entries)) throw new SetupError("INVALID_DATA", "State identity mismatch");
  const state = s as unknown as State;
  state.entries = s.entries.map(value => { const entry = allowedEntry(value, manifest, true), raw = object(value); return { ...entry, hash: digest(raw.hash), ...(typeof raw.indexSource === "string" ? { indexSource: raw.indexSource } : {}) }; });
  noDuplicates(state.entries); return state;
}
export function parsePending(value: unknown, manifest: Manifest): Pending {
  const p = object(value); exact(p, ["schemaVersion", "manifestHash", "beforeStateHash", "nextState", "operations"]);
  if (p.schemaVersion !== 1 || !Array.isArray(p.operations)) throw new SetupError("INVALID_DATA", "Invalid pending transaction");
  digest(p.manifestHash); if (p.beforeStateHash !== null) digest(p.beforeStateHash);
  const state = parseState(p.nextState, manifest);
  for (const value of p.operations) {
    const op = object(value); exact(op, ["destination", "beforeHash", "content"]); relativePath(op.destination);
    if (!state.entries.some(e => e.destination === op.destination)) throw new SetupError("INVALID_DATA", "Pending destination is not managed");
    if (op.beforeHash !== null) digest(op.beforeHash);
    if (typeof op.content !== "string" || Buffer.from(op.content, "base64").toString("base64") !== op.content) throw new SetupError("INVALID_DATA", "Invalid pending content");
  }
  if (new Set(p.operations.map(value => object(value).destination)).size !== p.operations.length) throw new SetupError("INVALID_DATA", "Duplicate pending destination");
  return { ...(p as unknown as Pending), nextState: state };
}
