# AX内対話Runtimeの検証

2026-10-07。対象は main `a682948be9daddc37555067fd98475eb3938b427` からの `codex/ax-interactive-runtime` の未コミット差分。初期の無課金プレビューは実AX・実Webで成功した。以下は局所確認からの履歴で、最終結果は末尾に記す。

## 局所検証

- Python担当：host全135件のうち130成功、実SDK依存5件skip。固定SDK imageをnetwork noneで動かした新21件は全成功。質問と回答は別SDKプロセス、各1モデル要求・1固定操作、通常終了、成果物一致。初回の既存timeout試験のみ1失敗、その後は成功し再現条件は未特定。
- 保存担当：専用PostgreSQL schemaで新agent9件と旧data13件が成功。その後の追加境界・独立指摘への修正は再検証中。
- Go担当：局所の新Gateway/ACK喪失/既知拒否/unknown/recovery試験成功。AX patchは隔離した固定上流checkoutでcontroller/substrate race testsとserver build成功。実Actorはまだ未確認。
- 親：Web型検査と製品build成功。ブラウザ新3件成功。質問→再読込→回答→成果物、他人の閲覧/取得拒否、320px表示、axeの対象ルール違反0件、受付応答喪失、ログアウト待機停止、hydration前入力保持、CSRF失敗入力保持、停止失敗表示を確認した。ブラウザfixtureは模擬executorであり、AX停止やPGoperation台帳の証拠ではない。
- 最初のブラウザ試験2件はserver/auth.tsが検証済JWTの期限をAPIへ返していなかったため失敗。期限を返す実装へ修正後、新3件成功。既存認証ブラウザ7件は初回から成功。

## 独立レビューと対応

Python担当が親UIを読取りレビュー。hydration前入力消失、CSRF失敗時の入力消失、停止失敗表示の欠落の3件を指摘。親が修正し上記ブラウザ試験で再確認した。API停止受付が失敗するとログアウトを完了できない仕様は画面に明示し、再操作できるようにした。

同担当がGo/AX差分を独立レビューし、開始後の既知拒否でreceiptがない場合、旧finishのusage条件によりglobal枠が保持されるP1を指摘。保存担当がGateway台帳と実停止証拠から終結する分岐を修正中。未知operationは保留を維持する。

## 稼働環境の準備

親がローカルappの受付を閉鎖し、未解決/隔離0件を確認。変更前app DBのダンプをGit対象外の `ax-local/.state/runtime-backup-20261007/app.dump` にmode600で保存した。稼働DBのmigrationと配置は未実行。有料モデル要求は0件。

runner、Go controller、鍵注入を制限するAX serverを固定digestでローカルregistryへbuild/pushした。ソースの修正後は対象imageを再buildする。イメージ作成の成功を稼働確認の成功としない。

## 最初の実AX接続で検出した不一致

最終v4を適用後、実KeycloakとWebから専用Workspaceへ1件を送信した。root `45aa1d16-8e2a-4a45-8777-8a3daab3865c`、run `ax-run-5d4af8d3dc67a9a6`。Createで `credential-free template mismatch` となり、DBは未解決として全体枠を保持した。モデル/固定操作0件、開始intentなし。受付を再閉鎖し、Createの再送はしていない。

実SubstrateはActorTemplate作成時にreadiness timeoutの0を30秒へ補う。AX patchが補完前の期待値0と比較して拒否した。実テンプレートのtimeout30とenv名AX_TASK_YAMLのみ、Actorが存在しないことを担当が読取り確認した。局所fakeがこの既定値補完を再現していなかったため、期待値の正規化とRed回帰を追加中。Go/AX子unitは再開した。

元記録は `ax-local/.state/verification/interactive-2026-10-07T07-12-53-874Z-aa0a8ab8/result.json`。ブラウザは結果不明を自動再送せず終了した。稼働経路の合格として扱わない。

失効修正後はNode全97件が順次実行で成功。ブラウザの新4件と認証7件も成功した。旧チャット5件は先行版で成功し、その後チャット実装の変更はない。

## Create失敗の復旧と2回目の実経路

2026-10-07 07:26 UTC頃。v2 AX/Go imageへRecreateし、旧Pod `ax-server-6b59d5cb8c-tkgdh` の不存在、新Pod `ax-server-55c7566686-8wctd` のReadyを確認した。保存Taskのimage・command・scope・env/Workspaceなしを照合後、同一TaskのSuspendのみを明示した。Actorの実停止・worker未割当を確認し、管理用retirement証拠でcleanupを再開。以前のcreate evidenceをNULLのまま残し、失敗/resolved・deny・実停止・全体枠解放まで確認した。モデル/tool 0、start未送信のまま。

2回目はroot `1bac44c2-f95b-49b7-809e-0a9b3a09dde2`。質問区間 `ax-run-85c1708b1f1a279b` は実SDK model1/tool1、usage120、reply.txt57bytes、実停止/denyを揃え成功した。Webで質問と再読込保持を確認。回答区間 `ax-run-063623052db6c137` は新Taskとして作成されたが、別namespaceのworkerへ割当され、厳密なmTLS identity確認でstart前に保留となった。受付を閉じ、対象をSuspendしてActor停止・worker未割当を確認した。モデル/tool追加0。全経路合格とはしていない。

固定Substrateのworker割当はcluster全体であり、atespaceはworker namespaceへの配置制約ではない。Template/Actorのworker selectorはworkerのlabelsへ照合する。初期の専用pool配置仮定を見直し、信頼境界を保つ変更を比較中。ブラウザの失敗記録は `.state/verification/interactive-2026-10-07T07-27-38-785Z-d08c37b2/result.json`。

## 最終の実AX・実Web確認

2026-10-07 07:43 UTC。配置は runner `5eea9e42...`、AX `46469f27...`、execution `129475fa...`（完全なdigestは `ax-local/versions.json`）。初期専用poolは、全worker assignment 0件とPVC/Secretなしを確認して削除した。論理atespace ax-runtimeのActor/Task/記録は保持。既存ax-demoの信頼済workerを共有し、正確なSPIFFE identityとActor宛先を検査する。専用poolのselector移行案との比較は実装契約と独立レビューへ残した。

2回目の失敗区間は明示Suspend後、旧Pod `ax-server-55c7566686-8wctd` 退役と新Pod `ax-server-7995b8f99d-scqb8` Readyを確認し、cleanupだけを再開した。start未送信のままfailed/resolvedとなり、deny・Actor停止・worker未割当・全体枠解放を確認した。

実Keycloakと実ブラウザの3回目は成功した。root `8cde2bd6-8196-430c-97e8-b737c649e40e`、conversation `fca0b7b1-2423-4e24-b815-3e28f686ba88`。

| 条件 | 実測と判定 |
| --- | --- |
| 依頼→質問→回答→成果物 | start1回、answer1回。質問表示と再読込後の保持、2つの本人メッセージと2つの返答を確認。成功 |
| 区間ごとの新Task | 質問 `ax-run-13d46a5102db8525`、回答 `ax-run-1f715260d8d5ca9a`。異なるTaskで成功 |
| 実停止と通信 | 両区間の独立inspectでTask Suspended・Actor stopped・worker未割当・denyの一致すべてtrue。DB cleanupとも一致 |
| 使用量/予算 | root model2/tool2、模擬input200/output40、実作業13,272ms。各SDK receipt model1/usage120とPG一致。模擬providerのみ、課金モデル送信0 |
| 成果物 | reply.txtは回答とbyte一致、95 bytes、SHA256 `4eff65d219f52d55bc45271d90a324e0b4890752e490f888d134be489b5995bf` |
| 本人限定 | 別ユーザーBobに会話非表示、成果物404。ブラウザエラー0・未想定送信0 |
| 台帳終結 | root succeeded、2区間resolved。未解決run0・全体枠空。失敗2件も削除せずfailed/resolvedで保持 |

元証拠はGit対象外の `ax-local/.state/verification/interactive-2026-10-07T07-42-52-181Z-e942d1e4/{result.json,stopped.jsonl,reply.txt}`。パスワード・token・browser storage・生SDK履歴は公開しない。ブラウザだけで停止や費用を証明したのではなく、PGと独立inspectを併用した。

## 最終の局所確認と限界

Node97件成功。新ブラウザ4件・既存認証7件成功、先行版の旧chat5件も成功しその後chat差分はない。Python130成功/実SDK依存5skipに加え、固定SDK image内の新21件は全成功。Go全47件/race/vet/buildの後、配置補正のinspect/settings/native26件を作成者と独立担当で再確認。AX既定値補正は専用10件を含む21件/race/build成功。Web型検査・製品build・配置単独型検査・diff check成功。ACK喪失、二重回答、世代、予算、所属削除/再加入、ログアウト競合、停止、既知拒否と未知結果、本人境界は局所/ブラウザ試験の証拠であり、全障害を実clusterへ注入したとは扱わない。

有料provider、生成コード、動的install、サブエージェント、外部GitHub操作、社内API/MCP/RAG、定期実行は今回のプレビューへ実装していない。模擬の質問と回答転記を実モデルによる依頼理解とは表示しない。全通信プロトコルの敵対的隔離や本番運用の保証も、この結果に含めない。

共有pool切替後の旧ax-demo offline診断も `ax-run-b7d201741e9f342a` で成功。output.txt22bytes、費用0、独立inspectでdeny/実停止/worker未割当を確認した。診断はアプリの通常job台帳を使わない独立probeである。最後に未解決0・枠空を条件に受付を開いた。
