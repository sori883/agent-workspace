import { abstractNouns, antithesisPatterns, closingHeadings, conjunctions, exampleMarkers, experimentalCategories, forbidden, profile, translationPatterns, transitiveVerbs, weakPhrases } from "./catalogs.ts";
import type { Genre } from "./catalogs.ts";
import { chars, counts, cv, documentLines, finding, heading, mean, paragraphs, prefix, sentences, stdev } from "./text.ts";
import type { Finding, Line, Sentence } from "./text.ts";
import { contentToken, getTokenizer, properNoun, trimSymbols } from "./tokenizer.ts";
import type { Token, Tokenize } from "./tokenizer.ts";
import { readingLoad } from "./reading-load.ts";

export interface Options { genre?: Genre; experimental?: boolean; readingLoad?: boolean }
export interface Analysis {
  schema_version: number; engine: string;
  findings: Finding[];
  stats: Record<string, unknown> & { total_sentences: number; total_findings: number };
  score: { base: number | null; characters: number; reason?: string };
  reading_load?: { findings: Finding[]; stats: { total: number; sentences: number; by_category: Record<string, number> } };
}

function surfaceChecks(lines: Line[], ss: Sentence[], options: Options): Finding[] {
  const out: Finding[] = [], contrasts: { line: number; excerpt: string }[] = [];
  const inanimate = [/(これ|それ|この事実|そのこと)(は|が).{0,40}(もたらす|示す|意味する|証明する|生み出す|反映する)/gu, /.{0,20}(こと|事実)(は|が).{0,40}(もたらす|示す|意味する|証明する|生み出す|反映する)/gu];
  for (const line of lines.filter(l => l.kind === "lead")) {
    for (const phrase of forbidden) {
      const index = line.text.indexOf(phrase);
      if (index >= 0) out.push(finding(line.no, "forbidden_phrase", line.raw.slice(Math.max(0, index - 10), index + phrase.length + 10).trim(), weakPhrases.has(phrase) ? "info" : "warn", `定型句「${phrase}」。文脈に合うか確認する。`));
    }
    for (const pattern of translationPatterns) for (const hit of line.text.matchAll(pattern)) out.push(finding(line.no, "translationese", line.raw.slice(Math.max(0, hit.index - 10), hit.index + hit[0].length + 10).trim(), "info", "直訳調の言い回し。簡潔に表せるか確認する。"));
    for (const pattern of antithesisPatterns) for (const hit of line.text.matchAll(pattern)) contrasts.push({ line: line.no, excerpt: line.raw.slice(hit.index, hit.index + hit[0].length) });
    for (const pattern of inanimate) for (const hit of line.text.matchAll(pattern)) out.push(finding(line.no, "english_syntax_inanimate_subject", line.raw.slice(hit.index, hit.index + hit[0].length), "info", "抽象的な主語と他動詞の組み合わせ。主体を明確にできるか確認する。"));
  }
  if (contrasts.length >= 3) {
    const ratio = ss.length ? contrasts.length / ss.length : 0;
    const severity = ratio < 0.02 ? "info" : ratio >= profile(options.genre).antithesisCritical ? "critical" : "warn";
    for (const hit of contrasts) out.push(finding(hit.line, "antithesis_repetition", hit.excerpt, severity, `否定から肯定への対比が${contrasts.length}回。総文数に対する比率${(ratio * 100).toFixed(1)}%。`, contrasts.map(h => h.line)));
  }
  for (let i = 1; i < ss.length; i++) if (/^(それ|これ|この)は.{0,60}(である|だ)$/.test(ss[i - 1]!.text) && /^(なぜなら|というのも)/.test(ss[i]!.text)) out.push(finding(ss[i - 1]!.line, "english_syntax_cleft_because", `${ss[i - 1]!.raw}。${ss[i]!.raw}`, "warn", "「それは〜だ。なぜなら〜」型が自然か確認する。"));
  const lengths = ss.map(s => chars(s.text));
  if (lengths.length >= 5 && mean(lengths) > 0 && cv(lengths) < 0.25) out.push(finding(ss[0]!.line, "low_sentence_variance", `文数=${lengths.length}, 平均文長=${mean(lengths).toFixed(1)}字, 変動係数=${cv(lengths).toFixed(3)}`, "warn", "文の長さがそろっている。必要な説明の厚みとリズムを確認する。"));
  return out;
}

function morphChecks(ss: Sentence[]): Finding[] {
  const out: Finding[] = [];
  for (const sentence of ss) {
    const ts = sentence.tokens;
    let skip = -1;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (t.surface === "こと" && t.pos === "名詞" && ts[i + 1]?.pos === "助詞" && ["が", "は"].includes(ts[i + 1]!.surface) && ts[i + 2]?.pos === "動詞" && /^(でき|出来)/.test(ts[i + 2]!.surface)) out.push(finding(sentence.line, "translationese_morph", sentence.raw.slice(ts[Math.max(0, i - 4)]!.start, ts[i + 2]!.end), "info", "「こと＋が/は＋できる」型。冗長でないか確認する。"));
      if (i <= skip) continue;
      let end = i;
      let subject = ["これ", "それ", "あれ", "それら"].includes(t.surface) || t.pos === "名詞" && ["こと", "事実", "の"].includes(t.surface);
      if (!subject && ["この事実", "そのこと"].includes(t.surface + (ts[i + 1]?.surface ?? ""))) { subject = true; end = i + 1; }
      if (!subject) continue;
      skip = end;
      if (ts[end + 1]?.pos !== "助詞" || !["は", "が"].includes(ts[end + 1]!.surface)) continue;
      for (let k = end + 2; k < ts.length; k++) {
        const current = ts[k]!;
        const compound = (ts[k - 1]?.surface ?? "") + current.base;
        if (current.pos === "動詞" && (transitiveVerbs.has(current.base) || transitiveVerbs.has(compound))) {
          out.push(finding(sentence.line, "inanimate_subject_morph", sentence.raw.slice(ts[Math.max(0, i - 3)]!.start, current.end), "info", "抽象的な主語に他動詞的な述語が続く。直訳調か文脈で判断する。")); break;
        }
      }
    }
  }
  return out;
}

function moraLength(tokens: Token[]) {
  return tokens.reduce((total, t) => total + [...t.reading].filter((char, i) => !i || !"ァィゥェォャュョヮ".includes(char)).length, 0);
}

export function mtld(words: string[]): number | null {
  if (words.length < 20) return null;
  const oneDirection = (seq: string[]) => {
    let factors = 0, length = 0;
    let kinds = new Set<string>();
    for (const word of seq) {
      kinds.add(word); length++;
      if (kinds.size / length <= 0.72) { factors++; kinds = new Set(); length = 0; }
    }
    if (length) factors += Math.min((1 - kinds.size / length) / 0.28, 1);
    return factors ? seq.length / factors : seq.length;
  };
  return (oneDirection(words) + oneDirection([...words].reverse())) / 2;
}

function statisticalChecks(lines: Line[], ss: Sentence[], tokenize: Tokenize, options: Options) {
  const out: Finding[] = [], selected = profile(options.genre);
  const pp = paragraphs(lines), lengths = ss.map(s => chars(s.raw)), totalChars = lengths.reduce((a, b) => a + b, 0);
  const nominal = ss.filter(s => trimSymbols(s.tokens).at(-1)?.pos === "名詞").length;
  if (ss.length >= 5 && totalChars >= selected.nominalMinChars && !nominal) out.push(finding(ss.at(-1)!.line, "nominal_ending", `体言止め0件（全${ss.length}文、約${totalChars}字）`, "info", "長い本文に体言止めがない。文書の種類に合う語尾か確認し、数合わせで変更しない。"));
  const conj = pp.filter(p => conjunctions.some(c => p[0]!.text.trimStart().startsWith(c)));
  const sentenceCounts = pp.map(p => p.reduce((sum, l) => sum + l.text.split(/[。！？]/).filter(t => t.trim()).length, 0));
  if (pp.length >= 3 && conj.length / pp.length >= 0.3) for (const p of conj) out.push(finding(p[0]!.no, "paragraph_lead_conjunction", prefix(p[0]!.raw, 40), "info", `段落頭の接続詞率${(conj.length / pp.length * 100).toFixed(1)}%。接続を言葉だけで補っていないか確認する。`, conj.map(p => p[0]!.no)));
  if (pp.length >= 4 && cv(sentenceCounts) < 0.15) out.push(finding(1, "uniform_paragraph_structure", `段落数=${pp.length}, 各段落の文数=${sentenceCounts.join(",")}`, "info", "段落の文数がそろっている。内容に応じた厚みがあるか確認する。"));

  const rhythm: Record<string, number | null> = {};
  if (ss.length >= 6) {
    const values = ss.map(s => moraLength(s.tokens)), average = mean(values), sd = stdev(values);
    const burstiness = sd + average ? (sd - average) / (sd + average) : 0;
    const xs = values.slice(0, -1), ys = values.slice(1);
    const correlation = xs.length >= 4 && stdev(xs) && stdev(ys) ? mean(xs.map((x, i) => (x - mean(xs)) * (ys[i]! - mean(ys)))) / (stdev(xs) * stdev(ys)) : null;
    Object.assign(rhythm, { mora_mean: average, mora_stdev: sd, burstiness, length_autocorrelation_lag1: correlation });
    if (burstiness < -0.24) out.push(finding(ss[0]!.line, "low_burstiness", `burstiness=${burstiness.toFixed(3)}（モーラ近似長の平均=${average.toFixed(1)}）`, "warn", "文の長短のメリハリが乏しい可能性。音読して確かめる。"));
    if (correlation !== null && correlation > 0.6) out.push(finding(ss[0]!.line, "high_length_autocorrelation", `lag-1自己相関=${correlation.toFixed(3)}`, "info", "隣接する文の長さが強く相関している。"));
  }
  const leads = ss.flatMap(s => { const t = trimSymbols(s.tokens); return t.length >= 2 ? [{ s, key: t[0]!.surface + t[1]!.surface }] : []; });
  for (const [key, count] of Object.entries(counts(leads.map(l => l.key)))) if (count >= selected.leadThreshold) {
    const matches = leads.filter(l => l.key === key);
    for (const { s } of matches) out.push(finding(s.line, "repeated_sentence_lead", prefix(s.raw, 20), "info", `文頭「${key}」が${count}回反復。意図した反復や用語の統一なら残す。`, matches.map(m => m.s.line)));
  }
  const signatures = ss.flatMap(s => { const t = trimSymbols(s.tokens).slice(0, 4); return t.length === 4 ? [{ s, key: t.map(t => t.pos).join("/") }] : []; });
  const top = Object.entries(counts(signatures.map(s => s.key))).sort((a, b) => b[1] - a[1])[0];
  const ngram = { lead_pos_4gram_top: signatures.length >= 6 ? top?.[0] ?? null : null, lead_pos_4gram_ratio: signatures.length >= 6 && top ? top[1] / signatures.length : null };
  if (ngram.lead_pos_4gram_ratio !== null && ngram.lead_pos_4gram_ratio >= 0.4) {
    const matches = signatures.filter(s => s.key === top![0]);
    for (const { s } of matches) out.push(finding(s.line, "repeated_syntax_template", prefix(s.raw, 20), "info", `文頭品詞の型「${top![0]}」が反復している。`, matches.map(m => m.s.line)));
  }
  const words = ss.flatMap(s => s.tokens.filter(contentToken).map(t => t.base));
  const enough = totalChars >= 4000 && words.length >= 30;
  const ttr = enough ? new Set(words).size / words.length : null, diversity = enough ? mtld(words) : null;
  if (ttr !== null && ttr < 0.45) out.push(finding(ss[0]!.line, "low_lexical_diversity_ttr", `TTR=${ttr.toFixed(3)}`, "info", "内容語の種類が少ない。用語の統一を壊さず、説明の反復を確認する。"));
  if (diversity !== null && diversity < 40) out.push(finding(ss[0]!.line, "low_lexical_diversity_mtld", `MTLD=${diversity.toFixed(1)}`, "info", "文書長を考慮した語彙の多様性が低い。必要な用語まで置き換えない。"));
  let evaluated = 0, fired = 0;
  for (const para of pp) {
    const text = para.map(l => l.text).join("\n");
    if (chars(text) < 80) continue;
    const content = tokenize(text).filter(contentToken);
    if (content.length < 15) continue;
    evaluated++;
    const score = (content.filter(properNoun).length + [...text.matchAll(/[0-9０-９]+/g)].length - content.filter(t => t.pos === "名詞" && abstractNouns.has(t.base)).length * 1.5) / content.length + (exampleMarkers.some(m => text.includes(m)) ? 0.1 : 0);
    if (score < -0.15) { fired++; out.push(finding(para[0]!.no, "low_specificity", prefix(para[0]!.raw.trim(), 40), "info", `具体性の目安=${score.toFixed(3)}。抽象語に偏っている可能性。事実・数値・実例の不足を確認し、捏造で補わない。`)); }
  }
  return { findings: out, stats: {
    total_sentences: ss.length, nominal_ending_count: nominal, nominal_ending_ratio: ss.length ? nominal / ss.length : 0,
    total_paragraphs: pp.length, paragraph_lead_conjunction_count: conj.length, paragraph_lead_conjunction_ratio: pp.length ? conj.length / pp.length : 0,
    paragraph_sentence_counts: sentenceCounts, paragraph_sentence_count_cv: pp.length >= 4 ? cv(sentenceCounts) : null,
    rhythm, ngram, lexical_diversity: { ttr, mtld: diversity, content_token_count: words.length, doc_char_count: totalChars, skipped_too_short: totalChars < 4000 },
    low_specificity: { paragraphs_evaluated: evaluated, paragraphs_fired: fired },
  } };
}

function structuralChecks(lines: Line[]) {
  const visible = lines.filter(l => !["excluded", "blockquote", "table"].includes(l.kind));
  const text = visible.map(l => l.text).join("\n"), length = chars(text) || 1;
  const nonBlank = visible.filter(l => l.text.trim()), bullets = nonBlank.filter(l => l.kind === "bullets");
  const bold = visible.flatMap(l => [...l.text.matchAll(/\*\*[^*\n]+\*\*/g)].map(() => l.no));
  const phases = visible.flatMap(l => [...l.text.matchAll(/(フェーズ|ステップ|段階|ステージ)\s*[0-9０-９]/g)].map(() => l.no));
  const emoji = visible.flatMap(l => [...l.text.matchAll(/[\u{1F300}-\u{1FAFF}☀-➿⭐✅❌❗❓]/gu)].map(() => l.no));
  const boilerplate = visible.filter(l => l.kind === "heading" && closingHeadings.some(word => (heading(l.text)?.[2] ?? "").toLowerCase().startsWith(word)));
  const out: Finding[] = [];
  const add = (line: number, category: string, excerpt: string, detail: string) => out.push(finding(line, category, excerpt, "info", detail));
  if (bold.length >= 3 && bold.length / length * 1000 >= 3) add(bold[0]!, "high_bold_density", `太字${bold.length}箇所`, "強調が多い。読み手が核を選べるか確認する。");
  if (nonBlank.length >= 10 && bullets.length / nonBlank.length >= 0.35) out.push(finding(bullets[0]!.no, "high_bullet_ratio", `箇条書き${bullets.length}/${nonBlank.length}行`, "info", "箇条書きの比率が高い。説明や因果まで列挙していないか確認する。", bullets.map(l => l.no)));
  for (const line of boilerplate) add(line.no, "boilerplate_heading", line.raw.trim(), "定型的な結びの見出し。内容を探す手掛かりになるか確認する。");
  if (phases.length >= 3) add(phases[0]!, "numbered_phase_structure", `番号付き段階表現${phases.length}回`, "段階の区切りが内容に合うか確認する。");
  if (emoji.length >= 3 && emoji.length / length * 1000 >= 2) add(emoji[0]!, "high_emoji_symbol_density", `絵文字・装飾記号${emoji.length}箇所`, "装飾の密度が高い。文書の用途に合うか確認する。");
  return { findings: out, stats: { bold_span_count: bold.length, bold_per_1000_chars: bold.length / length * 1000, bullet_line_count: bullets.length, non_blank_line_count: nonBlank.length, boilerplate_heading_count: boilerplate.length, numbered_phase_hit_count: phases.length, emoji_symbol_count: emoji.length, emoji_symbol_per_1000_chars: emoji.length / length * 1000 } };
}

export async function analyze(raw: string, options: Options = {}): Promise<Analysis> {
  const tokenize = await getTokenizer(), lines = documentLines(raw), ss = sentences(lines, tokenize);
  const stats = statisticalChecks(lines, ss, tokenize, options), structure = structuralChecks(lines), selected = profile(options.genre);
  const findings = [...surfaceChecks(lines, ss, options), ...morphChecks(ss), ...stats.findings, ...structure.findings]
    .filter(f => (options.experimental || !experimentalCategories.has(f.category)) && !selected.disabled.has(f.category))
    .sort((a, b) => a.line - b.line);
  const bodyChars = ss.reduce((n, s) => n + chars(s.text.replace(/\s+/g, "")), 0), totalChars = chars(raw);
  const penalty = findings.reduce((n, f) => n + ({ critical: 8, warn: 4, info: 0.5 })[f.severity], 0) * 1000 / Math.max(totalChars, 1000);
  const result: Analysis = {
    schema_version: 1, engine: "kuromoji-0.1.2", findings,
    stats: { ...stats.stats, total_findings: findings.length, by_category: counts(findings.map(f => f.category)), genre: options.genre ?? null, experimental: options.experimental ?? false, structural: structure.stats },
    score: bodyChars < 100 ? { base: null, characters: totalChars, reason: "解析対象の本文が100字未満のため採点しません。" } : { base: Math.round(Math.max(100 - penalty, 20) * 10) / 10, characters: totalChars },
  };
  if (options.readingLoad) { const findings = readingLoad(ss, selected.sentenceMax); result.reading_load = { findings, stats: { total: findings.length, sentences: ss.length, by_category: counts(findings.map(f => f.category)) } }; }
  return result;
}
