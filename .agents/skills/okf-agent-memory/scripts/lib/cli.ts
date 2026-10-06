import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { conceptJSON, createConcept, deleteConcept, initBundle, loadBundle, relateConcepts, updateConcept } from "./bundle.ts";
import { isRecord, nonempty, parseDocument, TYPE_DIRECTORIES } from "./document.ts";
import type { ConceptType, Metadata } from "./document.ts";
import { conceptID, WriteError } from "./files.ts";
import { search, searchForPath } from "./search.ts";
import { validate } from "./validate.ts";

const VERSION = "0.1.0";
const DEFAULT_BUNDLE = ".space/babel";
const boolean = { type: "boolean" } as const, string = { type: "string" } as const;
const common = { json: boolean, help: { ...boolean, short: "h" } };
const mutation = { actor: string, "no-log": boolean, "no-index": boolean };
const content = { type: string, title: string, desc: string, body: string, tags: string, status: string, "body-file": string, "metadata-file": string };
const commands: Record<string, NonNullable<ParseArgsConfig["options"]>> = {
  init: {}, search: { limit: string, all: boolean, "for-path": string, type: string }, show: { raw: boolean },
  create: { ...mutation, ...content }, update: { ...mutation, ...content, unset: { ...string, multiple: true }, sync: boolean },
  delete: { actor: string, "dry-run": boolean },
  relate: { ...mutation, desc: string }, validate: { strict: boolean, drift: boolean, stale: boolean }, version: {},
};
const usages: Record<string, string> = {
  init: "okf init [bundle]",
  search: "okf search <query> [bundle] [--type <type>]\n  okf search --type <type> [bundle]\n  okf search --for-path <path> [bundle] [--type <type>]\n  okf search <query> [bundle] --for-path <path> [--type <type>]",
  show: "okf show <concept-id> [bundle]",
  create: "okf create <concept-id> [bundle] --type <type> --title <title> --desc <summary>",
  update: "okf update <concept-id> [bundle] [changes]",
  delete: "okf delete <concept-id> [bundle] [--dry-run]",
  relate: "okf relate <source-id> <target-id> [bundle] --desc <relationship>",
  validate: "okf validate [bundle]", version: "okf version",
};
const descriptions: Record<string, string> = {
  json: "Emit JSON (errors also use JSON on stdout).", help: "Show command help.",
  actor: "Actor identifier; default agent/cli. Sets generated.by with the actual current time.",
  "no-log": "Skip log.md bookkeeping.", "no-index": "Skip index.md bookkeeping.",
  type: "rule | principle | knowledge | procedure | decision. Search filters frontmatter (query optional); writes require a matching ID directory.",
  title: "Nonempty title.", desc: "Nonempty single-line summary or relationship description.",
  body: "Markdown body; an empty string clears it on update.", "body-file": "Read Markdown body verbatim from a UTF-8 file (exclusive with --body).",
  tags: "Comma-separated tags; an empty string clears them.", status: "draft | stable | deprecated.",
  "metadata-file": "JSON/YAML mapping (or Markdown frontmatter); flags override its fields. generated is automatic.",
  unset: "Remove a metadata key on update; repeatable. Cannot remove generated or required fields.",
  sync: "Repair indexes and missing log references even when content is unchanged; preserve generated.",
  "dry-run": "Preview deletion, affected files, removed relations and new orphans without writing content.",
  limit: "Number of search results; default 10, maximum 100; <=0 uses the default.",
  all: "Return every matching document, without a result limit. Exclusive with --limit.",
  "for-path": "Match code_refs; rank hold, constraint, context. Use --all for scope review.",
  raw: "Return original Markdown bytes, exclusive with --json.", strict: "Fail on any error, warning, legacy finding, broken link or orphan.",
  drift: "Check index summaries and code_refs against the current working directory.", stale: "Fail if a review deadline has expired, even without --strict.",
};
function help(command?: string): string {
  if (!command) return `OKF Agent Memory ${VERSION} (Bun, OKF 0.2)\n\nCommands: ${Object.keys(commands).join(", ")}, help\nUse: okf <command> --help\nDefault bundle: ${DEFAULT_BUNDLE}, relative to your project working directory.\n`;
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}`);
  const options: NonNullable<ParseArgsConfig["options"]> = { ...common, ...commands[command] };
  return `Usage:\n  ${usages[command]}\n\nOptions:\n${Object.entries(options).map(([key, spec]) => `  --${key}${spec.type === "string" ? " <value>" : ""}  ${descriptions[key]}`).join("\n")}\n\nDefault bundle: ${DEFAULT_BUNDLE}. Run from the project root.\n`;
}
class LoadError extends Error {}
async function load(path: string) {
  try { return await loadBundle(path); }
  catch (e) { throw new LoadError(`Error loading bundle: ${e instanceof Error ? e.message : String(e)}`); }
}
type Values = Record<string, string | boolean | string[] | undefined>;
async function metadata(values: Values): Promise<Metadata> {
  let m: Metadata = {};
  if (typeof values["metadata-file"] === "string") {
    const raw = await readFile(values["metadata-file"], "utf8");
    const parsed: unknown = /^\uFEFF?---\s*\r?\n/.test(raw) ? parseDocument(raw).metadata : Bun.YAML.parse(raw);
    if (!isRecord(parsed)) throw new Error("--metadata-file must contain a mapping.");
    if (Object.hasOwn(parsed, "generated")) throw new Error("generated is automatic; use --actor instead.");
    m = parsed;
  }
  for (const [flag, key] of [["type", "type"], ["title", "title"], ["desc", "description"], ["status", "status"]]) {
    if (typeof values[flag!] === "string") m[key!] = values[flag!]!;
  }
  if (typeof values.tags === "string") m.tags = values.tags.split(",").map(s => s.trim()).filter(Boolean);
  return m;
}
function count(positionals: string[], min: number, max: number, command: string) {
  if (positionals.length < min || positionals.length > max) throw new Error(`Expected ${min === max ? min : `${min}–${max}`} positional arguments. Usage: ${usages[command]}`);
}
function output(value: unknown, plain: string, json: boolean) { process.stdout.write(json ? JSON.stringify(value, null, 2) + "\n" : plain); }

export async function main(args: string[]): Promise<number> {
  const jsonRequested = args.includes("--json");
  try {
    const command = args[0] ?? "help";
    if (["help", "--help", "-h"].includes(command)) { process.stdout.write(help(args[1])); return 0; }
    if (["--version", "-v"].includes(command)) return main(["version", ...args.slice(1)]);
    if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}. Use okf help.`);
    const { values: parsed, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, strict: true, options: { ...common, ...commands[command] } });
    const v = parsed as Values, json = v.json === true;
    if (v.help) { process.stdout.write(help(command)); return 0; }
    const opts = { actor: v.actor as string | undefined, noIndex: v["no-index"] === true, noLog: v["no-log"] === true, unset: v.unset as string[] | undefined, sync: v.sync === true };
    if (command === "version") {
      count(positionals, 0, 0, command);
      output({ version: VERSION, okf_version: "0.2", runtime: `bun/${Bun.version}` }, `okf ${VERSION} (OKF 0.2, Bun ${Bun.version})\n`, json);
    } else if (command === "init") {
      count(positionals, 0, 1, command);
      const path = positionals[0] ?? DEFAULT_BUNDLE;
      await initBundle(path, opts);
      output({ status: "success", bundle_path: resolve(path) }, `Initialized OKF 0.2 bundle: ${path}\n`, json);
    } else if (command === "search") {
      if (v.type !== undefined && (typeof v.type !== "string" || !Object.hasOwn(TYPE_DIRECTORIES, v.type))) throw new Error(`--type must be one of: ${Object.keys(TYPE_DIRECTORIES).join(", ")}.`);
      const type = v.type as ConceptType | undefined;
      count(positionals, v["for-path"] || type ? 0 : 1, 2, command);
      if (v.all && v.limit !== undefined) throw new Error("--all and --limit are mutually exclusive.");
      const limit = v.all ? Infinity : v.limit === undefined ? 10 : Number(v.limit);
      if (!v.all && !Number.isSafeInteger(limit)) throw new Error("--limit must be an integer.");
      let query = positionals[0] ?? "", path = positionals[1] ?? DEFAULT_BUNDLE;
      if ((v["for-path"] || type) && positionals.length === 1 && await stat(positionals[0]!).then(s => s.isDirectory(), () => false)) { path = positionals[0]!; query = ""; }
      if (!query.trim() && !v["for-path"] && !type) throw new Error("search requires a nonempty query, --for-path or --type.");
      const b = await load(path);
      const results = typeof v["for-path"] === "string" ? searchForPath(b, v["for-path"], query, limit, type) : search(b, query, limit, type);
      output(results, results.map(r => `${r.concept_id} [${r.governance}] (${r.score}) ${r.title}\n  ${r.description}`).join("\n") + "\n", json);
    } else if (command === "show") {
      count(positionals, 1, 2, command);
      if (v.raw && json) throw new Error("--raw and --json are mutually exclusive.");
      const id = conceptID(positionals[0]!), b = await load(positionals[1] ?? DEFAULT_BUNDLE), c = b.concepts.get(id);
      if (!c) throw new Error(`Concept not found: ${id}`);
      if (c.parseError && !v.raw) throw new Error(`${c.path}: ${c.parseError}`);
      const graph = `\nInbound: ${(b.inbound.get(id) ?? []).join(", ") || "(none)"}\nOutbound: ${(b.graph.get(id) ?? []).join(", ") || "(none)"}\n`;
      output(conceptJSON(c, b), c.raw + (v.raw ? "" : graph), json);
    } else if (command === "create" || command === "update") {
      count(positionals, 1, 2, command);
      const id = conceptID(positionals[0]!), path = positionals[1] ?? DEFAULT_BUNDLE;
      if (v.body !== undefined && v["body-file"] !== undefined) throw new Error("--body and --body-file are mutually exclusive.");
      if (opts.unset?.some(key => ["type", "title", "description", "generated"].includes(key))) throw new Error("Cannot unset required fields or generated.");
      const body = typeof v["body-file"] === "string" ? await readFile(v["body-file"], "utf8") : v.body as string | undefined;
      const m = await metadata(v);
      const c = command === "create" ? await createConcept(path, id, m, body, opts) : await updateConcept(path, id, m, body, opts);
      output({ status: "success", concept_id: c.id, path: c.path }, `${command === "create" ? "Created" : "Updated"}: ${c.path}\n`, json);
    } else if (command === "delete") {
      count(positionals, 1, 2, command);
      const result = await deleteConcept(positionals[1] ?? DEFAULT_BUNDLE, positionals[0]!, { actor: opts.actor, dryRun: v["dry-run"] === true });
      output({ status: v["dry-run"] ? "preview" : "success", ...result },
        `${v["dry-run"] ? "Would delete" : "Deleted"}: ${result.path}\nChanged files:\n${result.changed_paths.map(path => `- ${path}\n`).join("")}Unlinked concepts: ${result.updated_concepts.join(", ") || "(none)"}\nNew orphans: ${result.new_orphans.join(", ") || "(none)"}\n`, json);
    } else if (command === "relate") {
      count(positionals, 2, 3, command);
      if (!nonempty(v.desc)) throw new Error("relate requires --desc with a relationship description.");
      const source = conceptID(positionals[0]!), target = conceptID(positionals[1]!);
      await relateConcepts(positionals[2] ?? DEFAULT_BUNDLE, source, target, v.desc, opts);
      output({ status: "success", source, target }, `Linked ${source} -> ${target}\n`, json);
    } else if (command === "validate") {
      count(positionals, 0, 1, command);
      const r = await validate(await load(positionals[0] ?? DEFAULT_BUNDLE), { strict: v.strict === true, drift: v.drift === true, stale: v.stale === true });
      output(r, `${r.gate_passed ? "PASS" : "FAIL"}: ${r.concept_count} concepts, ${r.errors.length} errors, ${r.warnings.length} warnings, ${r.gate_findings.length} legacy findings, ${r.broken_links.length} broken links, ${r.orphans.length} orphans\n${[...r.errors, ...r.warnings, ...r.gate_findings, ...r.broken_links.map(l => `${l.source_concept}: ${l.target_href} (${l.reason})`), ...r.orphans.map(id => `${id}: orphan`)].map(s => `- ${s}\n`).join("")}`, json);
      return r.gate_passed ? 0 : 1;
    }
    return 0;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (jsonRequested) output({ status: "error", error, ...(e instanceof WriteError ? { written_paths: e.writtenPaths } : {}) }, "", true);
    else process.stderr.write(`Error: ${error}\n`);
    return e instanceof LoadError ? 2 : 1;
  }
}
