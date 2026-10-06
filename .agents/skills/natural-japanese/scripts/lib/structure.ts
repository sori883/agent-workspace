import { templateHeadings } from "./catalogs.ts";
import { chars, counts, cv, documentLines, heading, mean } from "./text.ts";
import type { Line } from "./text.ts";
import { getTokenizer, properNoun, trimSymbols } from "./tokenizer.ts";
import type { Tokenize } from "./tokenizer.ts";

interface OutlineEntry { line: number; kind: "heading" | "lead" | "bullets"; level: number | null; text: string }

function summarizeHeadings(entries: OutlineEntry[], tokenize: Tokenize) {
  const lengths = entries.map(e => chars(e.text));
  const tokens = entries.map(e => trimSymbols(tokenize(e.text)));
  const signatures = tokens.map(ts => ts.filter(t => ["名詞", "動詞", "形容詞", "副詞", "接頭詞"].includes(t.pos)).map(t => t.pos).join("/")).filter(Boolean);
  const dominant = Math.max(0, ...Object.values(counts(signatures)));
  const templateHits = entries.flatMap(e => {
    const text = e.text.replace(/^[\s0-9０-９.．、,()（）【】\[\]#・-]+/, "").toLowerCase();
    const matched = templateHeadings.find(word => text.startsWith(word));
    return matched ? [{ line: e.line, text: e.text, matched }] : [];
  });
  const structural = entries.filter(e => /^\s*([0-9０-９]+[.).、]|[①-⑳])\s*\S/.test(e.text) || /^\s*[【\[［(（].+[】\]］)）]\s*$/.test(e.text) || /.+とは[?？]?\s*$/.test(e.text)).length;
  const ratio = (n: number) => entries.length ? Math.round(n / entries.length * 1000) / 1000 : 0;
  return { count: entries.length, length_mean: Math.round(mean(lengths) * 100) / 100, length_cv: Math.round(cv(lengths) * 1000) / 1000,
    nominal_ending_ratio: ratio(tokens.filter(ts => ts.at(-1)?.pos === "名詞").length), dominant_pos_signature_ratio: ratio(dominant), template_hits: templateHits, structural_pattern_ratio: ratio(structural) };
}

export async function outlineDocument(raw: string) {
  const tokenize = await getTokenizer(), lines = documentLines(raw), outline: OutlineEntry[] = [];
  let buffer: Line[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const first = buffer[0]!;
    if (first.kind === "bullets") outline.push({ line: first.no, kind: "bullets", level: null, text: `(箇条書き ${buffer.filter(l => l.kind === "bullets").length} 項目)` });
    else if (first.kind === "lead") {
      const text = first.visible.match(/^.*?[。！？]/)?.[0] ?? first.visible;
      outline.push({ line: first.no, kind: "lead", level: null, text: text.trim() });
    }
    buffer = [];
  };
  for (const line of lines) {
    if (["excluded", "blank", "table", "blockquote"].includes(line.kind)) { flush(); continue; }
    if (line.kind === "heading") { flush(); const h = heading(line.visible)!; outline.push({ line: line.no, kind: "heading", level: h[1]!.length, text: h[2]!.trim() }); continue; }
    const first = buffer[0];
    if (first && first.kind !== line.kind && !(first.kind === "bullets" && line.kind === "lead" && /^\s+\S/.test(line.visible))) flush();
    buffer.push(line);
  }
  flush();
  const headings = outline.filter(e => e.kind === "heading");
  const levels = [...new Set(headings.map(e => e.level!))].sort((a, b) => a - b);
  return { outline, heading_stats: { total_headings: headings.length,
    level_distribution: Object.fromEntries(levels.map(level => [level, headings.filter(h => h.level === level).length])),
    by_level: Object.fromEntries(levels.map(level => [level, summarizeHeadings(headings.filter(h => h.level === level), tokenize)])),
    overall: summarizeHeadings(headings, tokenize) } };
}

export async function termInventory(raw: string) {
  const tokenize = await getTokenizer();
  const lines = documentLines(raw).map(line => ({ ...line, text: ["lead", "heading"].includes(line.kind) ? line.text : "" }));
  const found = new Map<string, { first_line: number; offset: number }>();
  const register = (term: string, line: number, offset: number) => {
    const previous = found.get(term);
    if (!previous || line < previous.first_line || line === previous.first_line && offset < previous.offset) found.set(term, { first_line: line, offset });
  };
  for (const line of lines) {
    if (!line.text.trim()) continue;
    for (const hit of line.text.matchAll(/(?<![A-Za-z0-9])[A-Z][A-Za-z0-9]+(?![A-Za-z0-9])/g)) register(hit[0], line.no, hit.index);
    const tokens = tokenize(line.text);
    for (let i = 0; i < tokens.length; i++) {
      const first = tokens[i]!, katakana = /^[ァ-ヶー]+$/.test(first.surface);
      if (!katakana && !properNoun(first)) continue;
      let end = i + 1;
      while (end < tokens.length && tokens[end]!.start === tokens[end - 1]!.end && (katakana ? /^[ァ-ヶー]+$/.test(tokens[end]!.surface) : properNoun(tokens[end]!))) end++;
      const term = line.text.slice(first.start, tokens[end - 1]!.end);
      if (!katakana || chars(term) >= 3) register(term, line.no, first.start);
      i = end - 1;
    }
  }
  const offsets: number[] = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.text.length + 1; }
  const text = lines.map(l => l.text).join("\n");
  return [...found.entries()].sort((a, b) => a[1].first_line - b[1].first_line || a[1].offset - b[1].offset).map(([term, first]) => {
    const pos = offsets[first.first_line - 1]! + first.offset;
    const context = text.slice(Math.max(0, pos - 80), pos + term.length + 80).trim();
    return { term, first_line: first.first_line, count: text.split(term).length - 1,
      has_gloss_hint: /^[（(]/.test(text.slice(pos + term.length)) || ["とは", "と呼ぶ", "という", "、つまり"].some(marker => context.includes(marker)), context };
  });
}
