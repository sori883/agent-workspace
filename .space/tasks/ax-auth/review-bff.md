# 認証 BFF / API 独立レビュー

対象は `main 42364cedd66409ac8f3953ea3755c25dc38484fe` に対する `codex/auth-foundation` の未コミット差分。2026-10-06。対象要件は `docs/auth-foundation.md` と `implementation-plan.md`。Python作者であるため、自分のPython実装はこの独立レビューの対象に含めていない。製品コードや外部サービスを変更せず、本報告のみ保存した。

## 要修正 1件

**P2: ログアウトの303 LocationにIDトークンを含め、トークンをブラウザへ渡さない契約に反する。**

- 箇所: 指摘時点の `web/server/oidc.ts:48-49` と `web/app/lib/auth.server.ts:85-87`。
- 発生条件: 認証済み利用者がアカウント画面でログアウトし、IdPのメタデータが取得できる通常経路。
- 経路: `logout` がDBセッションを失効した後、保存していた `session.idToken` を `IdentityProvider.logout` へ渡す。`buildEndSessionUrl` が `id_token_hint` の値としてURLへ入れ、BFFがそのURLをブラウザへ303で返す。
- 影響: アクセストークンではないが、IDトークン本文がブラウザの遷移先URLへ露出する。今回の「ブラウザへトークンを出さない」という実装契約と一致しない。IDトークンに含まれる本人情報もURLの一部になる。
- 証拠: 実通信・実資格情報を使わず、合成 `SYNTHETIC_ID_TOKEN` と `openid-client.Configuration` を注入した実コード呼出しで `{"idTokenInRedirect":true,"clientId":"ax-web"}` を確認した。インストール済み `openid-client` の `buildEndSessionUrl` は渡されたパラメータをそのままqueryへ追加する。
- 最小対応: `client_id` と登録済み `post_logout_redirect_uri` のみを送る終了経路をKeycloakで確認し、Location・履歴へIDトークンを出さないことを試験する。ローカルDB失効を先に行う現在の順序は保持する。
- 状態: 親へ先行共有し、採用済み。親が修正・実Keycloak終了確認画面の検証を担当する。修正後の再確認は本報告ではまだ完了としていない。

これはOIDC標準の禁止事項という指摘ではない。[RP-Initiated Logout仕様](https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RPLogout) は `id_token_hint` を推奨し、なしの場合の `client_id` と終了確認の仕組みも定義している。今回の非公開契約に対する不一致として扱う。

## その他の確認結果

以下に成立する認証迂回・所有者混同は見つからなかった。

| 確認対象 | 根拠と確認内容 |
| --- | --- |
| PKCE / state / nonce / callback URI | `oidc.ts:17-33` はS256、expectedState、expectedNonce、必須ID token、redirect origin/pathの完全一致を使用。`enableNonRepudiationChecks` の設定とインストール済みライブラリの署名検証経路も確認 |
| 一度限り・ブラウザ束縛 | `auth-store.ts:42-50` の期限付き `DELETE ... RETURNING` がstate hashとbrowser hashを同時照合。`auth.server.ts:44-74` はCookie、GET、サイズ、重複queryを確認してから消費 |
| JWTの宛先・用途・署名 | `oidc.ts:35-46` はissuer、audience、RS256、exp/iat/sub、azp、typ=Bearer、最大年齢を検証し、検証後のissuer/subだけを利用者照合へ渡す |
| 外部ID対応・無効利用者 | `auth-store.ts:52-76` はissuer/subjectの一意対応とactive userを照合。メール一致で統合せず、同時ログインはtransactionとadvisory lockで直列化 |
| セッション・DB停止 | `auth-store.ts:78-95` はopaque IDのhash、30分とaccess token期限の短い方、active user、DB失効を照合。`auth.server.ts:19-29` と `api/app.ts:27-31` はDB失敗を匿名利用に変えない |
| 暗号化・エラー出力 | `auth-store.ts:28-40` はAES-GCMと行ID/purposeのAAD。callbackログは段階名と制限済みcodeだけ。loaderの返却値にtokenオブジェクトを含めない。現build/clientのJSに暗号化鍵やclient secretを扱うモジュールの識別文字列も見つからなかった |
| CSRF | login/account/chat/workspace/run-detailのactionはorigin、Host、method、フォーム上限と重複、署名済みCSRF cookieと期限を確認。ログイン成功後は既存CSRF cookieを破棄 |
| 既存機能の認証 | chat/home/workspace/run-detail/run-artifact/accountのloader/actionが `requireAuth` を通る。APIはstatus以外を認証し、任意owner headerを読まず検証済みIDを8操作へ渡す |
| Pythonへの境界 | `api/run-service.ts:83-108`、`api/chat-service.ts` は全メソッドの第1引数をownerとしてUUID検証し、通常stdinを `{owner_user_id,input}` にする。BFFからはaccess tokenを内部HTTPヘッダーで渡す |
| productionモードの実配線 | `scripts/run.ts:63-79` のstart分岐が `server/serve.ts` を起動。Host検証後、client静的資産とReact Router SSR handlerへ振り分け、同じ認証loader/actionへ到達する。API・Webともloopback bind。ここでいうproductionは最適化済みローカル起動で、外部公開HTTPS配置は今回の対象外 |

`git diff --check -- web/server web/app web/api web/scripts` は通過。既存/追加認証テストのソースも照合したが、親・試験担当が実行中のDB/browser試験は重複実行していない。親から引き継いだ実Keycloak passwordログイン到達・fixture 27件成功は親側の証拠であり、この担当による再実行としては数えていない。

## 参照と限界

スキルは `.agents/skills/interrogate/SKILL.md` と `references/reviewer-prompt.md`、`.agents/skills/okf-agent-memory/SKILL.md` を使用。bundleは `/Users/const/sori883/agent-workspace/.space/babel`。既読の `principles/boundary-discipline`、`decisions/systems/ax/auth-foundation`、`knowledge/ax-web-foundation`、`rules/ax-model-spending` を契約に照合した。追加のfor-path検索は `web/server/`、`web/app/`、`web/api/`、`web/scripts/` を対象とし、各パスに `knowledge/ax-web-foundation` が一致した。bundleや概念の更新はしていない。

実Keycloakのpasskey、ログアウト修正後の確認画面、DB/Keycloak停止と復元、2利用者の全ブラウザ経路、実機の生体認証は親・試験担当の検証結果を待つ。実AX・モデル呼出、ユーザーデータや実トークンの読取、サービス構成の変更は行っていない。

## 修正後の再確認

同日、親の修正後に指摘したログアウト経路だけを再確認した。`web/server/oidc.ts:48-49` は引数がreturn URIのみになり、生成するqueryは `client_id` と `post_logout_redirect_uri` だけとなった。`web/app/lib/auth.server.ts:76-87` はIDトークンを取り出さず、DBの `store.revoke`、Cookie削除、IdP URL生成、303応答の順序を保持している。IdP URL生成に失敗してもローカルログアウト済みの画面へ戻る。

合成Configurationを注入した実コードの再診断で、queryの完全一致をassertし、`{"logoutParametersOnly":true,"idTokenHint":false,"accessToken":false}` を確認した。実通信・実トークンは使用していない。追加された `web/tests/auth.test.ts:178-187` は同じ2パラメータとtoken不在を検査し、`web/tests/browser/auth.spec.ts` も実際の遷移URL・リクエストにtokenが含まれないこと、コピー済みCookieの失効、IdP終了画面が503でも失効することを検査する。

この独立コード評価では、**P2のIDトークンURL露出は解消、当レビューの未解消指摘は0件**と判定する。`web-tests-verification.md` に記録された修正後 `npm test` 29件、認証browser 7件の成功も照合した。これらは試験担当の実行結果で、この担当による再実行とは区別する。実Keycloakの終了確認画面の操作は親が担当中であり、この再確認では実操作済みとして扱っていない。
