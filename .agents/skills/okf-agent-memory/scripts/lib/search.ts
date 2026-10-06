// Port of pkg/okf/search.go, okf-memory/okf-agent-memory (MIT; see ../../LICENSE).
// Keyword scoring uses MiniSearch BM25+ with Japanese segmentation instead of the upstream formula.
import { posix } from "node:path";
import MiniSearch from "minisearch";
import { compare } from "./bundle.ts";
import type { Bundle, Concept } from "./bundle.ts";
import type { ConceptType } from "./document.ts";

export interface SearchResult {
  concept_id: string; title: string; type: string; description: string; governance: string;
  code_refs?: string[]; score: number; matched_on: string[]; tags?: string[]; inbound?: string[]; outbound?: string[];
}
const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
// Exclude only common particles; keep negation and domain terms in the index.
const particles = new Set(["の", "は", "が", "を", "に", "へ", "と", "で", "も", "や"]);
function tokens(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{M}\p{Nd}]+/u)) {
    for (const { segment, isWordLike } of segmenter.segment(chunk)) {
      if (isWordLike && !particles.has(segment)) words.push(segment);
    }
  }
  return words;
}
const fields = ["title", "tags", "description", "id", "body"];
const boost = { title: 4, tags: 3.5, description: 2.5, id: 2, body: 1 };
interface SearchDocument { id: string; title: string; tags: string; description: string; body: string }
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const field = (value: unknown) => typeof value === "string" ? value : "";
// Infinity is reserved for the CLI's explicit --all request; numeric limits remain capped.
const boundedLimit = (limit: number) => limit === Infinity ? Infinity : limit <= 0 ? 10 : Math.min(limit, 100);
const round = (score: number) => Math.round(score * 100) / 100;
const governance = (c: Concept) => field(c.metadata.governance) || "context";
const rank = (gov: string) => gov === "hold" ? 3 : gov === "constraint" ? 2 : 1;
function result(b: Bundle, c: Concept, score: number, matched_on: string[]): SearchResult {
  const r: SearchResult = {
    concept_id: c.id, title: field(c.metadata.title), type: field(c.metadata.type), description: field(c.metadata.description),
    governance: governance(c), score: round(score), matched_on,
  };
  for (const [key, values] of [["tags", strings(c.metadata.tags)], ["code_refs", strings(c.metadata.code_refs)], ["inbound", b.inbound.get(c.id) ?? []], ["outbound", b.graph.get(c.id) ?? []]] as const) {
    if (values.length) r[key] = values;
  }
  return r;
}
// Scope filtering and result limits belong to the caller, after all candidates are scored.
function keywordResults(b: Bundle, query: string): SearchResult[] {
  const terms = tokens([...query].slice(0, 1000).join("")).slice(0, 50);
  if (!terms.length || !b.concepts.size) return [];
  const index = new MiniSearch<SearchDocument>({
    fields, tokenize: tokens,
    searchOptions: { boost, prefix: true, fuzzy: false, combineWith: "OR" },
  });
  // Stable insertion order also makes index statistics independent of bundle traversal order.
  index.addAll([...b.concepts.values()].sort((a, c) => compare(a.id, c.id)).map(c => ({
    id: c.id, title: field(c.metadata.title), tags: strings(c.metadata.tags).join(" "),
    description: field(c.metadata.description), body: c.body,
  })));
  return index.search(query, { tokenize: () => terms }).map(hit => {
    const matched = new Set(Object.values(hit.match).flat());
    return result(b, b.concepts.get(hit.id)!, hit.score, fields.filter(name => matched.has(name)));
  });
}
function filterType(results: SearchResult[], type?: ConceptType): SearchResult[] {
  return type === undefined ? results : results.filter(r => r.type === type).map(r => ({ ...r, matched_on: [...r.matched_on, "type"] }));
}
export function search(b: Bundle, query: string, limit = 10, type?: ConceptType): SearchResult[] {
  const typeOnly = type !== undefined && !query.trim();
  const candidates = typeOnly ? [...b.concepts.values()].map(c => result(b, c, 0, [])) : keywordResults(b, query);
  return filterType(candidates, type).sort((a, b) => (typeOnly ? rank(b.governance) - rank(a.governance) : b.score - a.score)
    || compare(a.concept_id, b.concept_id)).slice(0, boundedLimit(limit));
}

// Preserve upstream matching, including absolute-path suffixes and its single-** semantics.
export function matchCodeRef(ref: string, target: string): boolean {
  const clean = (value: string) => value.trim().replace(/^\./, "").replace(/^\//, "").replaceAll("\\", "/");
  ref = clean(ref); target = clean(target);
  if (!ref || !target) return false;
  if (ref === target || target.endsWith(`/${ref}`)) return true;
  const dir = ref.replace(/\/$/, "");
  if (target.startsWith(`${dir}/`) || target.includes(`/${dir}/`)) return true;
  if (!ref.includes("**") && new Bun.Glob(ref).match(target)) return true;
  const parts = ref.split("**");
  if (parts.length !== 2) return false;
  const prefix = parts[0]!.replace(/\/$/, ""), suffix = parts[1]!.replace(/^\//, "");
  if (prefix && !target.startsWith(`${prefix}/`) && target !== prefix && !target.includes(`/${prefix}/`)) return false;
  if (!suffix) return true;
  if (suffix.includes("*")) return new Bun.Glob(suffix).match(posix.basename(target));
  return target.endsWith(`/${suffix}`) || target === suffix;
}
export function searchForPath(b: Bundle, target: string, query = "", limit = 10, type?: ConceptType): SearchResult[] {
  target = target.trim();
  if (!target) return search(b, query, limit, type);
  const textResults = new Map(keywordResults(b, query).map(r => [r.concept_id, r]));
  const results: SearchResult[] = [];
  for (const c of b.concepts.values()) {
    const matchedRef = strings(c.metadata.code_refs).find(ref => matchCodeRef(ref, target));
    if (matchedRef === undefined) continue;
    const normalize = (value: string) => value.replace(/^\.\//, "").replaceAll("\\", "/");
    const text = textResults.get(c.id);
    results.push(result(b, c, rank(governance(c)) * 10 + (normalize(matchedRef) === normalize(target) ? 2 : 0) + (text?.score ?? 0), ["code_refs", ...(text?.matched_on ?? [])]));
  }
  return filterType(results, type).sort((a, b) => rank(b.governance) - rank(a.governance) || b.score - a.score || compare(a.concept_id, b.concept_id)).slice(0, boundedLimit(limit));
}
