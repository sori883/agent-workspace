# ワークスペース基盤の検証

対象: `codex/workspace-access`、基準 `b07173e`。2026-10-06、以下のローカル受け入れ条件はすべて合格。PRの公開・マージ状態はGitHubを正本とする。

## 認証の局所確認

2026-10-06、`web` で `node --import tsx --test tests/auth.test.ts` を実行し12件成功。専用app_auth_test DBの独立schemaを使用し、試験後にschemaを除去した。

確認対象はauth migration v1→v2と再実行、検証済みメールの正規化、未検証へ変化した場合の消去、同じメールでもidentityを統合しないこと、ログイン後の安全なローカル復帰先、暗号化・期限・一回限りのlogin flow、既存session/JWT/PKCE/nonce/logout。実OIDC fixtureのメール未確認では招待先の検証済みアドレスを取得できないことを確認した。

## 共通API・DB

[API担当の証拠](api-verification.md)を照合した。全unit62件が成功し、Workspace12件、Node/workerd6件を含む。並行作成3件上限・最後admin・複合FK・宛先検証・失効・旧runtime関数権限・旧履歴保持を実PostgreSQLの専用schemaで確認した。親の中間実行で61assertions成功の後にMiniflare Socket由来と考えられる非同期失敗が出たため、teardownの再現と修正を行い全体合格を確認した。詳細な原因の確度・Red/Greenは担当証拠に記す。有料モデル呼び出しは0件。

## Controllerの認可失効

- `TestRevoked*` を追加し、修正前にcreate前の終了とresume/stage/egress/start前のcleanupが行われず失敗することを確認した。
- 固定SQLSTATE/codeだけを確定拒否とし、外部操作前は無効果取消、操作後はdeny/suspendに進む。通信断・不明な副作用・heartbeat喪失は保留を維持する。
- 修正後 `go test -race ./...` がcontroller/native/settingsを含め通過。実DBの取消検証はU1、実Actorの確認は以下の統合経路で行った。
- 移行前の実app DBは16実行・2会話・15成果物、未解決/invalid 0件。`ax-local/.state/workspace-backups/20261006T135722Z/app.dump`（105768 bytes）へ秘密権限付きで保全した。

## 実ローカル移行・Keycloak・AX

親が新規受付を閉じ、未解決/invalid 0件を確認して旧Web/APIを停止した。認証v2→実行データv2→限定role grantを適用し、移行直後に旧16runs・2conversations・15artifacts・15importsの全行をworkspace_id列だけ除いてJSON化したSHA256が移行前と同一であることを照合した。すべての旧workspace_idはNULLを維持。ax_apiの旧accept/readは実行不可、新controllerの無効果取消は実行可だった。

Go image `localhost:5001/ax-execution@sha256:38bc9977eb8ff2eeb32a1ca79239a654ec09cf6a23f3c968254eb8fdeef526d2` をビルド・固定し、ローカルkindのRecreate配備を完了。readiness確認後に新Web/APIを起動し、受付を開いて無償確認を行った。

実KeycloakのAliceで「ローカル検証ワークスペース」を1件作成し、Bobへの招待リンクから未ログイン→Keycloak→元の招待→参加を確認。Bobはmember/generalで始まり、Aliceが業務ロールをdeveloperへ変更しても管理画面の操作権限は増えない。Bobを「開発チーム」「共通プロジェクト」の両方へ所属させた。旧履歴には送信フォームが表示されない。実ブラウザ用確認スクリプトは2度、ボタンの補助ラベルと相対locatorの選択誤りで停止したが、既存のWorkspaceを再利用して確認を継続し、不要なWorkspaceや実行を増やさなかった。

Web→共通API→PostgreSQL→更新Go→実AXのoffline run `ax-run-baee42066af1fd26` が成功。成果物は `Workspace access: PostgreSQL / Keycloak / AX offline` と完全一致、usage 0、概算0 USD。Bobが同じWorkspaceのAliceのrun URLへアクセスすると404となり本文を含まなかった。inspectをPod内から実行し、AX suspended・Actor実停止・worker未割当・egress denyがすべてtrue、exit 0だった。

Web/APIを終了・再起動し、同じ認証cookieで再ログインなしにWorkspace・Group・業務ロール・成果物を再表示できた。作成した確認用Workspaceと無償runは履歴として残す。実環境のスクリーンショット・確認結果は非公開 `.state/workspace-check/`、移行前backupは上記private保存先にある。Gitには認証cookie・招待秘密・DB dumpを含めない。

## 範囲と限界

本番公開、Entra/Cognito同期、確認メールの配送・公開自己登録、実モデルの有料呼出し、物理パスキーの再検証は本変更の対象外。開始側のDB認可とAXの外部効果は単一transactionではなく、確定済み送信許可を遡って取消する保証はない。次の開始側intentを止め、開始済みの回収と後片付けを維持する。

## 最終判定

- Web型検査・本番build・unit62件、Go race全パッケージ・vetに合格。
- 最新ビルドのブラウザ31件が再試行0で合格。実PGの組織操作、同一キー再送、名前/招待メールの長い貼付け、JavaScript有/無、320px、axeを含む。詳しくは [UIの証拠](ui-verification.md)。
- 独立レビューの入力切り詰め指摘を修正し、再確認後の未解決P0–P2指摘0件。人間レビュー・DADS完全適合の証明とは扱わない。
- 実ローカルは17実行（新規offline1件）、未解決/invalid 0、Workspace1件・所属2件・Group2件、受付有効。新runの成果物52bytes、SHA256 `cc03b4fd961884e2d9d35b4bebcbd294d26d9654c4491d4aac489a3378278bba`。
- OKF CLIで決定と現在の構成を更新し、strict/drift検証はerrors・warnings・gate findings・broken linksすべて0件。
- ソース・資料・検証を一つのPRへまとめる。ローカルの成果物受け入れはorch、公開・CI・マージ結果はGitHubと最終回答で示す。
