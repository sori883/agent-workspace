import { lstat, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Manifest, State, Pending, Result, Entry, Operation, Product } from "./model.ts";
import { instructionFiles, isProduct, setupPlugins, SetupError } from "./model.ts";
import { atomicWrite, hash, jsonBytes, readOptional, safeMkdir, safePath } from "./files.ts";
import { parseManifest, parsePending, parseState } from "./validation.ts";
import { mergeIndex } from "./index.ts";

interface Context { project: string; pluginRoot: string; skillRoot: string; manifest: Manifest; manifestHash: string; statePath: string; pendingPath: string; lockPaths: string[] }
const digest = (value: Buffer | null) => value === null ? null : hash(value);
function markers(m: Manifest) {
  const prefix = m.plugin === "agent-gear" ? "agent-gear" : "koto";
  return { start: `<!-- ${prefix}:setup:${m.plugin}:${m.product}:start -->`, end: `<!-- ${prefix}:setup:${m.plugin}:${m.product}:end -->` };
}
function block(content: Buffer | null, m: Manifest): { value: string | null; from: number; to: number } {
  const text = content?.toString("utf8") ?? "";
  if (content && !Buffer.from(text).equals(content)) throw new SetupError("BLOCK_CONFLICT", "Instruction file must be valid UTF-8");
  let found: { value: string | null; from: number; to: number } = { value: null, from: -1, to: -1 };
  for (const plugin of setupPlugins(m.plugin)) {
    const { start, end } = markers({ ...m, plugin });
    const from = text.indexOf(start), ending = text.indexOf(end);
    if (from < 0 && ending < 0) continue;
    if (found.value !== null || from < 0 || ending < from || text.indexOf(start, from + 1) >= 0 || text.indexOf(end, ending + 1) >= 0) throw new SetupError("BLOCK_CONFLICT", "Managed block markers are incomplete or duplicated");
    const to = ending + end.length; found = { value: text.slice(from, to), from, to };
  }
  return found;
}
function managedHash(content: Buffer | null, entry: Entry, manifest: Manifest): string | null {
  if (entry.mode !== "managed-block") return digest(content);
  const value = block(content, manifest).value; return value === null ? null : hash(value);
}
async function context(project: string, pluginRoot: string, product?: Product, skillRoot = join(pluginRoot, "skills")): Promise<Context> {
  if (product !== undefined && !isProduct(product)) throw new SetupError("INPUT", "Unknown product");
  project = await realpath(project); pluginRoot = await realpath(pluginRoot);
  if (!(await lstat(project)).isDirectory() || !(await lstat(pluginRoot)).isDirectory()) throw new SetupError("INVALID_DIRECTORY", "Project and plugin root must be directories");
  let raw = await readOptional(pluginRoot, "setup-manifest.json"); if (!raw) throw new SetupError("MANIFEST", "setup-manifest.json is missing from the plugin root");
  let manifest = parseManifest(JSON.parse(raw.toString()));
  if (product !== undefined && product !== manifest.product) {
    const selected = await readOptional(pluginRoot, `setup-manifest.${product}.json`);
    if (!selected) throw new SetupError("MANIFEST", `This plugin does not include setup for ${product}`);
    const alternate = parseManifest(JSON.parse(selected.toString()));
    if (alternate.product !== product || alternate.plugin !== manifest.plugin || alternate.version !== manifest.version) throw new SetupError("MANIFEST", "Selected setup manifest does not match the requested product, plugin, and version");
    raw = selected; manifest = alternate;
  }
  const base = `.space/setup/${manifest.plugin}-${manifest.product}`;
  return { project, pluginRoot, skillRoot, manifest, manifestHash: hash(raw), statePath: `${base}.json`, pendingPath: `${base}.pending.json`, lockPaths: setupPlugins(manifest.plugin).map(plugin => `.space/setup/${plugin}.lock`) };
}
async function installedState(project: string, manifest: Manifest): Promise<State> {
  for (const plugin of setupPlugins(manifest.plugin)) {
    const raw = await readOptional(project, `.space/setup/${plugin}-${manifest.product}.json`);
    if (raw) return { ...parseState(JSON.parse(raw.toString()), { ...manifest, plugin }), plugin: manifest.plugin };
  }
  return { schemaVersion: 1, plugin: manifest.plugin, product: manifest.product, version: manifest.version, entries: [] };
}
async function plan(ctx: Context): Promise<{ result: Result; pending: Pending; stateBytes: Buffer | null }> {
  const { manifest: m, project, pluginRoot } = ctx;
  const stateBytes = await readOptional(project, ctx.statePath);
  const state = await installedState(project, m);
  const result: Result = { plugin: m.plugin, product: m.product, version: m.version, project, actions: [], conflicts: [], pending: false, locked: (await Promise.all(ctx.lockPaths.map(path => readOptional(project, path)))).some(raw => raw !== null) };
  for (const plugin of setupPlugins(m.plugin).slice(1)) for (const product of Object.keys(instructionFiles) as Product[]) {
    const path = `.space/setup/${plugin}-${product}.pending.json`;
    if (await readOptional(project, path)) {
      result.pending = true;
      result.conflicts.push({ destination: path, reason: "Finish the pending transaction with its original plugin name and version before updating" });
    }
  }
  const pendingBytes = await readOptional(project, ctx.pendingPath);
  if (pendingBytes) {
    const pending = parsePending(JSON.parse(pendingBytes.toString()), m); result.pending = true;
    if (pending.manifestHash !== ctx.manifestHash) result.conflicts.push({ destination: ctx.pendingPath, reason: "Finish the pending transaction with its original plugin version before updating" });
    if (![pending.beforeStateHash, hash(jsonBytes(pending.nextState))].includes(digest(stateBytes))) result.conflicts.push({ destination: ctx.statePath, reason: "State changed during pending transaction" });
    for (const op of pending.operations) {
      const current = await readOptional(project, op.destination), after = Buffer.from(op.content, "base64"), entry = pending.nextState.entries.find(e => e.destination === op.destination)!;
      if (managedHash(after, entry, m) !== entry.hash) throw new SetupError("INVALID_DATA", "Pending content does not match managed state");
      if (![op.beforeHash, hash(after)].includes(digest(current))) result.conflicts.push({ destination: op.destination, reason: "File changed after an interrupted apply" });
      result.actions.push({ destination: op.destination, mode: entry.mode, action: digest(current) === hash(after) ? "unchanged" : current === null ? "create" : "update", reason: "Resume pending transaction" });
    }
    return { result, pending, stateBytes };
  }
  const nextState: State = { ...state, version: m.version, entries: [] }, operations: Operation[] = [];
  let legacyStates: State[] | undefined;
  for (const entry of m.files) {
    const source = await readOptional(pluginRoot, entry.source); if (!source) throw new SetupError("SOURCE", `Missing source: ${entry.source}`);
    const current = await readOptional(project, entry.destination), previous = state.entries.find(e => e.destination === entry.destination);
    let currentManaged: string | null;
    try { currentManaged = managedHash(current, entry, m); }
    catch (error) { if (!(error instanceof SetupError) || error.code !== "BLOCK_CONFLICT") throw error; result.conflicts.push({ destination: entry.destination, reason: error.message }); continue; }
    let desired = source, desiredManaged: string;
    if (entry.mode === "managed-block") {
      const text = source.toString("utf8").replaceAll("{{SKILL_ROOT}}", ctx.skillRoot).replaceAll("{{BABEL_BUNDLE}}", join(project, ".space/babel")).replaceAll("{{VENDOR_BUNDLE}}", join(project, ".space/babel/vendor", m.plugin));
      const { start, end } = markers(m);
      if (setupPlugins(m.plugin).some(plugin => { const pair = markers({ ...m, plugin }); return text.includes(pair.start) || text.includes(pair.end); })) throw new SetupError("SOURCE", "Template contains managed block markers");
      const managed = `${start}\n${text.trimEnd()}\n${end}`, old = block(current, m), outside = current?.toString("utf8") ?? "";
      desired = Buffer.from(old.value === null ? outside + (outside ? outside.endsWith("\n") ? "\n" : "\n\n" : "") + managed + "\n" : outside.slice(0, old.from) + managed + outside.slice(old.to));
      desiredManaged = hash(managed);
    } else {
      if (entry.mode === "seed") desired = current ?? source;
      if (entry.mode === "merge-index") {
        try { desired = mergeIndex(source, current, previous?.indexSource); }
        catch (error) { if (!(error instanceof SetupError) || error.code !== "INDEX_CONFLICT") throw error; result.conflicts.push({ destination: entry.destination, reason: error.message }); continue; }
      }
      desiredManaged = hash(desired);
    }
    const shared = entry.mode === "merge-index" || entry.mode === "seed";
    if (previous && (previous.mode !== entry.mode || !shared && currentManaged !== previous.hash && currentManaged !== desiredManaged)) result.conflicts.push({ destination: entry.destination, reason: "Local edit or deletion differs from both the last installed and incoming content" });
    else if (!previous && !shared && currentManaged !== null && currentManaged !== desiredManaged) result.conflicts.push({ destination: entry.destination, reason: "Existing content is not managed by this installation" });
    if (!previous && entry.mode === "copy" && entry.destination.startsWith(".space/babel/") && !entry.destination.startsWith(".space/babel/vendor/")) {
      if (!legacyStates) {
        legacyStates = [state];
        for (const product of Object.keys(instructionFiles) as Product[]) {
          if (product === m.product) continue;
          legacyStates.push(await installedState(project, { ...m, product }));
        }
      }
      for (const plugin of setupPlugins(m.plugin)) {
        const legacyPath = entry.destination.replace(".space/babel/", `.space/babel/vendor/${plugin}/`);
        const legacy = legacyStates.flatMap(s => s.entries.filter(e => e.destination === legacyPath));
        const legacyHash = digest(await readOptional(project, legacyPath));
        if ((legacy.length || legacyHash !== null) && legacyHash !== desiredManaged && !legacy.some(e => e.hash === legacyHash)) result.conflicts.push({ destination: legacyPath, reason: "Legacy vendor document has local edits or was deleted; reconcile it with the Babel destination before updating" });
      }
    }
    const action = current === null ? "create" : current.equals(desired) ? "unchanged" : "update";
    result.actions.push({ destination: entry.destination, mode: entry.mode, action, reason: action === "unchanged" ? "Content matches" : previous ? "Managed source changed" : "Initial placement" });
    nextState.entries.push({ ...entry, hash: desiredManaged, ...(entry.mode === "merge-index" ? { indexSource: source.toString("utf8") } : {}) });
    if (action !== "unchanged") operations.push({ destination: entry.destination, beforeHash: digest(current), content: desired.toString("base64") });
  }
  for (const old of state.entries.filter(e => !m.files.some(n => n.destination === e.destination))) { nextState.entries.push(old); result.actions.push({ destination: old.destination, mode: old.mode, action: "retain", reason: "Removed from the plugin; existing destination is preserved" }); }
  return { result, pending: { schemaVersion: 1, manifestHash: ctx.manifestHash, beforeStateHash: digest(stateBytes), nextState, operations }, stateBytes };
}
export async function runSetup(options: { command: "plan" | "apply" | "status"; project: string; pluginRoot: string; skillRoot?: string; product?: Product }): Promise<Result> {
  const ctx = await context(options.project, options.pluginRoot, options.product, options.skillRoot);
  if (options.command !== "apply") return (await plan(ctx)).result;
  // Complete validation before creating metadata or acquiring the write lock.
  const preliminary = await plan(ctx); if (preliminary.result.conflicts.length) throw new SetupError("CONFLICT", "Setup conflict; no destination files were written", preliminary.result);
  await safeMkdir(ctx.project, ".space/setup");
  const locks: { path: string; file: Awaited<ReturnType<typeof open>> }[] = [];
  const completed: string[] = [];
  try {
    for (const relative of ctx.lockPaths) {
      const path = await safePath(ctx.project, relative);
      let file; try { file = await open(path, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SetupError("LOCKED", `Setup is locked: ${path}`); throw error; }
      locks.push({ path, file });
      await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), at: new Date().toISOString() })); await file.sync();
    }
    const prepared = await plan(ctx), { result, pending } = prepared;
    if (result.conflicts.length) throw new SetupError("CONFLICT", "Setup conflict; no destination files were written", result);
    if (!result.pending) await atomicWrite(ctx.project, ctx.pendingPath, jsonBytes(pending));
    for (const op of pending.operations) {
      const current = await readOptional(ctx.project, op.destination), desired = Buffer.from(op.content, "base64");
      if (digest(current) === hash(desired)) continue;
      if (digest(current) !== op.beforeHash) throw new SetupError("CONFLICT", `File changed during apply: ${op.destination}`);
      await atomicWrite(ctx.project, op.destination, desired); completed.push(op.destination);
    }
    const nextBytes = jsonBytes(pending.nextState);
    if (digest(await readOptional(ctx.project, ctx.statePath)) !== hash(nextBytes)) await atomicWrite(ctx.project, ctx.statePath, nextBytes);
    await rm(await safePath(ctx.project, ctx.pendingPath)); return { ...result, pending: false, locked: false };
  } catch (error) {
    if (locks.length === ctx.lockPaths.length && await readOptional(ctx.project, ctx.pendingPath)) throw new SetupError("PARTIAL", `Apply interrupted; preserve the pending record and rerun apply. ${error instanceof Error ? error.message : String(error)}`, { completed, cause: error instanceof SetupError ? error.code : "IO" });
    throw error;
  } finally { for (const lock of locks.reverse()) { await lock.file.close(); await rm(lock.path, { force: true }); } }
}
