import { stat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { compare, links, resolveLink, stripFences } from "./bundle.ts";
import type { BrokenLink, Bundle } from "./bundle.ts";
import { isRecord, isTimestamp, TYPE_DIRECTORIES, validateMetadata } from "./document.ts";
import { hasCode } from "./files.ts";

export interface ValidateOptions { strict?: boolean; drift?: boolean; stale?: boolean; now?: Date; projectRoot?: string }
export interface ValidationResult {
  bundle_path: string; declared_version?: string; concept_count: number; errors: string[]; warnings: string[];
  gate_findings: string[]; broken_links: BrokenLink[]; orphans: string[]; stale_count: number; is_conformant: boolean; gate_passed: boolean;
}
const hasFrontmatter = (raw: string) => /^\uFEFF?---\s*\r?\n/.test(raw);
const normalize = (s: string) => s.toLowerCase().replace(/[\\"'`*_]/g, "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
async function referenceExists(root: string, ref: string): Promise<boolean> {
  if (/[*?[{]/.test(ref)) {
    for await (const _ of new Bun.Glob(ref).scan({ cwd: root, dot: true, onlyFiles: false, followSymlinks: false })) return true;
    return false;
  }
  try { await stat(join(root, ref)); return true; }
  catch (e) { if (hasCode(e, "ENOENT") || hasCode(e, "ENOTDIR")) return false; throw e; }
}

export async function validate(b: Bundle, options: ValidateOptions = {}): Promise<ValidationResult> {
  const now = options.now ?? new Date();
  const r: ValidationResult = {
    bundle_path: b.root, ...(b.version ? { declared_version: b.version } : {}), concept_count: b.concepts.size,
    errors: [], warnings: [], gate_findings: [], broken_links: [...b.brokenLinks], orphans: [...b.orphans],
    stale_count: 0, is_conformant: false, gate_passed: false,
  };
  if (b.version !== "0.2") r.warnings.push('index.md: expected okf_version: "0.2" in bundle-root frontmatter.');
  for (const [path, raw] of [...b.indexes, ...b.logs]) {
    if (path !== "index.md" && hasFrontmatter(raw)) r.warnings.push(`${path}: navigation documents must not carry frontmatter.`);
    if (posix.basename(path) === "log.md") {
      for (const line of stripFences(raw).split("\n")) {
        if (line.startsWith("## ") && !isTimestamp(`${line.slice(3).trim()}T00:00:00Z`)) r.warnings.push(`${path}: log heading '${line.slice(3)}' must be YYYY-MM-DD.`);
      }
    }
  }
  for (const c of b.concepts.values()) {
    if (c.parseError) { r.errors.push(`${c.path}: ${c.parseError}`); continue; }
    const { errors, warnings } = validateMetadata(c.metadata, now);
    r.errors.push(...errors.map(s => `${c.path}: ${s}`));
    r.warnings.push(...warnings.map(s => `${c.path}: ${s}`));
    if (typeof c.metadata.type === "string" && Object.hasOwn(TYPE_DIRECTORIES, c.metadata.type)) {
      const directory = TYPE_DIRECTORIES[c.metadata.type as keyof typeof TYPE_DIRECTORIES];
      if (!c.id.startsWith(`${directory}/`)) r.errors.push(`${c.path}: type ${c.metadata.type} belongs under ${directory}/.`);
    }
    if (isTimestamp(c.metadata.stale_after) && Date.parse(c.metadata.stale_after) <= now.getTime()) r.stale_count++;
    const visible = stripFences(c.body);
    if (b.version === "0.2") {
      if (Object.hasOwn(c.metadata, "timestamp")) r.gate_findings.push(`${c.path}: legacy 'timestamp'; use generated: {by, at}.`);
      if (/^#\s+Citations\s*$/m.test(visible)) r.gate_findings.push(`${c.path}: legacy '# Citations'; use sources frontmatter.`);
    }
    const sources = Array.isArray(c.metadata.sources) ? c.metadata.sources.filter(isRecord) : [];
    const ids = new Set(sources.map(s => s.id).filter(id => typeof id === "string"));
    if (ids.size) for (const key of new Set([...visible.matchAll(/\[\^([^\]]+)\]/g)].map(m => m[1]!))) {
      if (!ids.has(key)) r.warnings.push(`${c.path}: footnote [^${key}] matches no sources entry id.`);
    }
    if (options.drift) {
      const indexPath = posix.join(posix.dirname(c.path), "index.md");
      const index = b.indexes.get(indexPath);
      const listings = index === undefined ? [] : links(index).filter(link => resolveLink(indexPath, link.href) === c.id);
      if (index === undefined) r.warnings.push(`${c.path}: parent index ${indexPath} does not exist.`);
      else if (!listings.length) r.warnings.push(`${c.path}: concept is not listed in parent index ${indexPath}.`);
      else if (typeof c.metadata.description === "string" && listings.some(link => {
        const description = /\)\s*[-–:]\s*(.+)$/.exec(link.line)?.[1];
        return description === undefined || normalize(description) !== normalize(c.metadata.description as string);
      })) r.warnings.push(`${indexPath}: listing for ${c.path} differs from concept description.`);
      if (!errors.some(e => e.startsWith("code_refs:")) && Array.isArray(c.metadata.code_refs)) {
        for (const ref of c.metadata.code_refs as string[]) {
          if (!await referenceExists(resolve(options.projectRoot ?? process.cwd()), ref)) r.warnings.push(`${c.path}: code_refs '${ref}' matches no path in the project.`);
        }
      }
    }
  }
  for (const [path, raw] of b.indexes) {
    if (!options.drift) continue;
    for (const link of links(raw)) {
      const c = b.concepts.get(resolveLink(path, link.href));
      if (!c || posix.join(posix.dirname(c.path), "index.md") === path || typeof c.metadata.description !== "string") continue;
      const description = /\)\s*[-–:]\s*(.+)$/.exec(link.line)?.[1];
      if (description && normalize(description) !== normalize(c.metadata.description)) r.warnings.push(`${path}: listing for ${c.path} differs from concept description.`);
    }
  }
  r.errors.sort(compare); r.warnings.sort(compare); r.gate_findings.sort(compare);
  r.broken_links.sort((a, b) => compare(a.source_concept, b.source_concept) || compare(a.target_href, b.target_href));
  r.orphans.sort(compare);
  r.is_conformant = r.errors.length === 0;
  r.gate_passed = r.is_conformant && !(options.strict && (r.warnings.length || r.gate_findings.length || r.broken_links.length || r.orphans.length)) && !(options.stale && r.stale_count);
  return r;
}
