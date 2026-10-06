---
type: principle
title: 追加する前に不要なものを取り除く
description: 機能追加・リファクタリング・書き換えの順序を決めるとき、不要なコードや指示を先に除き、観測された用途に必要な構造を作る。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-subtract-before-you-add/SKILL.md
    title: "pstack: subtract-before-you-add"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:56.490Z
---
# 追加する前に不要なものを取り除く

## 適用条件

機能追加、リファクタリング、書き換えの作業順序を決めるとき。

## 判断の指針

複雑な構造へ追加する前に、不要な部分を除去して本質を見えるようにする。変更後は、同じか小さい公開範囲で、より単純で有用な設計を残す。

- 構築より除去を、磨き込みより必要最小限への整理を先に行う。
- 使われていないコード、重複した検証、内容のない参照先を取り除く。
- 観測された用途と仕様に基づいて設計し、根拠のない例外処理やパーサーを先回りして増やさない。
- プロンプトや手順でも重複した指示と過剰なテンプレートを減らす。独自の内容がない参照は、空の文書として残さない。

削除前に利用箇所と目的を確認する。必要な制約や既存利用者への契約を、不要と推定して消さない。
