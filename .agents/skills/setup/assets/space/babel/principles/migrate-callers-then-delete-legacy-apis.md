---
type: principle
title: 呼び出し元を移行して旧APIを取り除く
description: 外部への互換性が不要で呼び出し元をまとめて移行できる内部APIの刷新では、同じ改修で呼び出し元を移行し、旧APIと不要な互換層を削除する。
governance: context
status: stable
tags:
  - 開発原則
sources:
  - resource: https://github.com/cursor/plugins/blob/032be146865d973682535de75f2287da438550bf/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md
    title: "pstack: migrate-callers-then-delete-legacy-apis"
generated:
  by: agent:codex
  at: 2026-09-20T12:35:56.835Z
---
# 呼び出し元を移行して旧APIを取り除く

## 適用条件

新しい内部APIを採用し、外部利用者への後方互換が不要で、呼び出し元をまとめて変更できるとき。

## 判断の指針

内部の呼び出し元が残っていることだけを理由に、旧APIを維持しない。新しい設計へ移行する改修の中で、呼び出し元と旧APIを一緒に整理する。

- 呼び出し元を洗い出し、全件を新しい契約へ移す。
- 移行後に旧APIと不要な互換経路を削除する。
- 一時的なアダプターは例外とし、必要な理由と削除の条件・期限を示す。
- テストは新しい契約を確認するものへ更新し、旧実装の細部だけを固定するテストは整理する。

外部利用者が互換性に依存するAPIや、同時移行できない公開インターフェースには、そのまま適用しない。互換性の約束と段階移行の必要性を確認する。
