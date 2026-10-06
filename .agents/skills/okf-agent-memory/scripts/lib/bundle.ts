import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { isActor, parseDocument, serializeDocument, TYPE_DIRECTORIES, validateMetadata } from "./document.ts";
import type { Document, Metadata } from "./document.ts";
import { applyChanges, conceptID, optionalRead, rootPath, safePath, withLock } from "./files.ts";
import type { FileChange } from "./files.ts";

export interface Concept extends Document { id: string; path: string; raw: string; parseError?: string }
export interface BrokenLink { source_concept: string; target_href: string; reason: string }
export interface Bundle {
  root: string; version?: string; concepts: Map<string, Concept>; indexes: Map<string, string>; logs: Map<string, string>;
  graph: Map<string, string[]>; inbound: Map<string, string[]>; brokenLinks: BrokenLink[]; orphans: string[];
}
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function stripFences(text: string): string {
  let fence = "", length = 0;
  return text.split(/\r?\n/).map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) { fence = marker[1]![0]!; length = marker[1]!.length; }
      else if (marker[1]![0] === fence && marker[1]!.length >= length && !marker[2]!.trim()) fence = "";
      return "";
    }
    return fence ? "" : line;
  }).join("\n").replace(/<!--[^]*?-->/g, comment => comment.replace(/[^\n]/g, " "));
}
const escapedAt = (text: string, offset: number) => (text.slice(0, offset).match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
function maskInlineCode(line: string): string {
  const runs = [...line.matchAll(/`+/g)];
  let masked = line;
  for (let i = 0; i < runs.length; i++) {
    const start = runs[i]!;
    if (escapedAt(line, start.index)) continue;
    const endIndex = runs.findIndex((run, index) => index > i && run[0].length === start[0].length);
    if (endIndex < 0) continue;
    const end = runs[endIndex]!, until = end.index + end[0].length;
    masked = masked.slice(0, start.index) + " ".repeat(until - start.index) + masked.slice(until);
    i = endIndex;
  }
  return masked;
}
interface LinkSpan { href: string; label: string; line: string; lineNumber: number; start: number; end: number }
function linkSpans(text: string): LinkSpan[] {
  const result: LinkSpan[] = [], original = text.split("\n");
  for (const [lineNumber, line] of stripFences(text).split("\n").entries()) {
    // Mask inline examples without moving the offsets used when removing links.
    const visible = maskInlineCode(line);
    for (const m of visible.matchAll(/(?<!!)\[((?:\\.|[^\]\\])*)\]\(<?([^\s>]+?\.md(?:[?#][^\s>)]*)?)>?(?:\s+"[^"]*")?\)/g)) {
      if (!escapedAt(visible, m.index) && !/^[a-z][\w+.-]*:/i.test(m[2]!) && !m[2]!.startsWith("//")) result.push({
        href: m[2]!, label: original[lineNumber]!.slice(m.index + 1, m.index + 1 + m[1]!.length),
        line, lineNumber, start: m.index, end: m.index + m[0].length,
      });
    }
  }
  return result;
}
export function links(text: string): { href: string; line: string }[] {
  return linkSpans(text).map(({ href, line }) => ({ href, line }));
}
export function resolveLink(source: string, href: string): string {
  let clean = href.split(/[?#]/)[0]!;
  try { clean = decodeURIComponent(clean); } catch { /* invalid encoding is unresolved */ }
  return (clean.startsWith("/") ? posix.normalize(clean.slice(1)) : posix.normalize(posix.join(posix.dirname(source), clean))).replace(/\.md$/, "");
}
const reserved = (id: string) => ["index", "log"].includes(posix.basename(id).toLowerCase()) || id.toLowerCase() === "agents";

export async function loadBundle(path: string): Promise<Bundle> {
  const root = await rootPath(path);
  const b: Bundle = { root, concepts: new Map(), indexes: new Map(), logs: new Map(), graph: new Map(), inbound: new Map(), brokenLinks: [], orphans: [] };
  async function walk(dir: string): Promise<void> {
    const entries = (await readdir(join(root, dir), { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || (dir === "" && entry.name === "vendor")) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks inside a bundle are not supported: ${rel}`);
      if (entry.isDirectory()) { await walk(rel); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md") || rel.toLowerCase() === "agents.md") continue;
      const raw = await readFile(await safePath(root, rel), "utf8");
      if (entry.name === "index.md") {
        b.indexes.set(rel, raw);
        if (rel === "index.md") {
          try { const version = parseDocument(raw).metadata.okf_version; if (typeof version === "string") b.version = version; } catch { /* reported by validation */ }
        }
      } else if (entry.name === "log.md") b.logs.set(rel, raw);
      else {
        const id = rel.slice(0, -3);
        try { b.concepts.set(id, { id, path: rel, raw, ...parseDocument(raw) }); }
        catch (error) { b.concepts.set(id, { id, path: rel, raw, metadata: {}, body: "", parseError: String(error) }); }
      }
    }
  }
  await walk("");
  for (const id of b.concepts.keys()) { b.graph.set(id, []); b.inbound.set(id, []); }
  for (const [source, text, isIndex] of [
    ...[...b.concepts.values()].map(c => [c.path, c.body, false] as const),
    ...[...b.indexes].map(([path, text]) => [path, text, true] as const),
  ]) {
    for (const { href } of links(text)) {
      const target = resolveLink(source, href);
      if (reserved(target)) {
        if (!isIndex) b.brokenLinks.push({ source_concept: source, target_href: href, reason: "reserved navigation document is not a concept" });
        else if (!b.indexes.has(`${target}.md`) && !b.logs.has(`${target}.md`) && target.toLowerCase() !== "agents") b.brokenLinks.push({ source_concept: source, target_href: href, reason: "navigation target does not exist" });
      } else if (!b.concepts.has(target)) b.brokenLinks.push({ source_concept: source, target_href: href, reason: "target concept does not exist" });
      else if (!isIndex && target !== source.slice(0, -3)) {
        const id = source.slice(0, -3);
        if (!b.graph.get(id)!.includes(target)) { b.graph.get(id)!.push(target); b.inbound.get(target)!.push(id); }
      }
    }
  }
  for (const list of [...b.graph.values(), ...b.inbound.values()]) list.sort(compare);
  if (b.concepts.size > 1) b.orphans = [...b.concepts.keys()].filter(id => !b.graph.get(id)!.length && !b.inbound.get(id)!.length).sort(compare);
  return b;
}

export interface MutationOptions { actor?: string; now?: Date; noIndex?: boolean; noLog?: boolean; unset?: string[]; sync?: boolean }
const time = (options: MutationOptions) => options.now ?? new Date();
const ROOT_INDEX = '---\nokf_version: "0.2"\n---\n\n# Knowledge Base\n\n';
const escapeText = (text: unknown) => String(text).replace(/[\r\n]+/g, " ").replace(/[\\[\]*`]/g, "\\$&");
const encodePath = (path: string) => path.split("/").map(part => encodeURIComponent(part).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join("/");

async function planFile(root: string, plan: Map<string, FileChange>, relative: string, edit: (current: string | undefined) => string): Promise<void> {
  const existing = plan.get(relative), before = existing ? existing.before : await optionalRead(root, relative);
  plan.set(relative, { relative, before, after: edit(existing ? existing.after : before) });
}
function listing(text: string, href: string, title: string, description?: string): string {
  const line = `* [${escapeText(title)}](${encodePath(href)})${description ? ` - ${escapeText(description)}` : ""}`;
  const lines = text.split("\n");
  const idx = lines.findIndex(value => /^\s*[-*] /.test(value) && links(value).some(link => resolveLink("index.md", link.href) === resolveLink("index.md", href)));
  if (idx >= 0) { lines[idx] = line; return lines.join("\n"); }
  return text.trimEnd() + "\n" + line + "\n";
}
async function planIndexes(root: string, plan: Map<string, FileChange>, c: Concept): Promise<void> {
  let dir = posix.dirname(c.path);
  const index = dir === "." ? "index.md" : `${dir}/index.md`;
  await planFile(root, plan, index, current => listing(current ?? (dir === "." ? ROOT_INDEX : `# ${posix.basename(dir)}\n\n`), posix.basename(c.path), String(c.metadata.title), String(c.metadata.description)));
  while (dir !== ".") {
    const child = posix.basename(dir), parent = posix.dirname(dir);
    await planFile(root, plan, parent === "." ? "index.md" : `${parent}/index.md`, current => listing(current ?? (parent === "." ? ROOT_INDEX : `# ${posix.basename(parent)}\n\n`), `${child}/index.md`, child));
    dir = parent;
  }
}
async function planLog(root: string, plan: Map<string, FileChange>, message: string, options: MutationOptions): Promise<void> {
  await planFile(root, plan, "log.md", current => {
    const heading = `## ${time(options).toISOString().slice(0, 10)}\n`;
    const entry = `* ${message.replace(/[\r\n]+/g, " ")}\n`;
    return current?.includes(heading) ? current.replace(heading, heading + entry) : heading + entry + (current ? "\n" + current : "");
  });
}
export async function initBundle(path: string, options: MutationOptions = {}): Promise<void> {
  const root = await rootPath(path, true);
  await withLock(root, async () => {
    const plan = new Map<string, FileChange>();
    await planFile(root, plan, "index.md", current => current ?? ROOT_INDEX);
    for (const directory of Object.values(TYPE_DIRECTORIES)) {
      await planFile(root, plan, `${directory}/index.md`, current => current ?? `# ${directory}\n\n`);
      await planFile(root, plan, "index.md", current => listing(current!, `${directory}/index.md`, directory));
    }
    if (await optionalRead(root, "log.md") === undefined) await planLog(root, plan, "**Creation**: Initialized OKF v0.2 knowledge bundle.", options);
    await applyChanges(root, [...plan.values()]);
  });
}

async function save(root: string, id: string, metadata: Metadata, body: string, before: string | undefined, options: MutationOptions, action: string): Promise<Concept> {
  const final: Metadata = { ...metadata, generated: { by: options.actor ?? "agent/cli", at: time(options).toISOString() } };
  const { errors } = validateMetadata(final, time(options));
  if (errors.length) throw new Error(errors.join("\n"));
  const typeDirectory = TYPE_DIRECTORIES[final.type as keyof typeof TYPE_DIRECTORIES];
  if (!id.startsWith(`${typeDirectory}/`)) throw new Error(`type ${final.type} belongs under ${typeDirectory}/.`);
  const raw = serializeDocument({ metadata: final, body });
  const c: Concept = { id, path: `${id}.md`, metadata: final, body, raw };
  const plan = new Map<string, FileChange>([[c.path, { relative: c.path, before, after: raw }]]);
  if (!options.noIndex) await planIndexes(root, plan, c);
  if (!options.noLog) await planLog(root, plan, `**${action}**: [${escapeText(final.title)}](${encodePath(c.path)}).`, options);
  await applyChanges(root, [...plan.values()]);
  return c;
}
export async function createConcept(path: string, input: string, metadata: Metadata, body = "", options: MutationOptions = {}): Promise<Concept> {
  const id = conceptID(input), root = await rootPath(path);
  return withLock(root, async () => {
    if (await optionalRead(root, `${id}.md`) !== undefined) throw new Error(`Concept already exists: ${id}`);
    return save(root, id, metadata, body, undefined, options, "Creation");
  });
}
export async function updateConcept(path: string, input: string, changes: Metadata, body?: string, options: MutationOptions = {}): Promise<Concept> {
  const id = conceptID(input), root = await rootPath(path);
  return withLock(root, async () => {
    const before = await optionalRead(root, `${id}.md`);
    if (before === undefined) throw new Error(`Concept not found: ${id}`);
    const c = parseDocument(before), metadata = { ...c.metadata, ...changes };
    for (const key of options.unset ?? []) {
      if (["type", "title", "description", "generated"].includes(key)) throw new Error(`Cannot unset ${key}.`);
      delete metadata[key];
    }
    if (JSON.stringify(metadata) === JSON.stringify(c.metadata) && (body === undefined || body === c.body)) {
      const unchanged = { id, path: `${id}.md`, ...c, raw: before };
      if (options.sync) {
        const errors = validateMetadata(metadata, time(options)).errors;
        if (errors.length) throw new Error(errors.join("\n"));
        const plan = new Map<string, FileChange>();
        if (!options.noIndex) await planIndexes(root, plan, unchanged);
        const log = await optionalRead(root, "log.md");
        if (!options.noLog && ([...plan.values()].some(c => c.before !== c.after) || !links(log ?? "").some(l => resolveLink("log.md", l.href) === id))) {
          await planLog(root, plan, `**Synchronization**: [${escapeText(metadata.title)}](${encodePath(unchanged.path)}).`, options);
        }
        await applyChanges(root, [...plan.values()]);
      }
      return unchanged;
    }
    return save(root, id, metadata, body ?? c.body, before, options, "Update");
  });
}
export async function relateConcepts(path: string, source: string, target: string, description: string, options: MutationOptions = {}): Promise<void> {
  const sourceID = conceptID(source), targetID = conceptID(target), root = await rootPath(path);
  if (sourceID === targetID) throw new Error("Cannot relate a concept to itself.");
  await withLock(root, async () => {
    const sourceRaw = await optionalRead(root, `${sourceID}.md`), targetRaw = await optionalRead(root, `${targetID}.md`);
    if (sourceRaw === undefined || targetRaw === undefined) throw new Error("Source or target concept not found.");
    const s = parseDocument(sourceRaw), t = parseDocument(targetRaw);
    const href = posix.relative(posix.dirname(`${sourceID}.md`), `${targetID}.md`);
    const line = `- [${escapeText(t.metadata.title)}](${encodePath(href)})${description.trim() ? `: ${escapeText(description.trim())}` : ""}`;
    if (stripFences(s.body).split("\n").some(existing => existing.trim() === line)) return;
    const visible = stripFences(s.body).split("\n");
    const start = visible.findIndex(line => /^# Related(?: Concepts)?\s*$/.test(line));
    const lines = s.body.split(/\r?\n/);
    let body: string;
    if (start >= 0) {
      const end = visible.findIndex((line, i) => i > start && /^# /.test(line));
      lines.splice(end < 0 ? lines.length : end, 0, line);
      body = lines.join("\n");
    } else body = s.body.trimEnd() + "\n\n# Related Concepts\n" + line + "\n";
    await save(root, sourceID, s.metadata, body, sourceRaw, options, "Relationship");
  });
}

function inlineCode(value: string): string {
  const delimiter = "`".repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  return delimiter + (/^`|`$/.test(value) ? ` ${value} ` : value) + delimiter;
}

function unlinkConcept(text: string, source: string, target: string, mode: "concept" | "index" | "log"): string {
  const matches = linkSpans(text).filter(link => resolveLink(source, link.href) === target);
  if (!matches.length) return text;
  const parts = text.split(/(?<=\n)/), visible = stripFences(text).split("\n");
  const removedLines = new Set<number>();
  let related = false;
  for (let i = 0; i < parts.length; i++) {
    if (/^# /.test(visible[i] ?? "")) related = /^# Related(?: Concepts)?\s*$/.test(visible[i]!);
    const lineMatches = matches.filter(link => link.lineNumber === i);
    if (!lineMatches.length) continue;
    const line = parts[i]!, first = lineMatches[0]!;
    // Only remove whole list entries in navigation or CLI relation sections.
    // Prose and entries with other links keep their text and remaining links.
    const remainder = line.slice(first.end);
    if ((mode === "index" || mode === "concept" && related) && lineMatches.length === 1 &&
      /^\s*[-*] +$/.test(line.slice(0, first.start)) && !/\[[^]*\]\(/.test(remainder)) {
      parts[i] = "";
      removedLines.add(i);
    } else {
      let changed = line;
      for (const link of lineMatches.toReversed()) {
        const replacement = link.label + (mode === "log" ? ` (${inlineCode(target)})` : "");
        changed = changed.slice(0, link.start) + replacement + changed.slice(link.end);
      }
      parts[i] = changed;
    }
  }
  if (mode === "concept") {
    for (let i = 0; i < parts.length; i++) {
      if (!/^# Related(?: Concepts)?\s*$/.test(visible[i] ?? "")) continue;
      let end = i + 1;
      while (end < parts.length && !/^# /.test(visible[end] ?? "")) end++;
      if ([...removedLines].some(line => line > i && line < end) && !parts.slice(i + 1, end).join("").trim()) {
        let start = i;
        while (start > 0 && !parts[start - 1]!.trim()) start--;
        for (let j = start; j < end; j++) parts[j] = "";
      }
    }
  }
  return parts.join("");
}

export interface DeleteOptions { actor?: string; now?: Date; dryRun?: boolean }
export interface DeleteResult {
  concept_id: string; path: string; updated_concepts: string[]; changed_paths: string[];
  removed_relations: { source: string; target: string }[]; new_orphans: string[];
}
export async function deleteConcept(path: string, input: string, options: DeleteOptions = {}): Promise<DeleteResult> {
  const id = conceptID(input), root = await rootPath(path);
  const actor = options.actor ?? "agent/cli", now = options.now ?? new Date();
  if (!isActor(actor)) throw new Error("actor must be an actor identifier, such as agent:codex.");
  return withLock(root, async () => {
    const b = await loadBundle(root), target = b.concepts.get(id);
    if (!target) throw new Error(`Concept not found: ${id}`);
    const plan = new Map<string, FileChange>(), updated: string[] = [];
    for (const c of b.concepts.values()) {
      if (c.id === id) continue;
      if (c.parseError) throw new Error(`Cannot inspect references in ${c.path}: ${c.parseError}`);
      const body = unlinkConcept(c.body, c.path, id, "concept");
      if (body === c.body) continue;
      const metadata = { ...c.metadata, generated: { by: actor, at: now.toISOString() } };
      const { errors } = validateMetadata(metadata, now);
      if (errors.length) throw new Error(`${c.path}: ${errors.join("\n")}`);
      plan.set(c.path, { relative: c.path, before: c.raw, after: serializeDocument({ metadata, body }) });
      updated.push(c.id);
    }
    for (const [relative, before] of b.indexes) {
      const after = unlinkConcept(before, relative, id, "index");
      if (after !== before) plan.set(relative, { relative, before, after });
    }
    for (const [relative, before] of b.logs) {
      const after = unlinkConcept(before, relative, id, "log");
      if (after !== before) plan.set(relative, { relative, before, after });
    }
    updated.sort(compare);
    const removed = [...b.graph].flatMap(([source, targets]) => targets
      .filter(destination => source === id || destination === id).map(destination => ({ source, target: destination })))
      .sort((a, z) => compare(a.source, z.source) || compare(a.target, z.target));
    const newOrphans = b.concepts.size - 1 > 1 ? [...b.concepts.keys()].filter(key => key !== id && !b.orphans.includes(key) &&
      !b.graph.get(key)!.some(next => next !== id) && !b.inbound.get(key)!.some(previous => previous !== id)).sort(compare) : [];
    await planLog(root, plan,
      `**Deletion**: ${inlineCode(id)} (${escapeText(target.metadata.title ?? id)}); actor: ${escapeText(actor)}; at: ${now.toISOString()}; unlinked concepts: ${updated.map(inlineCode).join(", ") || "none"}.`,
      { actor, now });
    const result: DeleteResult = {
      concept_id: id, path: target.path, updated_concepts: updated,
      changed_paths: [...plan.keys(), target.path].sort(compare), removed_relations: removed, new_orphans: newOrphans,
    };
    if (!options.dryRun) {
      // Record success only after the target was actually removed. Partial
      // failures retain written_paths, including an already deleted target.
      const log = plan.get("log.md")!;
      plan.delete("log.md");
      await applyChanges(root, [...plan.values(), { relative: target.path, before: target.raw, after: null }, log]);
    }
    return result;
  });
}

const KNOWN = new Set(["type", "title", "description", "resource", "tags", "generated", "verified", "status", "governance", "code_refs", "stale_after", "sources", "attestation"]);
export function conceptJSON(c: Concept, b?: Bundle): Record<string, unknown> {
  const known = Object.fromEntries(Object.entries(c.metadata).filter(([key]) => KNOWN.has(key)));
  const extra = Object.fromEntries(Object.entries(c.metadata).filter(([key]) => !KNOWN.has(key)));
  return { id: c.id, path: c.path, ...known, ...(Object.keys(extra).length ? { extra } : {}), body: c.body, raw_content: c.raw, ...(b ? { inbound: b.inbound.get(c.id) ?? [], outbound: b.graph.get(c.id) ?? [] } : {}) };
}
