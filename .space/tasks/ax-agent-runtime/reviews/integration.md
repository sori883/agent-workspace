# 初期対話プレビューの統合レビュー

2026-10-07。対象は main `a682948be9daddc37555067fd98475eb3938b427` からの `codex/ax-interactive-runtime` の未コミット差分。担当は `w1_design_a`。初期の無課金プレビューについて、現在のコードと受理済みの局所レビュー、親の実環境報告を照合した。新しい必須修正、または既知指摘の未解消は見つからず、親の統合受け入れへ渡せる。

この判定は固定質問一つ・回答一回・本文成果物の範囲である。設計全体の完成、有料provider、本番運用、任意コードの安全性を承認するものではない。

## 独立性と証拠の扱い

- この担当はPython Runtimeとローカル検証スクリプトの作成者であり、それらを独立レビュー済みとは数えない。Pythonの作成者以外による確認は [sdk-implementation.md](sdk-implementation.md) の親レビューを利用した。
- 親のUI/BFF/配置、別担当のGo/AX patchを独立に読み、以前の指摘と修正後の確認を再利用した。同一モデルによる別担当であり、モデルの多様性はない。
- DB/APIは [data-implementation.md](data-implementation.md) の別担当レビューと実PG試験を利用し、今回も境界と終了判定の修正箇所を読んだ。DB契約の事前相談に関与しているため、設計自体から完全に独立した評価とはしない。
- 最終実AX/Keycloak/PG/ブラウザの数値は親が観測した結果である。このレビューではlive操作、秘密ファイル・生tokenの読取り、子の受理済み記録の変更を行っていない。

## 経路と既知指摘の照合

| 境界・指摘 | 確認した現在の状態と根拠 |
| --- | --- |
| ブラウザ→BFF→API | BFFは認証済sessionを要求し、入力を保持してからCSRF検証する。APIはHost/Origin/内部Bearerと検証済JWTからowner・期限・token fingerprintを解決する。ブラウザのowner指定で権限を変更する経路はない。`web/app/routes/agent.tsx:75`、`web/app/lib/agents.server.ts:10`、`web/api/app.ts:31` |
| 入力保持と失敗表示 | hydration前のDOM入力を同draftで引き継ぎ、CSRF失敗時の本文を保持する。stop応答はroot IDで対応付け、回答composerへ混ぜない。以前の3指摘に対応する親のブラウザ回帰を利用した。`web/app/routes/agent.tsx:82`、`:108`、`:132` |
| ログアウト | 停止受付が不明ならsessionが有効なままであることを503本文と画面に明示し、再操作できる。成功したように表示しない。`web/app/lib/auth.server.ts:80`、`web/app/routes/account.tsx:20` |
| 所有・失効・再送 | root/segmentはownerとWorkspaceへ束縛し、revision/question/keyで回答を限定する。除籍・無効化後の旧grant復活とlogout/start競合は、永続停止・token hash失効・owner lockで修正済み。別担当の回帰証拠を利用した。`web/data/schema-v4.sql:32`、`:206`、`:354` |
| 送信前の許可 | GoはPG Reserve→固定Gateway→Settle→guest Replyの順。SDKは一つのJSON提案だけを返し、固定toolも外側の許可後に実行する。root累積予算をSDKプロセスごとにリセットしない。`execution/controller/interactive.go:29`、`web/data/schema-v4.sql:230`、`ax-local/task_runtime/adapters/interactive.py` |
| 未確定応答 | Reserve/Settleの結果が不明ならproviderを再送しない。guest ACK喪失は保存済みの同じ応答だけを照合して再投入する。recoveryはmailboxのモデル処理へ進まない。`execution/controller/interactive.go:64`、`execution/controller/controller.go:195` |
| 既知拒否で全体枠が残るP1 | 未確定operationを先に検出してholdする。その上で、denyと実停止の証拠があり、Gateway usageが確定した中断だけを失敗として終結する。元receiptは観測記録に残し、SDK成功を捏造しない。要求0件・model応答後の失効・SDK初期化失敗の実PG回帰は保存担当の結果を利用した。`web/data/schema-v4.sql:301`〜`:320` |
| Task内の秘密 | AXの鍵取得を論理atespace `ax-runtime` で無効化し、Task env/Workspace binding、default template fallback、crashed snapshotの自動復旧を拒否する。readinessの期待値30秒は固定Substrateの既定値と一致し、他のtemplate改変検査を維持する。`ax-local/patches/credential-free-atespace.patch:15`、`:40` |
| 共有workerへの補正 | 論理atespaceは`ax-runtime`、接続先SPIFFE identityは実workerの`ax-demo`に固定する。Actor割当と`ate-target-actor`を別に照合する。専用poolを再作成せず、既存poolへのcontroller限定443許可、AX loopback、Recreateを維持する。`execution/settings/settings.go:59`、`execution/native/direct_guest.go:66`、`web/scripts/deploy-execution.ts:28` |
| 成功の確定 | PGがGatewayのusage、許可済み提案、成果物bytes、deny、Actor停止とworker未割当を合わせて判定する。AX phaseだけで停止成功にしない。`web/data/schema-v4.sql:291`、`execution/native/adapter.go:309` |

初期Gatewayは `execution/gateway/stub.go` の固定模擬応答だけで、実モデル宛先や鍵の設定を持たない。画面も模擬プレビューと明示している。共有workerは信頼済み基盤であり、poolやnamespaceをTask間の隔離保証とは扱っていない。

## この担当が実施済みの局所確認

直前の修正レビューで次を実行し、今回も対象hashが一致することを確認した。変更のない試験を最終レビューのためだけに再実行してはいない。

- `bash ax-local/patches/verify-credential-free.sh`：固定上流の一時copyで専用10件を含むcontroller/substrateのrace試験とAX server buildが成功。既定値30の受理・31の拒否、保存Failed TaskへのGetが無作用、明示SuspendのActor作成・停止とResume/Revert 0件を含む。
- executionで `go test -race ./cmd/inspect ./settings ./native`：共有worker修正後に成功。旧専用・任意・空identity拒否、既存設定の不変を確認した。最終実行はcache利用。
- `deploy-execution.ts` の単独strict TypeScript検査と対象差分check：成功。配置スクリプトの実行は親だけが行った。

| 対象 | 最終確認したSHA256 |
| --- | --- |
| `web/data/schema-v4.sql` | `1f3e98fa7e5455aacd329a36f290eda772f456df91c80b1c625d2ff85055ccab` |
| `ax-local/patches/credential-free-atespace.patch` | `866b3342b13db166206ddd4f51e3898e6bd7a79d750a30a2cacbb184db17a767` |
| `execution/settings/settings.go` | `5907e5567948a292a9f32b6ec3c28e16597dfa581481b63b38b2de181442fe81` |
| `web/scripts/deploy-execution.ts` | `70ba84541d57d9a88fe85ed3baa13d83c19a0541eaab4fd0143f74f72a7d162b` |

## 親の実環境報告との整合

詳細と元証拠の場所は [verification.md](../verification.md) を正本とする。ここでは親が報告した最終結果とコード上の条件の対応を確認した。

- root `8cde2bd6-8196-430c-97e8-b737c649e40e`、質問 `ax-run-13d46a5102db8525`、回答 `ax-run-1f715260d8d5ca9a`。実Keycloak→UI→API→PG→controller→AXで質問、再読込、回答、成果物まで成功した。
- 成果物95 bytes、SHA256 `4eff65d219f52d55bc45271d90a324e0b4890752e490f888d134be489b5995bf`。回答とbyte一致、Bobは会話非表示・成果物404。
- root model2/tool2、模擬input200/output40、active 13,272ms。各区間usage120・estimated USD 0。これは模擬providerの照合であり、実モデル料金の検証ではない。
- 独立inspectで両Task Suspended、Actor stopped、worker未割当、deny一致。未解決0。先行失敗2件も削除せずretirement/recoveryでfailed/resolvedに終結した。
- 専用pool/namespaceの削除前にworker assignment 0とPVC/Secretなしを親が確認し、論理AXデータは保持した。この観測を当担当が再実行したとは扱わない。

これにより、以前の「実Actor未確認」「新previewの実経路未完了」は初期プレビューの成功経路について解消した。全障害の実cluster注入、あらゆる途中状態からの自動復旧が確認されたわけではない。

## 残る制約と引き渡し

- 本人限定・費用上限・未知結果holdを緩める変更は確認していない。有料provider、生成コード、動的環境導入、subagent、GitHub、MCP/RAG、定期実行は後続である。
- 全通信プロトコルの敵対的隔離、共有worker基盤が侵害された場合の防護、本番配置は今回の検証範囲外である。
- 初回のみ失敗した既存Python timeout試験と、並列一括Node試験のMiniflare ERR_DISPOSEDは、成功した実行と分けた記録を保持する。原因が解消したとは判定しない。
- 親の受理済み記録、最終docs/OKF整理、commit/PR/全体受け入れは親の担当として残る。このレビューでは変更していない。

参照した知識は既読の `decisions/systems/ax/agent-runtime`、`single-task-cli`、`portable-api-postgres`、`auth-foundation`、`knowledge/ax-web-foundation`、`knowledge/ax-local-kind-environment`、`rules/ax-model-spending` と共通境界・検証原則。bundleはプロジェクトの `.space/babel`。以前の対象パス検索を再利用し、このレビューでOKFを変更していない。
