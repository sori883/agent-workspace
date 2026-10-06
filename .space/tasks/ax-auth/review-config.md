# Keycloak構成・CIの独立レビュー

2026-10-06。基準 `42364cedd66409ac8f3953ea3755c25dc38484fe`、`codex/auth-foundation` の未コミット差分。対象は `ax-local/keycloak/` と `.github/workflows/ax-local.yml`。担当はこれらを実装していない。Web試験の作成には参加しており、今回の独立レビューは上記範囲に限定する。

**判定：未解消のP0–P2指摘なし。初回導入の衝突1件を指摘し、親の修正を再確認した。** この判定はコード・設定のレビュー結果であり、未実施の実障害試験を合格に置き換えない。

## 指摘と対応

### 解消済み P2：Web試験を先に実行するとKeycloak初期化が拒否される

- 箇所：`ax-local/keycloak/manage.py:80–82` と、当初の `web/tests/prepare-auth.ts:8,34–35`。
- 条件：PostgreSQLだけを準備した新規環境でWebの試験を先に実行する。当初は試験設定 `test-app.json` が `.state/auth/` を作るため、その後の `manage.py init` は秘密5ファイルの欠損として停止する。Keycloak DBが空でもDB確認へ到達せず、初回なので復元元の秘密も存在しない。
- 根拠：実コードを読み、STATEの存在・秘密ファイル不在をin-memory Mockで与えて、`Incomplete auth files` とDB確認0回を観測した。ファイル作成・DB操作はしていない。
- 修正：親が試験の既定保存先を `.state/auth-test/app.json` に分離した。追加で許可された `web/tests/prepare-auth.ts:8` と `.github/workflows/web.yml:36` を読み、双方が本番認証ディレクトリ外へ一致していることを静的に確認した。Playwrightもこの既定定数を参照する。製品の「秘密の一部欠損では再生成しない」条件は保持されている。
- 再検証：新しい既定パスでNode29件成功との親報告あり。本レビューではその試験を再実行していない。

## 確認した境界

- Composeはイメージdigestを固定し、公開ポートを `127.0.0.1:8180:8080` に限定する。DBは専用 `keycloak` / `ax_keycloak`、JDBCの `sslmode=verify-full` と既存CAを使用する。localhostのHTTPは今回のローカル範囲として明記され、本番HTTPSの保証にしていない。Keycloak自身の再作成とDB保存先を分離している。
- `manage.py` は既存秘密を保持し、秘密なしで既存DBがある場合と既存 `app.json` が異なる場合は拒否する。主入口はumask 077、認証ディレクトリ700・秘密600。Composeへ秘密値を埋めず、起動スクリプトが保護されたファイルから読み込む。外部コマンドや認証HTTPの失敗本文を直接出力しない。
- provisionは固定issuer、confidential client、S256、完全一致callback/logout先、access-only audience mapperを設定する。既存client secretが異なる場合に更新せず停止し、既存利用者のpassword・passkeyを作り直さない。`basic` scopeは明示され、自己登録とSMTPは無効。
- `verify_storage.py:41–90` はKeycloak停止後にdumpし、認証ファイルを同じ保護ディレクトリへ保存する。別DBへの単一transaction復元と全public行hash・sequence比較後、作成した試験DBだけを削除する。元のkeycloak/app/substrate DBを上書きしない。復元中の例外では試験DB削除を試み、その削除が失敗しても内側finallyでKeycloak再起動を試みる。成功扱いは削除とReady確認の後である。
- CIの追加は秘密保存の局所テストとshell構文確認。既存Python試験を維持し、モデルや実Keycloakを起動する処理を追加していない。

## 証拠・未確認事項

レビュー中に実施したのはソース読み取り、Python AST解析、`bash -n`、YAML解析と公開ポート/TLS値の静的assert、Git除外確認、上記のin-memory Mockだけ。秘密ファイルの内容、dump、生tokenは読まず、製品・DB・サービス状態を変更していない。変更した文書はこの報告のみ。

`implementation-plan.md`、`keycloak-verification.md`、`docs/auth-foundation.md` と照合した。担当記録には101表・sequence0件の復元一致、一時DB削除、再作成後のidentity保持・2利用者ログイン、DB TLSの実測がある。本レビューでは秘密を含む生証拠を開いておらず、実dump/restore・停止/再作成は再実行していない。特に一時DB削除失敗時のfinallyと再起動失敗の障害注入、誤CA/ホスト名でのJDBC拒否は未実測。実Keycloakでのパスキー操作、公開環境のHTTPS、app DB・receiptまで含む整合復旧はこのレビュー対象外。

確認時のSHA256：`manage.py=e74748f127e542db61c2ffa2baeeab6d4d716a57bec6509fc433cfc3109484dc`、`verify_storage.py=f65032d5594422d036bb9132c3e41794335a9d415c775759f2bb09f9943f3027`。

## 適用した知識

`.space/babel` のrule全2件・principle全23件のdescriptionを検索し、対象7ファイルとCIパスをtype制限なしで照会した。Keycloak各ファイルは `rules/ax-model-spending` と `knowledge/ax-local-kind-environment` に一致し、CIパスの登録は0件だった。

本文は上記2件、`rules/pr-delivery`、`principles/make-operations-idempotent`、`principles/boundary-discipline`、`principles/prove-it-works` を参照。秘密を公開しないこと、モデルを呼ばないこと、既存状態と再実行の保全、境界での検証、自己申告と独立した実測を区別することへ適用した。ローカル基盤の既存OKFにある「Keycloak未実装」は今回の実装前の記録として扱い、現在のコードとタスク資料を優先した。OKF更新と全体の受け入れは親へ引き継ぐ。
