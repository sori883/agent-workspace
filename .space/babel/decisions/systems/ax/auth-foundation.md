---
type: decision
title: 認証窓口をKeycloakへ集約し内部利用者IDで会話を所有する
description: メールとパスキーの認証基盤、将来IdP連携、用途別DBと既存receiptの所有権を分担する未実装の設計
status: draft
governance: context
code_refs: 
  - docs/auth-foundation.md
  - web/app/lib/security.server.ts
  - web/api/app.ts
  - ax-local/chat.py
sources: 
  - resource: docs/auth-foundation.md
  - resource: .space/tasks/ax-auth/task.md
  - resource: https://www.keycloak.org/server/db
  - resource: https://www.keycloak.org/docs/latest/server_admin/index.html
  - resource: "https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability"
generated: 
  by: agent:codex
  at: 2026-10-06T06:25:04.463Z
---
# チャットの認証基盤の構成

2026-10-06の概略設計。利用者はログイン・ログアウト、未ログイン時の利用拒否、自分の会話だけを扱う範囲を了承した。初期方式はメールアドレス＋パスワードとパスキー、将来のMicrosoft Entra ID・Amazon Cognito利用を想定する。設計は採用済みだが、認証コードとDBは未実装である。詳細と実装前の残件は `docs/auth-foundation.md`、比較・確認の記録は `.space/tasks/ax-auth/task.md`。

## 責務と保存先

初期はKeycloakを共通認証窓口とし、外部IdPはその背後へ接続する構造を土台にした。アプリが各IdPへ直接接続する別案から、内部利用者IDと `(issuer, subject)` の対応表を取り込む。複数IdPの直接接続は初期実装へ含めない。認証方式の追加を集約しつつ、Keycloak自体を将来置き換える際に会話所有権を直接書き換えずに済むようにするためである。

PostgreSQLは認証用とアプリ用のDB・接続権限を分け、初期は1インスタンスで構成できる。認証用DBはKeycloakだけが扱う。アプリ用DBは内部利用者・外部ID対応・BFFセッションを保存し、パスワードやパスキーの秘密鍵は保持しない。共通APIはトークンを検証して内部利用者を確定し、Pythonへ渡す。

会話本文・費用・実行状態は既存receiptと成果物を正本に維持する。新規受付時に内部利用者IDをownerとして原子的に保存し、一覧・詳細・継続送信・成果物・復旧・同キー再送すべてで照合する。会話所有権をアプリDBへ二重登録しない。本人確認には発行元とsubjectを使い、メールアドレス一致だけで統合しない。

## 互換性と復旧

ownerなしの既存データは保存を維持し、通常のWeb利用者には公開しない。最初のログイン者へ自動割当しない。必要なデータの引き継ぎは対象と利用者を確定した管理手順で行う。ownerなしの実行も全体の費用・未解決実行のguardに含め、同時実行1件を維持する。

DBを復元するときは、認証側ID・アプリの対応表・receiptの内部ownerの整合を確認する。利用者IDを再利用しない。対応が欠けたデータはアクセスを拒否し、匿名利用へ戻さない。ログアウトではBFFセッションを失効させる。発行済みAPIトークンや外部IdPのログアウトは別に設計する。

パスキーの登録先ドメインと認証情報の移行は、内部IDによる会話所有権の維持とは別問題である。Keycloakの置換や本番ドメインの変更でパスキーが自動的に移るとはしない。ローカルの初期確認は管理者が用意するテスト利用者で行い、公開前に登録・メール送信・本人確認・復旧・ドメインを確定する。

## 関連

- [現在地と利用者の方針](../../../knowledge/ax-agent-platform-direction.md)
- [現在のWebと保存方式](../../../knowledge/ax-web-foundation.md)
- [既存の会話受付と履歴](chat-turns.md)
