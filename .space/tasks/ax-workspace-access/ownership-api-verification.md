# 所有者・譲渡 API / DB の確認

2026-10-07、基準 `ec7c9e4` からの ownership-api 担当差分を自己検証した。確定契約は `ownership.md`。今回の記録は独立レビュー・親の実環境確認を代行しない。

## 変更

- `web/data/schema-v3.sql` に現在の owner_user_id、所有者の所属FKとadmin維持の遅延制約、所有者index、譲渡申請を追加した。created_by_user_idは不変履歴として保持する。
- 所有数は現在ownerで数え、上限50。作成と受諾は所有枠用advisory lockを共用する。受諾は旧・新所有者のUUID順にquota lockを取得してからWorkspace行をロックする。User行を先にFOR UPDATEでロックしないため、既存のWorkspace→Userという招待受諾の順序と逆にならない。
- 譲渡は有効pendingをWorkspaceごとに1件、7日。申請元ownerと受取人の内部UUIDに固定する。受諾時は両者の現在状態を確認し、fromはactive/adminかつ現在owner、toはactiveの現在メンバーを要求する。
- 承諾で新所有者をadminへ変更するが業務ロールとGroupを保持する。旧所有者もadminのまま。本人限定の会話・実行・成果物の所有者は変更しない。
- 受取人の除籍・退出でpendingをcancelledへ変更する。再加入からは復活しない。accept/reject/cancelの確定再送は同じ終端状態に対する無操作のみ許し、古いacceptedから再譲渡しない。
- `workspace-contracts.ts` のWorkspaceにowner_user_id、一覧にowned_count/ownership_limit:50、詳細に当事者だけが見られる有効pendingまたはnullを追加した。proposeの応答schemaはpending/accepted/rejected/cancelled/expiredの全状態を扱い、同key再送と整合する。
- repository/service/APIにproposeOwnership/respondOwnershipと対応POST経路を追加した。GETに副作用は加えていない。DB権限allowlistには新公開関数2個を追加し、旧org_detail_v2/org_mutate_v2へのruntime権限を剥奪した。
- migration runnerにv3、バージョン定数に3を追加した。v1/v2の本文とchecksumは変更していない。

## 専用DBでの結果

`app_auth_test` のランダムな専用schemaを使い、終了時に削除した。SQL fixtureのみであり、AXやモデルを実行していない。

| 条件 | 実測 | 判定 |
| --- | --- | --- |
| O1 所有枠 | 同key8並行は1件。49件から5並行作成は1件成功。作成1件と受諾2件が50件目を争う場合も1件のみ成功 | 合格 |
| O1 再送・参加 | 上限50でも成功済みcreate replayは同一結果。所有50件でも別Workspaceの招待参加に成功 | 合格 |
| O2 譲渡 | 本人以外の受諾拒否、所有者以外の申請拒否、同key・同時pendingの排他、譲渡後の枠返却 | 合格 |
| O2 再譲渡防止 | 一度Bobへ譲渡してAliceへ戻した後、最初のaccept再送は成功応答のみでAlice所有を維持 | 合格 |
| O3 owner保護 | APIとDB直接経路でownerの退出・削除・降格・NULL・非所属への変更を拒否 | 合格 |
| O3 lifecycle | 取消、辞退、期限切れ、確定再送、逆操作拒否、除籍/退出→再加入後の旧申請拒否 | 合格 |
| O3 競合 | accept対cancel、accept対除籍はWorkspaceロックで一方だけが成立し、owner/statusが一致 | 合格 |
| O3 User停止 | 申請元owner停止後の新規acceptを拒否。受取人はreject可能。DDLにはactive状態を固定しない | 合格 |
| O4 private | 譲渡前後のrun行を全フィールド比較して同一。旧本人のみ会話を参照、新Workspace ownerの他人run/chat参照拒否。業務ロールとGroupを保持 | 合格 |
| O5 migration | creator inactive/降格/退出の3条件でv3全体rollback。owner列がなくmigrationは1/2のまま、旧org_listが利用可能 | 合格 |
| O5 migration成功 | 不適合条件を解消したfixtureでv3適用・再適用成功、旧run全内容不変、creator→ownerを確認 | 合格 |
| DB権限 | 旧org_detail_v2/org_mutate_v2のax_api/ax_execution実行権なし。既存PUBLICなし・search_path固定・役割分離試験を維持 | 合格 |

実行したコマンド：

- `node --import ./web/node_modules/tsx/dist/loader.mjs --test web/tests/workspaces.test.ts web/tests/data.test.ts`：初期25件成功。
- `node --import ./web/node_modules/tsx/dist/loader.mjs --test web/tests/workspaces.test.ts`：最終21件成功。
- `npm --prefix web run typecheck && npm --prefix web test`：型検査成功、全71件成功・0失敗。全体実行は親の重複回避連絡時点ですでに進行中で、その結果を親へ引き渡した。
- `git diff --check`：成功。

固定ファイルのbyte照合：

- v1 `schema.sql`：基準ec7c9e4と同一、SHA-256 `6c1474540fb3e0b33f9b029c569030991ea3aea8bb155eb1e32e99dc716e17ca`。
- v2 `schema-v2.sql`：基準ec7c9e4と同一、SHA-256 `c9669b928b6c4495ef3cc96000a3a5faa56548b11eb8fb91fd0480240d917b53`。

## 引き渡し

製品SQL/APIは上記の確認後に固定し、独立レビューへ渡した。ブラウザ・実Keycloak経路、本体DBのbackup/migration/grant、旧データ全件照合、最終buildと全体承認は親・UI担当の範囲。U1は実app DB・サービス・AX・有料モデル・Git・OKFを変更していない。

所有者が停止されても所有者フィールドや所属は自動移動しない。停止Userの管理上の復旧は従来の管理経路で扱い、この変更から自動的に他Userへ所有を渡さない。所有権の譲渡はprivateデータの共有許可ではない。

## 独立レビュー後の限定ロール確認

レビュー中に「SECURITY INVOKERの遅延制約トリガーがCOMMIT時にax_apiへ戻り、表のSELECT権限不足になる」という懸念が出た。レビュー担当のPostgreSQL 18実装確認により未確定懸念へ戻り、担当でも修正前SQLを実行して確認した。

`workspaces.test.ts` に `restricted ax_api commits workspace creation and ownership acceptance with deferred constraints` を追加した。専用schemaだけにUSAGEと公開API関数のEXECUTEをgrantし、Docker内psqlから `BEGIN → SET LOCAL ROLE ax_api → org_create → COMMIT`、申請後の `org_respond_ownership(accept) → COMMIT` を実行した。両方とも成功し、別接続でowner変更とadmin所属が保存されたことを確認した。同じroleの直接org_workspaces SELECTはpermission denied、所有者削除はworkspace_owner_cannot_leaveで拒否された。

懸念の権限エラーは再現しなかったため、SQLは変更していない。SECURITY DEFINERへの変更や、Red-Green修正をしたとは扱わない。恒久テストは既存local ax_apiを変更せず使い、CIの専用PostgreSQLコンテナは親がPOSTGRES_CONTAINER環境とax_api NOLOGIN作成を追加した。グローバルなrole membershipは変更していない。

限定回帰1件成功後、`npm --prefix web run typecheck && npm --prefix web test` を実行し、型検査成功、全72件成功・0失敗（Workspace22件）を確認した。親と独立レビュー担当へ実測を通知済み。
