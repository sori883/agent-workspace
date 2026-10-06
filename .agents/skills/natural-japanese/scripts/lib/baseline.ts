import { prefix } from "./text.ts";
import type { Finding } from "./text.ts";

const aggregate = new Set(["low_burstiness", "high_length_autocorrelation", "low_sentence_variance", "uniform_paragraph_structure", "low_lexical_diversity_ttr", "low_lexical_diversity_mtld", "nominal_ending"]);
const key = (item: { category: string; excerpt: string }) => JSON.stringify([item.category, aggregate.has(item.category) ? "" : prefix(item.excerpt.replace(/\s+/g, ""), 20)]);

export function compareBaseline(current: Finding[], input: unknown, warn: (message: string) => void = () => {}) {
  if (!input || typeof input !== "object" || !Array.isArray((input as { findings?: unknown }).findings)) {
    warn("baselineにfindings配列がないため、比較を省略します。"); return undefined;
  }
  const buckets = new Map<string, Record<string, unknown>[]>();
  let skipped = 0;
  for (const item of (input as { findings: unknown[] }).findings) {
    if (!item || typeof item !== "object" || typeof (item as Finding).category !== "string" || typeof (item as Finding).excerpt !== "string") { skipped++; continue; }
    const id = key(item as Finding);
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id)!.push(item as Record<string, unknown>);
  }
  if (skipped) warn(`baselineの不正な指摘${skipped}件を読み飛ばしました。`);
  for (const item of current) item.status = buckets.get(key(item))?.shift() ? "persisting" : "new";
  const resolved = [...buckets.values()].flat();
  return { summary: { resolved: resolved.length, new: current.filter(f => f.status === "new").length, persisting: current.filter(f => f.status === "persisting").length }, resolved };
}
