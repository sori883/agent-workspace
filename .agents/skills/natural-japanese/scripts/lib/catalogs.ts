export const forbidden = [
  "と言えるでしょう", "と言えるだろう", "と言えます", "ということになるでしょう", "のではないでしょうか",
  "重要なのは", "大切なのは", "ポイントは", "結論から言うと", "結論として", "いかがでしたか", "いかがでしょうか",
  "まとめると", "総じて", "非常に重要", "極めて重要", "言うまでもなく", "言うまでもありません", "まさしく",
  "さて、", "それでは、", "このように", "このような中", "ここで注目したいのは", "見ていきましょう",
  "紹介していきます", "解説していきます", "深掘りしていきます", "一概には言えません", "個人差がありますが",
  "あくまで一例ですが", "正面から扱う", "正面から見る", "正面から書く", "正面から立てる", "正面から回収する",
  "不可欠", "核心的", "鍵となる", "根本的な", "多角的", "包括的", "総合的", "掘り下げる", "深掘りする",
  "言語化する", "について見ていく", "を探求する",
];
export const weakPhrases = new Set(["重要なのは", "このように", "不可欠", "ポイントは", "さて、"]);
export const translationPatterns = [
  /することができ(る|ます|た)/gu, /することが可能(です|だ|になる)/gu, /と言えるだろう/gu,
  /という点で/gu, /という観点(から|で)/gu, /にとって(重要|不可欠)/gu, /を持つ(こと|存在)/gu,
  /することによって/gu, /であることは間違いない/gu, /に他ならない/gu,
];
export const antithesisPatterns = [/ではなく、?.{0,30}/gu, /だけでなく.{0,10}も/gu];
export const conjunctions = ["しかし", "また", "そして", "そのため", "さらに", "つまり", "一方", "一方で", "このように", "なぜなら", "したがって", "ただし"];
export const abstractNouns = new Set(["側面", "観点", "重要性", "可能性", "あり方", "存在", "意味", "本質", "価値", "意義", "課題", "問題", "要素", "要因", "背景", "傾向", "姿勢", "視点", "概念", "特徴", "性質", "状況", "状態", "変化"]);
export const exampleMarkers = ["たとえば", "例えば", "実際に", "実際には", "具体的には", "具体例として", "一例として", "先日", "昨日", "現に", "実例として"];
export const transitiveVerbs = new Set(["もたらす", "示す", "意味する", "証明する", "生み出す", "反映する", "示唆する", "物語る", "浮き彫りにする", "後押しする"]);
export const templateHeadings = ["はじめに", "背景", "概要", "本記事について", "この記事について", "まとめと今後", "今後の展望", "今後の課題", "今後について", "まとめ", "おわりに", "終わりに", "さいごに", "最後に", "結論", "総括", "conclusion", "introduction", "summary"];
export const closingHeadings = ["まとめ", "おわりに", "終わりに", "さいごに", "最後に", "結論", "総括", "conclusion"];
export const experimentalCategories = new Set(["high_length_autocorrelation", "paragraph_lead_conjunction", "repeated_syntax_template", "english_syntax_cleft_because", "high_bold_density", "high_bullet_ratio", "boilerplate_heading", "numbered_phase_structure", "high_emoji_symbol_density"]);
export type Genre = "essay" | "tech" | "business";
export function profile(genre?: Genre) {
  return {
    nominalMinChars: genre === "essay" ? 1500 : genre ? 3000 : 2000,
    leadThreshold: genre === "essay" ? 5 : genre ? 7 : 6,
    antithesisCritical: genre === "tech" ? 0.045 : 0.03,
    sentenceMax: genre === "essay" ? 110 : 90,
    disabled: new Set(genre === "business" ? ["high_bullet_ratio", "high_bold_density", "boilerplate_heading", "numbered_phase_structure"] : []),
  };
}
