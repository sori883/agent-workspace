import { chars, finding, prefix } from "./text.ts";
import type { Finding, Sentence } from "./text.ts";
import { isSymbol, properNoun } from "./tokenizer.ts";
import type { Token } from "./tokenizer.ts";

function nounEnding(segment: Token[]) {
  let i = segment.length;
  while (i > 0 && isSymbol(segment[i - 1]!)) {
    if (/[）)」』】］\]]/.test(segment[i - 1]!.surface)) {
      let depth = 1, j = i - 1;
      while (j > 0 && depth) {
        j--;
        if (/[）)」』】］\]]/.test(segment[j]!.surface)) depth++;
        else if (/[（(「『【［\[]/.test(segment[j]!.surface)) depth--;
      }
      i = j;
    } else i--;
  }
  return i > 0 && segment[i - 1]!.pos === "名詞";
}

function nounRun(tokens: Token[]) {
  const bounds: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) if (tokens[i]!.surface === "、") { bounds.push([start, i]); start = i + 1; }
  bounds.push([start, tokens.length]);
  let run: [number, number][] = [], best: { start: number; end: number; items: number } | undefined;
  bounds.forEach(([s, e], i) => {
    if (e > s && nounEnding(tokens.slice(s, e))) run.push([s, e]); else run = [];
    if (run.length >= 2 && bounds[i + 1] && (!best || run.length + 1 > best.items)) best = { start: run[0]![0], end: bounds[i + 1]![1], items: run.length + 1 };
  });
  return best;
}

export function readingLoad(sentences: Sentence[], maximum: number): Finding[] {
  const out: Finding[] = [];
  for (const sentence of sentences) {
    const { text, tokens, line } = sentence;
    const add = (category: string, excerpt: string, detail: string) => out.push(finding(line, category, excerpt, "info", detail));
    const length = chars(text.replace(/\s{2,}/g, " ").trim());
    if (length > maximum) add("sentence_too_long", prefix(sentence.raw, 40), `一文が${length}字（目安${maximum}字）。一文一義と主述の対応を確認する。`);
    for (const hit of text.matchAll(/[一-鿿々]{7,}/gu)) {
      if (!tokens.some(t => t.end > hit.index && t.start < hit.index + hit[0].length && properNoun(t))) add("kanji_run", hit[0], "漢字が7字以上連続している。語の切れ目が読めるか確認する。");
    }
    const run = nounRun(tokens);
    if (run && length >= (run.items <= 3 ? 80 : 50)) add("buried_list", prefix(tokens.slice(run.start, run.end).map(t => t.surface).join(""), 40), `同格の名詞句が${run.items}個並ぶ。並列関係を読み取りやすくできるか確認する。`);
    const punctuationBetween = (a: number, b: number) => tokens.slice(a + 1, b).some(isSymbol);
    const negatives = tokens.flatMap((t, i) => ["助動詞", "形容詞"].includes(t.pos) && ["ない", "無い", "ぬ", "ず", "ん"].includes(t.base) ? [i] : []);
    for (let i = 1; i < negatives.length; i++) {
      const a = negatives[i - 1]!, b = negatives[i]!;
      const span = tokens.slice(a, b + 1).map(t => t.surface).join("");
      if (b - a <= 6 && !punctuationBetween(a, b) && !/(といけ|とだめ|とダメ|ばならな|ばなりま|ばいけな|てはならな|てはなりま|てはいけな|ざるを得|ざるをえ)/.test(span) && !/^(?:ない|なけれ|なく)(?:と(?!は)|ば|ければ)/.test(span)) {
        add("double_negative", span, "否定が二重に掛かる可能性。肯定に直す場合も真偽と留保を保つ。"); break;
      }
    }
    const no = tokens.flatMap((t, i) => t.surface === "の" && t.pos === "助詞" && ["連体化", "格助詞"].includes(t.detail) ? [i] : []);
    for (let i = 2; i < no.length; i++) {
      const a = no[i - 2]!, b = no[i - 1]!, c = no[i]!;
      if (b - a <= 3 && c - b <= 3 && !punctuationBetween(a, c)) {
        add("no_chain", tokens.slice(a, c + 1).map(t => t.surface).join(""), "名詞をつなぐ「の」が3連以上ある。関係を動詞で表せるか確認する。"); break;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
