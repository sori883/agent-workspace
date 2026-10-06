import { posix } from "node:path";
import { SetupError } from "./model.ts";

function utf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new SetupError("INDEX_CONFLICT", "Shared index must be valid UTF-8");
  return text;
}
interface Row { line: string; number: number }
function rows(text: string): Map<string, Row[]> {
  const result = new Map<string, Row[]>();
  const original = text.split(/\r?\n/);
  let fence = "", length = 0;
  const visible = text.replace(/<!--[^]*?-->/g, comment => comment.replace(/[^\r\n]/g, " "));
  for (const [number, line] of visible.split(/\r?\n/).entries()) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) { fence = marker[1]![0]!; length = marker[1]!.length; }
      else if (marker[1]![0] === fence && marker[1]!.length >= length && !marker[2]!.trim()) fence = "";
      continue;
    }
    if (fence) continue;
    if (line.includes("<!--")) throw new SetupError("INDEX_CONFLICT", "Shared index has an unclosed HTML comment");
    const link = /^ {0,3}[-*+] \[(?:\\.|[^\]\\])*\]\(<?([^\s>]+?\.md(?:[?#][^\s>)]*)?)>?(?:\s+"[^"]*")?\)/.exec(line);
    if (!link) continue;
    let path = link[1]!.split(/[?#]/)[0]!;
    try { path = decodeURIComponent(path); } catch { continue; }
    const key = posix.normalize(path), found = result.get(key) ?? [];
    found.push({ line: original[number]!, number }); result.set(key, found);
  }
  if (fence) throw new SetupError("INDEX_CONFLICT", "Shared index has an unclosed code fence");
  return result;
}
function frontmatter(text: string): { header: string; version?: unknown } | undefined {
  const match = /^\uFEFF?---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    if (/^\uFEFF?---(?:\r?\n|$)/.test(text)) throw new SetupError("INDEX_CONFLICT", "Shared index has incomplete frontmatter");
    return;
  }
  let value: unknown;
  try { value = Bun.YAML.parse(match[1]!); } catch { throw new SetupError("INDEX_CONFLICT", "Shared index has invalid frontmatter"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SetupError("INDEX_CONFLICT", "Shared index frontmatter must be a mapping");
  return { header: match[0], version: (value as Record<string, unknown>).okf_version };
}

export function mergeIndex(source: Buffer, current: Buffer | null, previous?: string): Buffer {
  const incoming = utf8(source), incomingRows = rows(incoming), sourceHeader = frontmatter(incoming);
  for (const [path, entries] of incomingRows) if (entries.length !== 1) throw new SetupError("INDEX_CONFLICT", `Incoming index repeats ${path}`);
  if (current === null) return source;
  let text = utf8(current);
  const currentHeader = frontmatter(text);
  if (sourceHeader?.version !== undefined) {
    if (currentHeader?.version !== undefined && currentHeader.version !== sourceHeader.version) throw new SetupError("INDEX_CONFLICT", "Shared index OKF version differs from the incoming bundle");
    if (!currentHeader) text = sourceHeader.header + "\n" + text;
    else if (currentHeader.version === undefined) text = text.replace(/^(\uFEFF?---\r?\n)/, `$1okf_version: ${JSON.stringify(sourceHeader.version)}\n`);
  }
  const existing = rows(text), baseline = rows(previous ?? ""), lines = text.split(/\r?\n/), additions: string[] = [];
  for (const [path, entries] of incomingRows) {
    const wanted = entries[0]!.line, found = existing.get(path);
    if (!found) { additions.push(wanted); continue; }
    const before = baseline.get(path)?.[0]?.line;
    if (before === undefined || before.trim() === wanted.trim()) continue;
    for (const row of found) {
      if (row.line.trim() === wanted.trim()) continue;
      if (row.line.trim() !== before.trim()) throw new SetupError("INDEX_CONFLICT", `Both the local and incoming index changed the listing for ${path}`);
      lines[row.number] = wanted;
    }
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  text = lines.join(newline);
  if (additions.length) text += (text && !text.endsWith("\n") ? newline : "") + additions.join(newline) + newline;
  return Buffer.from(text);
}
