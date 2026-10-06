# Keycloak ローカル構成の検証

2026-10-06、担当 `keycloak`、基準 main `42364ce`、ブランチ `codex/auth-foundation` の未コミット `ax-local/keycloak/` を対象とする。設計は [認証設計](../../../docs/auth-foundation.md) と [実装契約](implementation-plan.md) を再利用した。構成・管理・局所検証・実 Keycloak の保存確認までを担当し、全体の受け入れと独立レビューは親担当へ渡す。

## 成果物と構成

`ax-local/keycloak/compose.yaml`、`start.sh`、`manage.py`、`verify.py`、`verify_storage.py`、`test_manage.py`、`README.md` を追加した。公式 Keycloak 26.8.0 の image digest は `sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc`。公式 [downloads](https://www.keycloak.org/downloads) と [PostgreSQL 対応](https://www.keycloak.org/server/db) を確認した。

Keycloak は loopback の 8180 番で動作し、既存 `ax-local-postgres` の `keycloak` DB に `ax_keycloak` として接続する。JDBC は既存 CA を使った `sslmode=verify-full`。PostgreSQL、Substrate、Kubernetes の設定は変更していない。保存試験では別の一時 DB だけを作成・削除した。モデル呼び出しは 0 件。

issuer、PKCE、audience、パスキー、日本語の具体値は [README](../../../ax-local/keycloak/README.md) に集約した。Web 用 `app.json` のキー・型は最新版 `web/server/auth-config.ts` の strict schema と一致する。親の指定以外の公開クライアントや外部 IdP は加えていない。

## 結果

| 条件・方法 | 実測結果・判定 |
| --- | --- |
| 公式 digest の pull、Compose 起動と Ready | 合格。`http://localhost:8180/realms/ax` が応答 |
| `verify.py` の discovery、自己登録/メール無効、パスキー policy、confidential＋PKCE、完全一致 redirect、ファイル権限 | 6 項目合格 |
| Alice と Bob の実パスワードログイン | 各 3 項目合格。認可コードを S256 verifier と confidential secret で交換でき、access token の issuer/azp/typ/audience/RS256/最大 1,800 秒と、ID token の audience/nonce を確認 |
| 利用者 subject の分離 | 合格。2 利用者の subject が異なる |
| PostgreSQL 接続中の `pg_stat_ssl` | 合格。Keycloak 接続が存在し、対象接続はすべて TLS。verify-full は JDBC 設定で確認 |
| Keycloak DB の停止中 dump → 別 DB への単一 transaction 復元 | 合格。101 public テーブルすべての件数・順序非依存の行内容 hash、sequence 0 件が一致。試験 DB 削除済み |
| Keycloak コンテナの強制再作成 | 合格。realm ID、client ID、2 利用者 subject を保持し、2 人とも再ログイン。上記 14 項目も再度合格 |
| 秘密ファイルの保全に関する局所テスト | 4 件合格。繰り返し init で全秘密値保持、既存 DB＋秘密なしで拒否、欠落ファイルを再生成しない、既存 app.json 不一致を上書きしない |
| TS の `readAuthConfig()` | 合格。`AUTH_CONFIG_FILE` を絶対パス指定して strict schema 検証 |
| Python 構文、shell 構文、Compose 設定 | `py_compile`、`bash -n`、`docker compose config --quiet` が成功 |
| Git 除外 | `app.json` と保存した dump が `git check-ignore` で除外されることを確認 |

実経路の秘密を含む証拠は `ax-local/.state/auth/verification.json` と `ax-local/.state/auth/backups/20261006T085903Z/` に保存した。後者に dump、認証ファイル一式、`source.json`、`restored.json`、`result.json` がある。公開記録にパスワード・token・ユーザー本文は転記しない。

復元試験後、失敗時の一時 DB 削除が失敗しても Keycloak 再起動へ進むよう `finally` を入れ子にした。この例外分岐そのものの実障害注入は未実施。正常系の復元比較・コンテナ再作成は変更前に実測しており、正常系の処理は変えていない。後から追加した init の既存 DB 保護は局所テストで確認した。親のブラウザ統合試験開始後は追加の停止・再作成をしていない。

## 検証中の修正

- 初期クライアント scope を profile/email だけにすると access token の `sub` が欠けた。Keycloak 26.8 の `basic` scope を追加し、既存クライアントには scope 専用 API で関連付けた。client 本体の PUT だけでは既存 scope の関連付けは変わらなかった。修正後の実 token で subject と 14 項目を確認した。親の初回 BFF callback 失敗とは別途、親が統合再試験する。
- Python の標準 CookieJar は localhost HTTP 上の Secure Cookie を再送せず、初回の検証ログインは HTTP 400 になった。検証クライアントだけ `http://localhost:8180` に限定した Cookie 方針を適用し、ブラウザの localhost 動作に合わせた。製品の Cookie 属性は変更していない。
- root cwd で既定の `readAuthConfig()` を単発実行すると相対パスの基準が違い失敗した。`AUTH_CONFIG_FILE` の絶対パス指定で成功。設定内容の不一致ではない。

## 引き渡しと制約

Keycloak は Ready で稼働中。管理者は `ax-admin`、テスト利用者は `alice@example.test` / `bob@example.test`。パスワードの保存先はそれぞれ `ax-local/.state/auth/admin.password`、`alice.password`、`bob.password`。クライアント秘密値は同ディレクトリの `client.secret`、Web が読む設定は `app.json`、暗号化鍵は `encryption.key`。内容は出力していない。

パスキー policy の有効化は確認済み。仮想認証器による登録・ログイン・削除、製品 BFF/API での署名検証、利用者隔離、ログアウト、app DB と組み合わせた復旧は親の統合検証範囲。実機の生体認証、本番 HTTPS、SMTP、外部 IdP 接続は今回の対象外。`verify.py` は token の発行クレームを検査するが暗号署名検証を代行しない。

OKF は担当範囲外のため未編集。親へ引き継ぐ知識は、Keycloak 用 DB の責務、固定 issuer＋subject の保持、DB と秘密ファイルを一組で復元する条件、`basic` scope と access-only audience mapper の必要性。作成物をコミットしていない。
