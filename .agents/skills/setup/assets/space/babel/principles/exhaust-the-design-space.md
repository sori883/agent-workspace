---
type: principle
title: 有力な設計案を具体化して比較する
description: 前例のないUI、複数の有力な構造、操作感が重要な判断で設計が明らかでないとき、異なる2〜3案を試作または具体化して比較する。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-exhaust-the-design-space/SKILL.md
    title: "pstack: exhaust-the-design-space"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:55.506Z
---
# 有力な設計案を具体化して比較する

## 適用条件

前例のないUI、複数の実現可能な構造、操作感が重要な製品判断などで、適切な設計が明らかでないとき。

## 判断の指針

一つの案を実装し切る前に、異なる構造の2〜3案を試作またはスケッチし、同じ基準で並べて比較する。最初の案の色や細部を変えただけでは、別案として数えない。

- 比較する判断軸を明らかにする。利用者の操作、制約、保守性、実測できる性能などを使う。
- 不確かな点を判定できる最小の試作に留める。
- 観測した結果から採用案と不採用の理由を示す。

既存の定型に従う機械的な実装、目標が明確な不具合修正やリファクタリング、制約によって実現可能な案が一つしかない変更では、比較用の試作を強制しない。読み取りだけの調査依頼では、既存資料による比較に留める。
