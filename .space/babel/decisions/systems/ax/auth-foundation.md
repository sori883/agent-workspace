---
type: decision
title: 認証窓口をKeycloakへ集約し内部利用者IDで会話を所有する
description: Keycloakのメール・パスキー認証、内部利用者IDによる所有権、外部DB接続と復元を実装した構成と採用理由
status: stable
governance: context
code_refs: 
  - docs/auth-foundation.md
  - web/server/
  - web/app/lib/auth.server.ts
  - web/api/
  - ax-local/keycloak/
  - ax-local/chat.py
  - ax-local/web_bridge.py
  - ax-local/task_cli.py
sources: 
  - resource: docs/auth-foundation.md
  - resource: .space/tasks/ax-auth/task.md
  - resource: https://www.keycloak.org/server/db
  - resource: https://www.keycloak.org/docs/latest/server_admin/index.html
  - resource: "https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability"
  - resource: ax-local/postgres/README.md
  - resource: .space/tasks/ax-auth/verification.md
  - resource: ax-local/keycloak/README.md
generated: 
  by: agent:codex
  at: 2026-10-06T09:24:45.770Z
---
# チャットの認証基盤の構成

2026-10-06、採用した設計に沿ってローカル認証を実装した。ログイン・ログアウト、未ログイン時の利用拒否、本人の会話・単発実行だけの閲覧と操作を扱う。初期方式はメールアドレス＋パスワードとパスキー。Keycloak 26.8.0と、外部接続のPostgreSQLのkeycloak/app DBを利用する。将来のMicrosoft Entra ID・Amazon Cognitoは未接続。構成は `docs/auth-foundation.md`、確認範囲と制約は `.space/tasks/ax-auth/verification.md`、設計比較と経緯は `.space/tasks/ax-auth/task.md`。

## 責務と保存先

初期はKeycloakを共通認証窓口とし、外部IdPはその背後へ接続する構造を土台にした。アプリが各IdPへ直接接続する別案から、内部利用者IDと `(issuer, subject)` の対応表を取り込む。複数IdPの直接接続は初期実装へ含めない。認証方式の追加を集約しつつ、Keycloak自体を将来置き換える際に会話所有権を直接書き換えずに済むようにするためである。

同日、利用者はPostgreSQLの採用を了承し、DBをEKS/Kubernetes内に置く前提で記載しないよう指示した。本番DBの配置先・運用サービスは未選定で、AWSのマネージドDB、外部のPostgreSQLホスティング、Kubernetes内などでの自己管理を候補に残す。アプリの配置先とDBの配置先は別に決める。

認証用とアプリ用のDB・接続権限の分離は、配置先によらず維持する。1インスタンスにまとめるのはローカル開発・検証で可能な構成であり、本番の配置・台数を指定しない。Keycloak・BFF・共通APIは接続先・資格情報・TLSを外部設定で受け取り、クラスタ内サービス名や永続ボリュームを前提にしない。選定後に提供元ごとの接続条件・対応バージョン・運用分担を検証する。認証用DBはKeycloakだけが扱う。アプリ用DBは内部利用者・外部ID対応・BFFセッションを保存し、パスワードやパスキーの秘密鍵は保持しない。共通APIはトークンを検証して内部利用者を確定し、Pythonへ渡す。

会話本文・費用・実行状態は既存receiptと成果物を正本に維持する。新規受付時に内部利用者IDをownerとして原子的に保存し、一覧・詳細・継続送信・成果物・復旧・同キー再送すべてで照合する。会話所有権をアプリDBへ二重登録しない。本人確認には発行元とsubjectを使い、メールアドレス一致だけで統合しない。

## 互換性と復旧

ownerなしの既存データは保存を維持し、通常のWeb利用者には公開しない。最初のログイン者へ自動割当しない。必要なデータの引き継ぎは対象と利用者を確定した管理手順で行う。ownerなしの実行も全体の費用・未解決実行のguardに含め、同時実行1件を維持する。

DBを復元するときは、認証側ID・アプリの対応表・receiptの内部ownerの整合を確認する。利用者IDを再利用しない。対応が欠けたデータはアクセスを拒否し、匿名利用へ戻さない。ログアウトではBFFセッションを先にDBから削除し、Cookieを消した後、Keycloakの確認画面へ遷移する。URLへID tokenを出さず、client_idとpost_logout_redirect_uriを使う。確認前でも元のCookieは拒否される。APIトークン自体の失効は別で、APIは署名・期限・有効な内部利用者を確認する。APIは内部Bearerも要求し、ブラウザへtokenを渡さない。

パスキーの登録先ドメインと認証情報の移行は、内部IDによる会話所有権の維持とは別問題である。Keycloakの置換や本番ドメインの変更でパスキーが自動的に移るとはしない。ローカルの初期確認は管理者が用意するテスト利用者で行い、公開前に登録・メール送信・本人確認・復旧・ドメインを確定する。

## 実装で固定した境界

Authorization Code＋PKCE S256、state、nonceを使い、ログイン途中の値は5分・1回限りでブラウザに結び付ける。内部UUIDと(issuer, subject)対応はトランザクションで作り、並行ログインでも重複させない。DBの無効利用者や障害を匿名利用へ切り替えない。

ブラウザの認証Cookieには不透明IDだけを入れる。DBにはIDのハッシュと、レコード用途をAADへ結び付けたAES-256-GCMの暗号文を保存する。暗号鍵は非公開ファイルへ永続化し、DB・ID対応・receiptと共に整合して復元する。sessionは最大30分またはaccess tokenの期限までで、refreshは実装しない。再起動で有効sessionを失わない一方、匿名CSRF署名鍵は起動ごとに変えるのでフォームは再読込する。

APIはRS256署名、issuer、audience=ax-api、azp=ax-web、typ=Bearer、exp/iat/subを検証する。Keycloakのbasic scopeがaccess tokenのsub発行に必要だったため、profile/emailと共に明示している。ID tokenのaudienceはax-webのまま分ける。

Python bridgeは検証済みowner UUIDと入力を別フィールドで受け取る。単発とチャットの両受付でownerを原子的に保存し、再送キーはownerと組にする。会話に別ownerが混在すれば拒否し、一覧はownerで絞ってから件数制限する。信頼するローカル管理CLI・workerの旧データ経路と、Webのowner必須経路を分ける。

標準のWeb配信器はcallback URLのcodeをアクセスログへ出すため、ログを出さないHonoの配信経路へ変更した。起動確認は公開login画面の署名Cookieを照合し、別プロセスが使うポートの成功応答を誤認しない。

実Keycloakでパスワード、仮想認証器のパスキー登録・ログイン・削除・パスワード復帰、ログアウトを確認した。2利用者の実AX offline、旧65ファイル不変、Keycloak 101表とapp 5表の隔離復元、Web/API再起動後のsession保持も確認した。有料モデル送信は0件。実物の生体認証器と本番公開は未確認である。

## 関連

- [現在地と利用者の方針](../../../knowledge/ax-agent-platform-direction.md)
- [現在のWebと保存方式](../../../knowledge/ax-web-foundation.md)
- [既存の会話受付と履歴](chat-turns.md)
