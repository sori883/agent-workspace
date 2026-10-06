---
type: principle
title: 新しい要件を前提に設計し直す
description: 既存設計へ新しい要件を組み込むとき、その要件が最初から存在した場合の構造を考えて段階的に反映する。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-redesign-from-first-principles/SKILL.md
    title: "pstack: redesign-from-first-principles"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:56.357Z
---
# 新しい要件を前提に設計し直す

## 適用条件

既存の設計へ、新しい要件や前提を組み込むとき。

## 判断の指針

既存の構造へ処理を継ぎ足す前に、「この要件を最初から知っていたら何を作るか」を考える。

- 影響するファイルと現在の設計を確認する。
- 新要件を中心に置いた構造と、現在の構造との差を明らかにする。
- 型、呼び出し元、文書、使用例、設計理由まで一貫して反映する。
- 全体像を考えたうえで、検証可能な小さな段階で届ける。

設計の見直しを、依頼されていない全面改修の許可にはしない。必要な変更とその影響を示し、認められた範囲で実施する。
