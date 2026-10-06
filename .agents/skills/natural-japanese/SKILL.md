---
name: natural-japanese
description: 日本語の文書を自然で読みやすく書く・直す。議事録、レポート、ガイド、企画メモ、スライド構成、記事の執筆・推敲、直訳調や定型的な言い回しの改善、書き換えを伴わない文章診断、本人の文体プロファイル作成に使う。Markdownの書式整理だけの依頼や、著者がAIかどうかの判定には使わない。
license: MIT
---

# natural-japanese

読者が理解・判断・行動しやすい日本語を書く。設計 → 執筆 → 機械検査 → 文脈での判断 → 再確認の順に進める。検出結果は修正候補であり、語句の一律禁止や著者判定として扱わない。事実、数値、引用、条件、留保、著者の意図を保持する。

## 依頼とモードを選ぶ

- **write**: 素材から新規に書く。読者、伝える結論、必要な根拠を決める。
- **rewrite（既定）**: 既存文章を直す。元の意味と文体を保ち、読む負担が減る箇所を選ぶ。
- **score**: 書き換えずに診断する。先に[診断手順](references/diagnose.md)を読む。
- **文体プロファイル**: 本人が求めた場合に、提供された文章3〜5本を[ひな形](assets/style-profile-template.md)で整理し、指定先へ保存する。本人の明示した好みと、文章から推測した傾向を分ける。標本が少なければ限界も記す。

**quickを既定**とし、一人でlintを1回、構成と読みやすさを通読する。変更したら再検査し、新たな問題がなければ終える。短い文書もlintを省略しない。

**full**は利用者が丁寧な確認を求めた場合や、対外文書・長文など追加レビューが有用な場合に使う。lint・outline・termsを実行し、構造・読みやすさ・文書の型を別々の観点で確認する。独立した担当を使える環境では三つのレビューを分担し、親が根拠を照合して「直す・残す」を決める。執筆は一人が全体のつながりを保つ。分担できなければ順番に確認し、独立レビューを実施したとは報告しない。

自然言語の依頼から選べる。たとえば「記事を書いて」はwrite、「自然な日本語にして」はrewrite、「直さずに診断して」はscore。モードの違いだけを理由に依頼の範囲を増やさない。

## 1. 書く前に決める

読者と目的を特定し、主メッセージを一文にする。見出しだけでも話が通る骨組みを作り、重要な節に説明を配分する。短い文書では会話内の簡単な整理でよい。

該当する文書の型だけを読む。

| 文書 | 参照する型 |
| --- | --- |
| 文字起こしからの議事録化・議事録 | [minutes](references/doctypes/minutes.md) |
| 調査・分析レポート | [report](references/doctypes/report.md) |
| ガイド・マニュアル | [guide](references/doctypes/guide.md) |
| リサーチ・企画・提案メモ | [memo](references/doctypes/memo.md) |
| スライド構成案 | [slide](references/doctypes/slide.md) |

記事・エッセイなどは型を無理に当てはめない。技術・ビジネス・エッセイの違いは[ジャンル別の指針](references/genre-notes.md)を参照する。

固有名詞・数値・実例が足りなければ、提供済みの資料を確認し、必要に応じて調査またはユーザーへの確認を行う。もっともらしい事実や体験を補わない。既存の`style-profile.md`または指定の文体資料があれば読む。

## 2. 執筆・推敲する

[文体の12原則](references/writing-constitution.md)を使う。結論を先に示し、主体と因果を明確にし、用語を読者に合わせて説明する。並列項目は箇条書き、経緯や理由はつながった文章にする。必要な留保を残す。

すべての見出し、文末、段落を同じ型に整えない。改稿前に、読者の得になる変更箇所を選ぶ。具体例は[before/after](references/examples.md)、素材の不足や修正の反復は[推敲手順](references/revision-guide.md)を参照する。

## 3. Bunで機械検査する

Bun 1.4.2以上を使う。初回は付属CLIが依存パッケージと日本語辞書を自身の`scripts/node_modules/`へ導入するため、ネットワーク接続と同ディレクトリへの書き込み権限が必要。利用先のpackage.jsonやlockは変更しない。

このSKILL.mdの実際の場所から`scripts/japanese.ts`の絶対パスを特定する。対象ファイルは利用先の作業ディレクトリを基準に指定する。

```sh
bun /absolute/path/to/natural-japanese/scripts/japanese.ts lint draft.md --json --genre business
bun /absolute/path/to/natural-japanese/scripts/japanese.ts lint draft.md --json --reading-load
bun /absolute/path/to/natural-japanese/scripts/japanese.ts outline draft.md --json
bun /absolute/path/to/natural-japanese/scripts/japanese.ts terms draft.md --json
```

コマンド、検出範囲、終了コード、前回結果との比較は[CLIの使い方](references/cli.md)を参照する。会話内の文章を検査するときは、自分で作った一時ファイルへ保存して渡す。Bunを実行できない場合は[手動チェック](references/manual-checklist.md)へ切り替え、機械検査が未実施であることを報告する。

## 4. 指摘を文脈で判断する

指摘ごとに「直す」または「残す・理由」を記録する。少数なら会話内で管理し、多数なら一時ディレクトリに台帳を置く。[推敲手順の対応表](references/revision-guide.md)から該当箇所を読み、[定型句](references/forbidden-patterns.md)・[翻訳調](references/translationese.md)の資料を必要な範囲で参照する。

構造レビューではoutlineから見出しと段落冒頭を読み、論旨、繰り返し、節の厚み、結論や次の行動の位置を確認する。議事録やスライドは箇条書きが多くlintの対象本文が少ないため、型との照合を重視する。

読みやすさは[一般原則](references/readability-principles.md)と[確認項目](references/readability-antipatterns.md)で、二重否定・主述・係り受け・語の重さから確認する。`--reading-load`の指摘はスコアやbaseline比較に入らない。termsの説明マーカーは手掛かりであり、用語の説明が十分かは読者に照らして判断する。

## 5. 再確認して渡す

修正したらlintを再実行し、新規の指摘を確認する。全指摘に判断がつき、修正が新たな問題を生んでいなければ通読して終える。同じ問題を2回直しても戻る場合は、理由を付けて残すか、文・段落の構造を見直す。検出ゼロを目的に文章を壊さない。

fullでは[6観点の最終確認](references/eval-rubric.md)を行い、改善点を具体的な本文と対応付ける。完成文と必要な変更説明を返す。scoreでは診断だけを返す。

不要になった自分の一時ファイルだけを片付ける。元文書、他者のファイル、利用者が保持を求めた記録は削除しない。
