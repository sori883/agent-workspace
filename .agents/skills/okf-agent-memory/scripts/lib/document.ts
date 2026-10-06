import { YAML } from "bun";

export const TYPE_DIRECTORIES = { rule: "rules", principle: "principles", knowledge: "knowledge", procedure: "procedures", decision: "decisions" } as const;
export type ConceptType = keyof typeof TYPE_DIRECTORIES;
export type Metadata = Record<string, unknown>;
export interface Document { metadata: Metadata; body: string }
export const isRecord = (value: unknown): value is Metadata => value !== null && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export const isActor = (value: unknown): value is string => typeof value === "string" && /^(?:[a-zA-Z][\w.-]*:\S+|[^\s/]+\/[^\s/]+)$/.test(value);

function assertSerializable(value: unknown, parents = new Set<object>(), depth = 0): void {
  if (depth > 64) throw new Error("Frontmatter nesting exceeds 64 levels.");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object") throw new Error("Frontmatter must contain JSON-compatible values.");
  if (parents.has(value)) throw new Error("Cyclic YAML aliases are not supported.");
  parents.add(value);
  for (const child of Object.values(value)) assertSerializable(child, parents, depth + 1);
  parents.delete(value);
}

export function parseDocument(raw: string): Document {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(raw);
  if (!opening) throw new Error("Missing YAML frontmatter opening delimiter.");
  const rest = raw.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Missing YAML frontmatter closing delimiter.");
  const metadata: unknown = YAML.parse(rest.slice(0, closing.index));
  if (!isRecord(metadata)) throw new Error("Frontmatter must be a YAML mapping.");
  assertSerializable(metadata);
  return { metadata, body: rest.slice(closing.index + closing[0].length) };
}

export function serializeDocument(document: Document): string {
  assertSerializable(document.metadata);
  return `---\n${YAML.stringify(document.metadata, null, 2).trimEnd()}\n---\n${document.body}`;
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60
    && (!m[7] || (Number(m[8]) < 24 && Number(m[9]) < 60)) && Number.isFinite(Date.parse(value));
}

export function validateMetadata(m: Metadata, now = new Date()): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (typeof m.type !== "string" || !Object.hasOwn(TYPE_DIRECTORIES, m.type)) errors.push("type: expected rule, principle, knowledge, procedure or decision.");
  for (const key of ["title", "description"]) {
    if (!nonempty(m[key]) || /[\r\n]/.test(String(m[key]))) errors.push(`${key}: expected a nonempty single-line string.`);
  }
  for (const [field, allowed] of [["status", ["draft", "stable", "deprecated"]], ["governance", ["constraint", "hold", "context"]]] as const) {
    if (m[field] !== undefined && !allowed.some(value => value === m[field])) errors.push(`${field}: expected ${allowed.join(" | ")}.`);
  }
  if (m.resource !== undefined && !nonempty(m.resource)) errors.push("resource: expected a nonempty reference.");
  for (const field of ["tags", "code_refs"]) {
    const value = m[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(nonempty)) { errors.push(`${field}: expected an array of nonempty strings.`); continue; }
    if (new Set(value).size !== value.length) errors.push(`${field}: entries must be unique.`);
    if (field === "code_refs" && value.some(ref => ref.startsWith("/") || /^[a-zA-Z]:/.test(ref) || ref.includes("\\") || ref.split("/").includes(".."))) errors.push("code_refs: use project-relative paths/globs without '..' or backslashes.");
  }
  function event(value: unknown, field: string, human = false) {
    if (!isRecord(value)) { errors.push(`${field}: expected {by, at}.`); return; }
    if (!isActor(value.by) || (human && !/^human:\S+$/.test(String(value.by)))) errors.push(`${field}.by: expected ${human ? "human:<id>" : "an actor identifier"}.`);
    if (!isTimestamp(value.at)) errors.push(`${field}.at: expected an ISO 8601 timestamp with timezone.`);
  }
  if (m.generated !== undefined) event(m.generated, "generated");
  if (m.verified !== undefined) {
    if (!Array.isArray(m.verified)) errors.push("verified: expected an array of human review events.");
    else m.verified.forEach((value, i) => {
      event(value, `verified[${i}]`, true);
      if (isRecord(value) && isTimestamp(value.at) && isRecord(m.generated) && isTimestamp(m.generated.at) && Date.parse(value.at) < Date.parse(m.generated.at)) warnings.push(`verified[${i}]: verification predates generated.at (superseded verification).`);
    });
  }
  if (m.sources !== undefined) {
    if (!Array.isArray(m.sources)) errors.push("sources: expected an array of source mappings.");
    else {
      const ids = new Set<string>();
      m.sources.forEach((source: unknown, i) => {
        if (!isRecord(source)) { errors.push(`sources[${i}]: expected a mapping.`); return; }
        if (!nonempty(source.resource)) errors.push(`sources[${i}].resource: required.`);
        for (const field of ["id", "title", "author"]) if (source[field] !== undefined && !nonempty(source[field])) errors.push(`sources[${i}].${field}: expected a nonempty string.`);
        if (nonempty(source.id)) { if (ids.has(source.id)) errors.push(`sources[${i}].id: duplicate ID.`); ids.add(source.id); }
        if (source.last_modified !== undefined && !isTimestamp(source.last_modified)) errors.push(`sources[${i}].last_modified: expected a timestamp with timezone.`);
        if (source.usage_count !== undefined && (typeof source.usage_count !== "number" || !Number.isSafeInteger(source.usage_count) || source.usage_count < 0)) errors.push(`sources[${i}].usage_count: expected a nonnegative integer.`);
      });
    }
  }
  if (m.stale_after !== undefined) {
    if (!isTimestamp(m.stale_after)) errors.push("stale_after: expected an ISO 8601 timestamp with timezone.");
    else if (Date.parse(m.stale_after) <= now.getTime()) warnings.push("stale_after: concept is stale and due for review.");
  }
  return { errors, warnings };
}
