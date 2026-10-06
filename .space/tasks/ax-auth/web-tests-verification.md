# Web認証試験の検証結果

2026-10-06。基準 `42364cedd66409ac8f3953ea3755c25dc38484fe`、`codex/auth-foundation` の未コミット統合差分を検証した。担当は試験作成者であり、独立レビューではない。製品コードは親、PythonとKeycloakは別担当が所有する。09:05 UTCの全体試験後、親のlogout URL修正へ追随した試験も完了した。

## 結果

| 確認 | 結果 |
| --- | --- |
| `npm test` | 29件成功、失敗・skip 0。logout修正後の最終実行0.87秒 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功。ブラウザ試験は生成物を新しい `server/serve.ts` で起動 |
| `npm run test:e2e` | 24件成功、失敗0。50.6秒。従来17件＋認証7件 |
| `npx playwright test tests/browser/auth.spec.ts` | logout URL修正後、更新buildで7件成功。9.0秒 |
| 所有範囲の `git diff --check` | 成功 |
| GitHub Actions YAML読み取り | PyYAMLで成功。リモートCI自体は未実行 |
| ローカル試験設定の権限 | `ax-local/.state/auth/test-app.json` は0600 |

この担当の試験が新規に発見した製品不具合はない。独立BFFレビューが指摘したlogout URLの `id_token_hint` は親が削除した。これに合わせ、URLのqueryが `client_id` と `post_logout_redirect_uri` だけであるunitを追加し、browserでもlogout URLと遷移リクエストへJWTが含まれないことを確認した。fixtureはこれらのqueryを検証する。実Keycloakの終了確認画面は親の実操作で確認する。

追加試験の初回失敗3件は、React Routerが不一致Originを先に400で拒否すること、同ライブラリがsessionStorageへスクロール位置を保存すること、index routeの直接POSTに `?index` が必要なことを試験側に反映して解消した。拒否を確認する負の試験では、Origin拒否と認証callback拒否の意図したサーバーログが出る。

## 変更と確認範囲

- `web/tests/auth.test.ts`：専用DBの一時schemaを作り、製品migrationとAuthStoreを使用。issuer＋subjectの一意性・同時ログイン・同じメールの別ID、状態の暗号化、flowのブラウザ拘束・期限・一回限り消費、opaque sessionの期限・再生成後読取・失効・disabled拒否、暗号文の移植拒否、DB接続エラーでの拒否を確認した。schemaは終了時に削除する。
- `web/tests/helpers/oidc-fixture.ts`：ローカルHTTPのdiscovery/JWKS/authorize/token/logoutを提供。RS256、認可code、S256 PKCE、nonceを用いる。JWTのissuer/audience/azp/typ/期限/subject/署名/アルゴリズム/長さと、code交換時のstate/nonce/PKCE/redirect先・再利用拒否を確認した。
- `web/tests/{boundaries,runs,chats}.test.ts`：ownerを第一引数で渡す契約とPython stdin envelopeへ適応。内部Bearer＋利用者tokenが必要であること、任意ownerヘッダーを採用しないこと、ownerを含むPOSTを厳密schemaが拒否すること、認証基盤障害の503と秘密非表示、BFFが401を保持することを追加した。unitの認証器だけは明示DIを使う。
- `web/tests/browser/serve.ts` と `auth-helper.ts`：本物のPostgreSQL、製品BFF/API認証、通常の `/login` → ローカルIdP → `/auth/callback` を通す。製品認証の無効化やテスト用実行時フラグは追加していない。run/chatの実行だけはowner別のfixtureで、外部エージェント・モデルは呼ばない。
- `web/tests/browser/auth.spec.ts`：未ログイン拒否・login CSRF、tokenがCookie/HTML/Web Storageへ出ないこと、session回転とコピー済み旧Cookieの失効、利用者間の会話一覧・本文・継続・run・成果物・復旧の隔離、callbackの別ブラウザ・重複query・再利用拒否、flow/session期限とdisabled拒否を確認した。IdP logout画面を503にした場合もローカルDB失効とCookie削除が済む。パスキー登録ボタンは保護されたOIDCフローとaction指定までを確認する。
- 既存browser試験を通常ログインへ適応し、SSR、アクセシビリティ、320px、JavaScriptなし、hydration前入力、会話継続、再送、成果物、API停止時表示、dev/startの停止・ポート所有を継続確認した。認証Cookieを削除した後の送信はログイン画面へ戻る。
- `.github/workflows/web.yml`：ローカルと同じdigestのPostgreSQL 18 service、公開テスト専用credentials、専用role/DBの作成と非公開設定ファイル生成を追加。`web/playwright.config.ts` は設定ファイルの場所をchildへ引き継ぐ。

## データ・再実行・限界

`web/tests/prepare-auth.ts` は専用 `app_auth_test` だけを受け付ける。初回ローカル準備でこのDBを `ax_app` 所有として作成し、PUBLIC権限を剥奪した。既存のapp/keycloak/substrate DBは変更・削除していない。接続秘密は既存のローカル保護ファイルから読み、設定と秘密値は出力していない。ブラウザ試験は専用DBのpublic schemaを使い、試験用Alice/Bobとセッションを保存する。disabledを設定した試験はfinallyでactiveへ戻す。

再実行は `web/` で `node --import tsx tests/prepare-auth.ts`、`npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e`。ローカルPostgreSQLが稼働し、3210–3212とlifecycle試験の3230–3231・3240–3241が利用可能であることが前提。実行時は専用設定を使用し、通常運用の `app.json` は使わない。

今回の範囲は認証・画面・HTTP境界とfixture実行の回帰である。実Keycloakの設定、仮想/実機パスキー登録・ログイン・削除、バックアップ復元、Python receipt所有権・global guardの実装検証は親と各担当の報告を参照する。CI実行結果と独立レビューは親の統合工程で確認する。モデル呼び出し、AX操作、コミット、OKFへの追加保存は行っていない。
