# ローカル認証用 Keycloak

Keycloak 26.8.0 を `127.0.0.1:8180` で起動し、AX Web のログインを提供する。認証データは既存の外部 PostgreSQL の `keycloak` DB に保存する。会話や実行結果、アプリ側の利用者・セッションはこの DB に保存しない。全体の責務は [認証設計](../../docs/auth-foundation.md) を参照。

公式イメージは `quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc` に固定している。[対応 DB](https://www.keycloak.org/server/db) に PostgreSQL 18.x が含まれる。HTTP は localhost の開発環境用であり、公開環境の URL・TLS 設定は別途決める。

## 初回準備と起動

Docker と Python 3、および [外部 PostgreSQL](../postgres/README.md) が必要。`ax-local-postgres` コンテナが動作し、空の `keycloak` DB と専用ロール `ax_keycloak` が準備されていること。以下はプロジェクトルートから実行する。

```sh
python3 ax-local/keycloak/manage.py init
python3 ax-local/keycloak/manage.py up
python3 ax-local/keycloak/manage.py provision
python3 ax-local/keycloak/manage.py status
```

`init` は `.state/auth/` に初期資格情報と Web 用 `app.json` を作る。既存の秘密値を再生成しない。ファイルが欠けている場合や、DB にデータがあるのに秘密ファイルがない場合は停止する。元のファイルをバックアップから戻す。ディレクトリは 700、ファイルは 600 で、Git の対象外。

`provision` は realm、クライアント、パスキー設定を管理する値へ揃える。既存利用者のパスワードと登録済みパスキーを保持し、クライアント秘密値が手元と違えば停止する。新規作成時だけ次のテスト利用者を登録する。パスワードは対応ファイルから本人が確認する。

| 利用者 | パスワードの保存先（`ax-local/` 基準） |
| --- | --- |
| `alice@example.test` | `.state/auth/alice.password` |
| `bob@example.test` | `.state/auth/bob.password` |
| 管理者 `ax-admin`（master realm） | `.state/auth/admin.password` |

Web の起動は [Web README](../../web/README.md) に従う。Web を `web/` 以外の作業ディレクトリで動かす場合は、`AUTH_CONFIG_FILE` に `ax-local/.state/auth/app.json` の絶対パスを渡す。ファイル内にはクライアント秘密値、トークン暗号化鍵、app DB の資格情報が含まれるため、内容をログへ出さない。

## 管理する認証設定

| 項目 | 設定 |
| --- | --- |
| issuer | `http://localhost:8180/realms/ax` |
| クライアント | `ax-web`、confidential、認可コード＋PKCE S256 |
| callback | `http://127.0.0.1:3100/auth/callback` の完全一致 |
| ログアウト後の戻り先 | `http://127.0.0.1:3100/login` の完全一致 |
| API 用 access token | `aud=ax-api`、`azp=ax-web`、`typ=Bearer`、RS256、最大 1,800 秒 |
| クライアント scope | `basic`、`profile`、`email`。`basic` が access token の `sub` を含める |
| ID token | audience は `ax-web`。API audience mapper は access token だけに適用 |
| パスキー | RP ID `localhost`、resident key と user verification が必須、passwordless 登録 action 有効 |
| 利用者登録・メール | 自己登録、パスワード再設定メール、SMTP 無効。メールアドレスを username に使用 |
| 言語 | 日本語が既定、日本語・英語に対応 |

パスキー設定には Keycloak 26.8 の [公式手順](https://www.keycloak.org/docs/latest/server_admin/index.html#passkeys) と [RealmRepresentation](https://github.com/keycloak/keycloak/blob/26.8.0/core/src/main/java/org/keycloak/representations/idm/RealmRepresentation.java) の項目を使う。端末での登録・削除は Web のアカウント画面から Keycloak へ進む。パスキーを使えない場合も、保持したパスワードでログインできる。

DB 接続先は `host.docker.internal:55432/keycloak`、ロールは `ax_keycloak`。JDBC の `sslmode=verify-full` と既存 PostgreSQL CA を使う。DB パスワードと管理者パスワードは起動スクリプトが読み込み、コマンド引数や Compose の環境変数値へ直接書かない。

## 検証と停止

```sh
python3 ax-local/keycloak/verify.py
python3 ax-local/keycloak/manage.py stop
python3 ax-local/keycloak/manage.py up
```

`verify.py` は実 Keycloak へ 2 利用者で認可コード＋PKCE のパスワードログインを行い、発行クレーム・個別 subject・設定・DB TLS を検査する。作ったテストセッションは終了する。トークンや秘密値は表示しない。JWT の暗号署名検証、製品 BFF との統合、パスキー実操作は Web 側の検証範囲。

検証クライアントの CookieJar には `http://localhost:8180` に限る Secure Cookie 対応がある。ブラウザが localhost を安全なコンテキストとして扱う挙動を、Python の検証経路にも適用している。

`stop` は Keycloak だけを停止し、DB と秘密ファイルを保持する。`recreate` はコンテナを再作成して Ready を待つ。いずれもログイン操作に影響するため、使用中の検証担当と実行時刻を合わせる。

## バックアップと復元試験

```sh
python3 ax-local/keycloak/verify_storage.py
```

この検証は Keycloak を一時停止する。既存 DB をダンプし、`keycloak_verify_<時刻>` という別の空 DB へ一括復元する。全 public テーブルの件数と順序に依存しない行内容ハッシュ、および sequence を照合後、試験 DB だけを削除する。Keycloak を再作成し、realm・client・利用者 ID と 2 利用者のパスワードログインを再確認する。既存の `keycloak`、`app`、`substrate` DB は置換しない。

バックアップと比較結果は `.state/auth/backups/<UTC時刻>/` に置く。`keycloak.dump` と 6 個の認証ファイルを一組として保管する。DB だけでは Web の暗号化済みセッションを読む鍵を復元できない。PostgreSQL のロール・DB 接続資格情報・CA は PostgreSQL 側のバックアップ対象で、app DB と receipt もそれぞれの担当手順で保全する。

実障害からの復旧では、まず既存 DB と秘密ファイルを退避する。元の認証ファイルとダンプを使って別 DB へ試験復元し、比較が通ってから停止中の Keycloak の接続先を切り替える。issuer、realm、利用者 subject を保持し、利用者をメールアドレスで作り直さない。Web は issuer＋subject で所有者を識別する。`init` による秘密値の作り直しや、稼働中 DB への上書き復元は復旧手順に含めない。

検証途中で失敗した場合は既存 DB を保持して Keycloak を再起動する。出力には秘密が混ざる可能性があるため、失敗した外部コマンドの生ログはスクリプトから表示しない。保存済みの比較結果とコンテナの Ready 状態を確認する。
