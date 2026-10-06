import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { analyze } from "./lib/lint.ts";
import type { Options } from "./lib/lint.ts";
import { compareBaseline } from "./lib/baseline.ts";
import { outlineDocument, termInventory } from "./lib/structure.ts";
import type { Finding } from "./lib/text.ts";

const help = `Usage: bun japanese.ts <lint|outline|terms|score> <file> [options]
  --json                    JSONで出力
  --genre essay|tech|business 文書の種類（lint / score）
  --baseline previous.json  前回のlint結果と比較（lint）
  --reading-load            読解負荷を別欄に出力（lint / score）
  --experimental            静的な実験検出器も含める（lint）
  --help                    この説明を表示

UTF-8のMarkdown・テキストを読み取り、書き換えません。
指摘の有無にかかわらず正常終了は0、入力・実行エラーは1です。
scoreは機械ベースの参考点です。著者やAIの使用を判定しません。`;

async function readText(path: string) {
  if (!(await stat(path)).isFile()) throw new Error(`ファイルを指定してください: ${path}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
}
function printFindings(findings: Finding[]) {
  for (const f of findings) process.stdout.write(`L${f.line} [${f.severity}] ${f.category}${f.status ? ` (${f.status})` : ""}\n  ${f.excerpt}\n  ${f.detail}${f.related_lines ? ` 対応行: ${f.related_lines.join(", ")}` : ""}\n`);
}

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
    json: { type: "boolean" }, genre: { type: "string" }, baseline: { type: "string" }, "reading-load": { type: "boolean" }, experimental: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) process.stdout.write(help + "\n");
  else {
    const [command, file] = positionals;
    if (positionals.length !== 2 || !["lint", "outline", "terms", "score"].includes(command!)) throw new Error(help);
    if (values.genre && !["essay", "tech", "business"].includes(values.genre)) throw new Error("--genreはessay、tech、businessから選んでください。");
    if (command !== "lint" && (values.baseline !== undefined || values.experimental !== undefined)) throw new Error("--baselineと--experimentalはlintでのみ使えます。");
    if (["outline", "terms"].includes(command!) && (values.genre !== undefined || values["reading-load"] !== undefined)) throw new Error("--genreと--reading-loadはlintまたはscoreで使ってください。");
    const raw = await readText(file!);
    if (command === "outline") {
      const result = await outlineDocument(raw);
      if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else { for (const e of result.outline) process.stdout.write(`L${e.line} ${e.kind === "heading" ? "#".repeat(e.level!) + " " : ""}${e.text}\n`); process.stdout.write(`見出し統計: ${JSON.stringify(result.heading_stats)}\n`); }
    } else if (command === "terms") {
      const terms = await termInventory(raw);
      if (values.json) process.stdout.write(JSON.stringify({ terms }, null, 2) + "\n");
      else { process.stdout.write("説明の手掛かりは、説明済みの判定ではありません。\n"); for (const t of terms) process.stdout.write(`L${t.first_line} ${t.term} (${t.count}回、説明の手掛かり: ${t.has_gloss_hint ? "あり" : "なし"})\n  ${t.context}\n`); }
    } else {
      const options: Options = { genre: values.genre as Options["genre"], experimental: values.experimental, readingLoad: values["reading-load"] };
      const result = await analyze(raw, options);
      let baseline;
      if (values.baseline) baseline = compareBaseline(result.findings, JSON.parse(await readText(values.baseline)), message => process.stderr.write(`警告: ${message}\n`));
      const output = { file, ...result, ...(baseline ? { baseline: { file: values.baseline, ...baseline } } : {}) };
      if (values.json) process.stdout.write(JSON.stringify(output, null, 2) + "\n");
      else {
        if (command === "score") process.stdout.write(result.score.base === null ? `${result.score.reason}\n` : `自然度の機械ベース: ${result.score.base}/100（高いほど検出された癖が少ない。著者判定ではありません）\n`);
        process.stdout.write(`検出件数: ${result.findings.length}\n`); printFindings(result.findings);
        if (baseline) process.stdout.write(`前回比較: 解消${baseline.summary.resolved} / 新規${baseline.summary.new} / 継続${baseline.summary.persisting}\n`);
        if (result.reading_load) { process.stdout.write("読解負荷（スコアとbaselineには含めません）\n"); printFindings(result.reading_load.findings); }
      }
    }
  }
} catch (error) {
  process.stderr.write(`natural-japanese: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
