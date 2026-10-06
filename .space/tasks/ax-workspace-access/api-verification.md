# U1 API・DB 実装確認

対象は `codex/workspace-access`、基準 `b07173e` からの U1 未コミット差分。2026-10-06 に担当 api / workspace-api-1 が実施した自己検証であり、独立レビューや本体への反映とは分ける。

## 実装

- `web/shared/workspace-contracts.ts`：Workspace、所属の admin/member と general/developer、Group、招待の厳密なJSON契約。UUIDは小文字へ正規化。
- `web/data/schema-v2.sql`：組織・所属・Group・招待hash・冪等受付・監査、run/chat の nullable workspace、公開DB関数を追加。作成者の不変性、跨Workspace Group FK、会話とrunのWorkspace複合FKをDBでも保証。
- `web/data/workspaces.ts` と `web/api/workspace-service.ts`：Web Cryptoによる256bit招待トークン生成とSHA-256、固定SQL関数への入力・出力検証。初回だけraw tokenを返し、同key再送は同じID/期限、token:null/replayed:true。DBにも監査にもraw tokenを保存しない。
- `web/data/repository.ts`、API run/chat service：全経路を `ax_ws_*` へ接続。明示Workspaceの所属と本人ownerを両方確認。header省略GETは旧NULLのみ、submit省略は拒否。旧チャットは can_send:false。
- `web/api/app.ts`、`runtime.ts`：組織APIと `X-AX-Workspace-ID`。既存Host/Origin/Bearer/JWT、本文上限、応答検証を再利用。
- `web/server/data-migrate.ts`、`web/data/db.ts`、`permissions.ts`、`web/scripts/prepare-execution.ts`：v1 checksumを保持してv2を追加し、旧受付・読取関数と `ax_intent_v1` のruntime権限を取り除く。APIとcontrollerの許可関数を分ける。

`ax_intent` は create/resume/stage/egress_prepare/egress_allow/start の許可時に現在の所属とactive Userを再確認し、失効は SQLSTATE P0001 / workspace_access_revoked。egress_deny/suspend と既存 collect/finish は失効後も実行可能。`ax_cancel_unstarted` は有効claim、全intent 0件、apply/start未試行、resultなしを検査し、cleanup:false のまま not_started に終結する。実停止の証拠を捏造しない。

## 実測

実PostgreSQLは `app_auth_test` のランダムな専用schemaを使用し、正常終了時にschemaを削除した。製品 `app` DB、AX、モデルAPIは操作していない。

| 条件 | 実測・証拠 | 判定 |
| --- | --- | --- |
| 同key受付と作成上限 | `workspaces.test.ts`：8同時same-keyは1件、5並行追加は残枠2件のみ。離脱後も作成数3を維持 | 合格 |
| 所属と権限 | 最後adminの同時離脱は1件のみ成功。memberからの変更拒否。再加入はmember/general、旧Groupなし | 合格 |
| Group境界 | 他Workspace group指定は拒否、直接の跨Workspace複合FK違反も拒否 | 合格 |
| 招待 | hashのみ、再送token:null、宛先verified_email・未検証メール・期限・取消・招待元current admin・受諾再送・除籍後旧token拒否 | 合格 |
| privateとWorkspace | run/chat一覧・取得・再送・継続でWorkspaceを分離。同Workspace adminにも他人本文を公開しない | 合格 |
| 失効とcleanup | 開始側6操作すべて失効拒否、同claim deny/suspend/finish可能。無効果取消とintentあり取消拒否 | 合格 |
| v1→v2 | 旧private chatのrequest bytes・owner・受付日時保持、NULLのまま閲覧/回収、継続拒否。v1 checksum不変、migration再実行成功 | 合格 |
| runtime権限 | 全org/ax関数のPUBLICなし、SECURITY DEFINER search_path固定。実在ax_api/ax_executionの旧入口剥奪、直接表権限なし、相互の実行権限なし | 合格 |
| 共通HTTP | 組織の全経路、UUID正規化、strict入力、Origin/Bearer拒否、run workspace必須 | 合格 |
| Node・workerd | 共通PG受付/同key/所有者/再起動保持、Workspace作成・招待受諾、再送token非表示、PG切断503・無再送 | 合格 |
| 既存実行規則 | `data.test.ts` 13件：全体1件、claim/effect、未知usage、費用上限、旧ownerなし非公開、quarantine、履歴整合を維持 | 合格 |

最終コマンドと結果：

- `npm --prefix web run typecheck`：成功。
- `npm --prefix web test`：62件成功、0失敗。うちWorkspace12件、Node/workerd6件、既存data13件。親担当のauth試験も全体実行に含むが、その実装所有・独立レビューを代行しない。
- `git diff --check`：成功。
- v1 `web/data/schema.sql` は `git show b07173e:web/data/schema.sql` とbyte同一。

初期局所試験で、SQL関数rename後に残る旧関数名による引数修飾と、PL/pgSQLのrow変数/SQL aliasの衝突が再現した。v2側で旧関数本文の自己修飾を更新し、aliasを分け、同じ試験を通過させた。テスト接続設定をpool.optionsからspreadした初期移行試験はpasswordが非列挙のため接続に失敗したが、専用テスト接続設定を再利用する修正後は成功。製品接続経路の問題ではない。

## runtime fixture の非同期失敗と修正

上記の最終実行より前、担当の全61件成功後、親の別実行で61 assertions成功・suite 1失敗となった。before hook起点の非同期 `read ECONNRESET` が報告され、当時の成功だけで合格としなかった。

調査用にworkerdへの複数リクエスト中にdisposeする条件を作ると、Node Socketの未処理ECONNRESET/EPIPEが再現した。一時的なEventEmitter診断は、PG PoolではなくSocketのpipe errorを示した。Miniflare 5.20261001 alphaのHyperdrive proxy実装にもclient側Socketのerror処理不足がある。ただし親の元の失敗には詳細stackがなく、同一Socketだったと断定はしていない。診断用のglobal監視と強制中断コードは削除した。

テストのrequest helperは応答本文を最後まで読み取ってから返すようにし、stopWorkerは追跡中のリクエスト完了後にdisposeするようにした。待ち秒数の増加や例外の無差別catchは入れていない。12並行read中の再起動回帰は待機を外した版で失敗、修正版で成功。DB切断時の503・受付無再送の2試験も維持した。型検査と全62件成功はこの修正後の結果である。

## 引き渡しと限界

- 本体DB反映、バックアップ照合、Go controllerの失効分岐、ブラウザの統合検証、独立レビューは親/U2の範囲。U1は実DBへのmigration/deployをしていない。
- v2適用で旧runtime関数の権限を剥奪するため、停止・migration・新関数grant・新runtime配置の順序を親の運用手順で扱う。`prepare-execution.ts` は更新済みallowlistを利用する。
- 外部効果を始める直前の所属判定と外部AX効果は一つのトランザクションではない。既に出た送信許可を遡って取り消す保証はなく、次の開始側intentを止め、停止・回収を妨げない。
- Workers本番配置、モデル実行、メール送信、Workspace削除/移管、組織共有チャットは対象外。
- OKFは編集していない。知識化候補は、招待の初回のみtoken表示、旧NULLは閲覧/回収のみ、Workspace判定とprivate ownerのAND、失効時の無効果取消とcleanup分離。
