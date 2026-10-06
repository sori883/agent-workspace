---
type: principle
title: 共有状態を分離してから排他制御を考える
description: 複数の処理主体が同じファイル・ブランチ・キー・状態を書き換える可能性があるとき、共有の除去を先に検討し、必要な共有だけを構造的に直列化する。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md
    title: "pstack: separate-before-serializing-shared-state"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:56.955Z
---
# 共有状態を分離してから排他制御を考える

## 適用条件

複数の処理主体が、同じファイル・ブランチ・キー・状態オブジェクトを書き換える可能性があるとき。

## 判断の指針

共有される可変状態を特定し、それが本当に一つの正本でなければならないかを確認する。

- 独立した事実を記録するだけなら、主体ごとに所有するファイル、キー、状態領域を分け、読み取りや報告の時点で統合する。
- 一つのJSONファイルの別々のフィールドを書く方式も、共有書き込みとして扱う。
- 一つの正本が必要な場合だけ、ロック、順序を決めた処理段階、単一の書き込み担当、原子的な比較・更新で直列化する。
- 注意書きや口頭の担当分けだけを、競合を防ぐ仕組みとして扱わない。

分離にブランチやworktreeが有効な場合でも、ユーザーの作業場所の指定に従う。worktreeを使わない場合は、ファイルの所有範囲や単一の書き込み担当で競合を防ぐ。
