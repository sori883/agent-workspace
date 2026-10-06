---
type: principle
title: 検証できる最終状態へ向けて移行する
description: 段階と検証の区切りを明示した書き換え・移行を行うとき、目標の構造へ収束させ、一時的な不整合を作業単位の終わりで解消する。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-outcome-oriented-execution/SKILL.md
    title: "pstack: outcome-oriented-execution"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:56.140Z
---
# 検証できる最終状態へ向けて移行する

## 適用条件

段階と検証の区切りを明示した、計画的な書き換えや移行を行うとき。

## 判断の指針

途中の状態をすべて滑らかに見せるための使い捨ての互換コードを増やさず、意図した最終状態の整合性を優先する。

- 目標の構造と完了条件を先に定める。
- 一時的な不整合を許す場合は、その対象と期間、元へ戻せる範囲、解消を確認する段階を明示する。
- 移行中も、変更中の領域に対する有効な検証を続ける。
- 計画完了時には必要な静的検証と実行時の検証を行い、整合性を確認する。未解消の不整合を完了扱いしない。

一時的な不整合は、計画済み・局所的・可逆的な作業中に限定する。共有環境や公開済みの成果物を壊す許可とはしない。「検証可能な単位」の区切りは、不整合を解消して確認できる位置に置く。
