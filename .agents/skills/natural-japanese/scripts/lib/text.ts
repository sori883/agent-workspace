import type { Token, Tokenize } from "./tokenizer.ts";

export type LineKind = "excluded" | "blank" | "heading" | "bullets" | "blockquote" | "table" | "lead";
export interface Line { no: number; raw: string; visible: string; text: string; kind: LineKind }
export interface Sentence { line: number; text: string; raw: string; tokens: Token[] }
export interface Finding {
  line: number; category: string; excerpt: string; severity: "info" | "warn" | "critical";
  detail: string; related_lines?: number[]; status?: "new" | "persisting";
}
export const chars = (text: string) => [...text].length;
export const prefix = (text: string, count: number) => [...text].slice(0, count).join("");
const blank = (text: string) => text.replace(/[^\n\r]/g, " ");
export const heading = (text: string) => /^\s*(#{1,6})(?:\s+|$)(.*?)(?:\s+#+)?\s*$/.exec(text);
export const listItem = (text: string) => /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/.test(text);

export function inlineText(text: string): string {
  return text.replace(/(`+)([^\n]*?)\1(?!`)/g, blank)
    .replace(/\]\((?:[^()\n]|\([^()\n]*\))*\)/g, value => "](" + " ".repeat(value.length - 3) + ")");
}

export function documentLines(raw: string): Line[] {
  let fence: string | undefined, frontmatter = false, comment = false;
  return raw.replace(/^\uFEFF/, " ").split(/\r?\n/).map((source, index) => {
    let visible = source;
    let kind: LineKind = "lead";
    if (index === 0 && /^\s*---\s*$/.test(source)) { frontmatter = true; kind = "excluded"; }
    else if (frontmatter) { if (/^(?:---|\.\.\.)\s*$/.test(source)) frontmatter = false; kind = "excluded"; }
    else if (fence) {
      const end = /^\s*(`{3,}|~{3,})\s*$/.exec(source)?.[1];
      if (end && end[0] === fence[0] && end.length >= fence.length) fence = undefined;
      kind = "excluded";
    } else {
      let cursor = 0, output = "";
      while (cursor < source.length) {
        if (comment) {
          const close = source.indexOf("-->", cursor);
          const end = close < 0 ? source.length : close + 3;
          output += blank(source.slice(cursor, end)); cursor = end;
          if (close >= 0) comment = false;
        } else {
          const start = source.indexOf("<!--", cursor);
          if (start < 0) { output += source.slice(cursor); break; }
          output += source.slice(cursor, start); cursor = start; comment = true;
        }
      }
      visible = output;
      const open = /^\s*(`{3,}|~{3,})/.exec(visible)?.[1];
      if (open) { fence = open; kind = "excluded"; }
      else if (!visible.trim()) kind = "blank";
      else if (heading(visible)) kind = "heading";
      else if (listItem(visible)) kind = "bullets";
      else if (/^\s*>/.test(visible)) kind = "blockquote";
      else if (/^\s*\|.*\|/.test(visible) || /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(visible)) kind = "table";
    }
    if (kind === "excluded") visible = blank(source);
    return { no: index + 1, raw: source, visible, text: inlineText(visible), kind };
  });
}

export function sentences(lines: Line[], tokenize: Tokenize): Sentence[] {
  return lines.filter(line => line.kind === "lead").flatMap(line => {
    const out: Sentence[] = [];
    for (const match of line.text.matchAll(/[^。！？]+/g)) {
      const offset = match.index + (match[0].length - match[0].trimStart().length);
      const text = match[0].trim();
      if (text) out.push({ line: line.no, text, raw: line.raw.slice(offset, offset + text.length), tokens: tokenize(text) });
    }
    return out;
  });
}

export function paragraphs(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  let current: Line[] = [];
  for (const line of lines) {
    if (line.kind === "lead" && line.text.trim()) current.push(line);
    else if (current.length) { out.push(current); current = []; }
  }
  if (current.length) out.push(current);
  return out;
}

export const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
export const stdev = (values: number[]) => { const m = mean(values); return Math.sqrt(mean(values.map(x => (x - m) ** 2))); };
export const cv = (values: number[]) => mean(values) ? stdev(values) / mean(values) : 0;
export function counts(values: string[]): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
export function finding(line: number, category: string, excerpt: string, severity: Finding["severity"], detail: string, related?: number[]): Finding {
  return { line, category, excerpt, severity, detail, ...(related ? { related_lines: [...new Set(related)].sort((a, b) => a - b) } : {}) };
}
