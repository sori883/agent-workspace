# 実作業・複数段階・登録運用の拡張

## 依頼と基点

2026-10-07。利用者は次の3つを進めるよう依頼した。スキルの拡充と隔離Pythonによる実作業、道具を使った複数段階の作業、画面からのスキル・エージェント登録と定期実行。製品のサブエージェント機能は不要。不明な製品方針は人間に確認する。スキルとプロンプトの保存先も検討対象。

基点は main `ede929ea87af8173af128e7b8706c11d1a9b16f6`（PR #19）。実モデルによる一問・一答・小さい本文生成は稼働確認済み。有料Gatewayは費用方針に従って停止中。これを自動で再開したり、予算・送信上限を今回の広い依頼だけで引き上げたりしない。

最初の利用例は、利用者回答により **CSV・Excelの集計と結果ファイルの作成** に確定した。

## 保持する条件

- AX Task内にRuntimeを置き、共通APIはTypeScriptの受付・参照を担当する。モデル鍵、本人の認可、費用の正本はTask外。
- PostgreSQLをKubernetes内に固定せず、接続先で選べる構成を維持する。
- 私有チャット・実行結果・成果物は本人限定。スキル定義の共有と、実行データの共有を混同しない。
- 信頼済みRuntimeと生成コードの実行環境を分ける。Python実行の導入前に実Actorで通信・制御RPC・ファイル・資源の境界を確認する。
- 既存の2,000円上限、少数の有料試験、未知usageと未停止runの保留を維持する。無人の定期実行には別途、限定した実行許可と費用枠が必要。
- PRは検討中の文書更新ごとに作らず、検証できた利用経路のまとまりにする。

## 人間の回答と残る確認

1. 登録するスキル・エージェントは本人用とワークスペース共有を選べる。
2. 定期実行は作成者の権限でログアウト後も動き、結果は本人限定。所属・権限喪失で停止する。

共有時の編集権限と今回の有料検証枠は下記の追加回答で確定した。残る人間確認は、定期実行で定義と入力を登録時の版に固定するか、実行ごとに最新版を使うか。共有定義を選んだことを私有チャット・成果物の共有許可とは扱わない。

2026-10-07の追加回答：本人用のスキル・エージェントもWorkspaceごとに分離する。共有用は全メンバーが登録でき、作成者とWorkspace管理者が編集できる。1依頼6モデル/8tool（Python3）/300秒/概算0.01 USD、今回検証全体0.05 USDで停止する有料検証を了承。総上限2,000円維持、有料定期実行の自動有効化は含めない。Gitは開発時の原本管理であり、実行時にGitサービスへ依存せず、製品同梱ファイルを読み込む。画面登録はapp PostgreSQLで管理する。

## 作業の区切りと受け入れ条件案

全体は複数の利用経路にまたがる大規模な機能追加。登録画面・v8保存層・Runtime・Go接続・8MiB code処理を実装し、局所試験・独立レビュー・無課金の実AX結合と配備を確認した。実モデルによるCSV集計・結果取得と本人限定も確認済み。定期実行は版選択の回答待ちで未実装。以下の利用経路を検証単位とする。

- **W1 実作業**：アップロードしたCSV/Excelを集計し、正しい数値を持つ結果ファイルを本人が取得できる。無許可の通信・秘密・他人のファイルにアクセスできず、資源超過や停止を扱える。
- **W2 複数段階**：一つのRuntimeが入力確認→必要な道具→結果確認→成果物まで進む。途中状態を保存し、失敗・再読込・停止・上限でも送信や書込みを重複させない。サブエージェントなし。
- **W3 登録運用**：画面でスキル・エージェントを作成・編集し、公開版を選んで実行できる。定期実行は実行主体、権限、時刻、費用枠、停止と重複起動を検証する。
- **W4 保存と版**：定義・プロンプト・スキル本文と参照ファイルの正本、編集権限、実行中の版固定、削除後の履歴を説明・検証できる。

新しい定義保存・ファイル転送・無人実行の構造を変えるため、既存のAX内Runtime構成を再利用しつつ、異なる保存構造を独立に比較する。各段階で局所試験・実経路検証・独立レビューを行う。設計書だけのPRは作らない。

## 担当と現在の操作

親が要件・人間確認・共通設計・統合を管理する。AのSDK指示修正とBのGo応答schema順序修正をCが独立レビューし、親が画面からの限定試験と実配備を完了した。現在は受け入れ証拠を整理し、定期実行の人間回答を待つ。担当範囲は[計画](plan.md)、現在の実装状態は`orch/`台帳で管理する。実環境操作と課金操作は親に集約する。以下の日付付き記録は各時点の履歴として読む。

基点版の固定スキルは `ax-local/task_runtime/skills/brief-v1/SKILL.md`、基本指示は `ax-local/task_runtime/adapters/interactive.py` の `make_config`。基点版のPostgreSQLには会話・実行・小さな本文成果物があり、この作業でv6/v7/v8のファイル保存・定義保存・複数段階を追加した。定期実行は未実装。現在の稼働を新しい機能の成功証拠として扱わない。

候補A/Bの作成と親の比較を実施し、[統合設計案](design.md)を保存した。[独立レビュー](design-review.md)も初期のPG中心案を推奨し、出力の非信頼性と各実行直前の権限再確認を設計へ反映した。独立担当の[隔離調査](isolation-investigation.md)で、同guestの制御RPC・UID・DNS・PID/disk上限などに追加の境界が必要と確認。生成Pythonの稼働安全性は未検証であり、既存Taskへ任意コードをそのまま追加しない。人間の回答に依存しない私有ファイル保存と無課金隔離試作を開始した。共有範囲・編集権限と新試験上限は追加回答で確定した。

## 2026-10-07の区切り

- 私有ファイル保存のunitを受け入れ済み。API/BFF/画面の送信・再送・再取得も専用DBで確認した。記録は [files-integration-verification.md](files-integration-verification.md)。実行管理にファイルを渡す部分は後続。
- 固定Pythonの試作はDockerとdirect runscで確認した。runsc内部tmpfsのinode上限が効かないことが分かり、信頼側のhost tmpfsをbindする専用profileへ分けた。最後の直接試験12件とtimeoutの保全を確認し、独立レビューH2まで解消。[runsc-probe.md](runsc-probe.md)を参照。
- host quotaのAX組み込みは、固定digest/template、cold start/golden回避、cleanupと再受付のguardを一緒に実装する必要がある。これらは [host-quota-design.md](host-quota-design.md) に整理したが、live AXを変更していない。
- 追加モデル送信・課金は0。既存の稼働DBはv5、3100/3101のWebは基点版で、新機能はまだ配備していない。検証に作ったrunsc bundleとmountは回収済み。
- ファイル保存の採用理由と固定runscの発見をOKFへ保存し、strict/drift検証がエラー・警告0件。既存の設計だけのPRは作らず、sourceを伴う提供単位の完成を待つ。

本人用定義のWorkspace範囲、共有定義の編集者、追加の複数段階試験上限は追加回答で確定した。人間確認の3件を解決して実装を再開する。次の実装単位は、AXの固定code profileと8MiB staging、Runtime→code→Runtime、その後の登録と定期実行である。全体は未完了。

## 現在地（2026-10-07 後続実装）

- v8までの専用DB/Node試験177件、型検査・build、files/library/workbenchのブラウザ8件が成功。詳細は [workbench-web-verification.md](workbench-web-verification.md)。入力・結果の本人限定、固定公開版、再送時の重複防止、途中回答、結果取得を確認した。
- v2 Runtimeは実SDK・network noneで13件と旧24件を確認し、Cの独立レビューで必須指摘なし。ビルドした新image内のコードでも13件が成功した。ローカルregistryへpushしたが実AX設定は未変更。
- Go/code境界のレビューで、trusted wait起動の不足、停止済みcode成果物を再読取りする復旧不備、code validatorの旧定義・履歴条件を検出。担当が修正と回帰を進めている。
- 実AX配備前のread-only確認で、稼働DBはv5、未解決run0・open job0・未知モデルoperation0。実モデル累計概算は0.004226 USD、今回の追加モデル送信0。Gatewayは閉じている。
- files・registry-webのv8統合、workbench-store/runtime/webの局所単位を台帳で受け入れた。全体と実AX検証は未完了。現在の実プレビュー3100/3101は基点版のまま。
- 定期実行が選ぶファイル・定義版を登録時に固定するか、毎回最新にするかを人間確認中。回答待ちの部分を確定した扱いにせず、AX統合を先行する。有料定期実行の自動有効化も承認していない。


## 2026-10-08 00時台の実AX切替・初回probe

DBバックアップとDeployment/DaemonSet/WorkerPoolの復旧資料を保護された `ax-local/.state/workbench-build-arg973la/before` に保存。publicはv5のまま受付を閉じ、通常controllerと旧workerを退役させた。全34 Actorの停止・未割当を確認し、新AX/ateapi/atelet/workerを固定digestで配備した。実配備のimage参照は同作業dirのmetadataと別の結合証拠へ記録する。

通常controllerの代わりに、model gateを閉じた専用schema/roleのprobeをidle起動。新Runtime imageを使った初回CSV/XLSX固定fixtureを一度実行した。モデル応答の保存までは進んだが、tool受付前に終了し、rootはfailed、唯一のrunはresolved。resultは `workbench_interrupted`、model_calls=1/tool_calls=0/python_calls=0、既知費用0。code Actorはまだ作られていない。元Runtime `ax-run-1233f0a9d63fb7da` のAX/Actor停止、worker未割当、egress denyをinspectで確認した。再送・同root再実行はせず、原因を調査する。

public受付は閉じたまま、probe sidecarはidle、Web3100/3101は基点版。通常controller復帰と受付再開は後続の必須作業。追加の外部モデル呼び出しは0。


初回の原因は専用seedでcode_profileを設定しておらず、v8のNULL既定値をrootへ固定したこと。Python受付の正確なprofile検査が拒否した。seedへ固定値とroot readbackを追加した。新schema `ax_workbench_probe_f374f89615db39aa` / root `811889d8-77ae-41b1-aa1a-04bcc42ef70a` に分けて設定・単一ready job・公開受付停止を照合後、2回目を一度実行した。

2回目はRuntimeのモデル/道具受付と正常停止に成功したが、code `ax-run-386e2e8fca6e4cef` のResumeでworkerが `code_quota_worker_hold` を返し、PGはblocked_unknownを維持した。code startは未実行。実OCIには固定image由来のREQUESTS_CA_BUNDLEがあり、worker validatorの許可keyに含まれていないと特定。worker PID namespaceでは /server PID1だけ、node quotaにpending/doneなし、Begin前に拒否した証拠を保存した。Actorにはworker assignmentが残るため回収未完了として扱い、再Resume/新probeは行わない。Aがvalidator修正と開始前拒否の回収設計、Cが独立回収レビューを担当する。


旧workerの同世代cleanup機能を後から導入することはできないため、C/Aの独立確認に従い管理者回収を実施。AX writerを退役し、旧worker2つそれぞれのmount namespaceで対象mount0とPID1以外の実行process0を再確認してからWorkerPoolを0へ縮退した。旧worker Pod/PID消滅後、標準DeleteWorker経路が対象ActorをCRASHED・workerAssignmentなしへ遷移した。通常のcleaned証拠は生成しておらず、専用PGのblocked_unknownを残す。専用2roleをNOLOGIN、専用schemaの受付/Pythonを閉じ、既存記録を保全した。public v5の実行結果・認可は変更していない。根拠はprobe2のretirement/host/quarantine資料。

現在 AX Deployment0、WorkerPool0。Aが将来の開始前検査失敗をdurable markerから回収できる順序・終了済み証拠再読取を修正中。Cのレビュー後、新imageと新schemaで確認を続ける。通常実行復帰/受付再開は引き続き未完了。


## 2026-10-08 00:56 probe3同世代回収と起動条件修正

修正版r2 workerでprobe3 code Actorの起動は成功した。schema `ax_workbench_probe_5bf3496ffd4703c8`、root `d99be836-004c-4100-8dab-fc81aff44007`、code `ax-run-d14c6629b50e48c3`。AXはRunningだがworkspaceReady=falseで、GoがHTTP由来Readyを待つためResumeの確認前に保留となった。さらにAの局所同image試験で、Task YAML無しのPID1はProcessService未登録と判明。固定task-fileでdebug:trueだけを渡して制御口を有効化し、direct mTLSの読取到達を確認してからtrusted waitを一度起動する修正をA/Bが担当する。

probe3は再Resumeせず、元RunWorkload/AX reconcile終了とActor RUNNINGを確認し、旧writer Podを退役。管理者が専用schemaの単一recoveryを許可し、idle sidecar内からcontroller -onceを一度実行した。codeはresolved/failed、root stopped、job done/gen2、slot解放。AX Suspended、Actor停止・未割当、denyと同一actor/worker/generation/image/profileのserver-owned cleanupを照合した。worker PID/mount namespaceを保ったままrunsc-state空、対象mount0、/server以外process0、pendingなしdoneを確認。専用schemaのgateを閉じ、role NOLOGIN/接続0へ隔離した。証拠はbuildroot/probe3のbefore/after/PG JSON。

publicはv5/受付閉、通常controller未復帰、Web3100/3101基点版。追加モデル送信0、既存概算0.004226 USD。修正の局所・独立確認後に新schema/rootでCSV/XLSXと8MiB転送を検証する。


## 2026-10-08 01:45 probe4起動後の権限診断と通常回収

r3（固定task-file/ProcessService read-only readiness）のAX/ateapi/atelet/workerを固定digestで配備し、新schema `ax_workbench_probe_778570d596775b09`、root `2fa8e110-196c-421c-a5bc-5606130049d8` でCSV/XLSXの無課金probeを一度実行。Runtime段階とcode Resume確認は成功したが、stage前のready確認で止まった。code `ax-run-901a9a69db7145a2` は作成・Resumeのみで、生成Python開始は未実施。trusted waitは `launcher.verify_layout` のUID切替後listdir（launcher.py:110）でPermissionErrorを返すことを限定読取診断で確認した。実OCIのcaps/NNP/4mount容量・所有・modeは契約どおり。rootディレクトリのmodeは未観測で、担当が原因を局所再現中。

再Resumeせず旧writer `ax-server-6dd94f666d-g9m2m` を退役し、同一worker `f233095f-5db4-4ee9-8df9-63bf540959e5` を保持したまま通常controller recoveryを一度実行。code resolved/failed、root stopped、slot解放、同じactor/worker/generation/image/profileのcleanup、AX Suspended・Actor停止/未割当・通信denyを確認。host PID1334592/mount namespace4026535177で対象mount0、runsc-state空、/serverだけ、pendingなしdoneを確認。schemaの全gateを閉じrole NOLOGIN/接続0へ隔離。証拠はbuildroot/probe4の診断・before/after・PG JSON。

publicはv5/受付閉、通常controller未復帰、Web3100/3101基点版。追加外部モデル送信0、既存概算0.004226 USDを維持。成功済みは回収でありCSV/Python実作業は未達。


## 2026-10-08 public v8移行と登録画面の実確認

旧Web/APIを停止し、public専用の更新前dump（305567bytes、SHA25635b4a1dd9e80ce63de8dd33cb0136c8ddc65d1d35eb39637abe4a2a8a509d5af、TOC374件）を保存した。v5→v8移行と最小role更新が成功。更新前dumpを独立した検証DBへ復元し、既存30表の旧column projectionを照合した。migration表の5→8を除く29表で件数・全行hashが一致。最初の復元は空DBにpublic schemaが既にあり停止したが、その空schemaだけ削除して同dumpを正常復元した。根拠はbuildroot/public-v8/verification.json。

新しいWeb/APIをNode24.15.0で起動（3100/3101）、受付は閉じたまま。Alice/Bobの既存検証userで専用Workspaceを準備し、実Keycloak→Web→API→PGでBobが共有スキル第1版を登録、Alice管理者が編集し第2版を公開、Bobが反映・編集UIを確認。Alice本人用スキルがBobの同Workspace一覧から非表示、共有スキルが表示されること、Aliceのエージェントが共有スキル第2版を選んで公開・再読込み後も固定されることを確認した。モデル送信0、入力/成果物はまだこの確認に含まない。証拠はpublic-v8/library-live.json。最初のUI helperはlogin.dataの許可漏れでログイン前に停止し、helperを補正後に成功（製品の変更なし）。

公開DBはv8になったため旧baselineをそのまま戻して稼働させない。実行controllerはまだ専用probeで、public受付/有料/Python gateは閉。新codeのprivate-root権限修正を局所Red→Green＋独立レビューし、r4 imageを実AXへ切替中。

## 実Actorの集計と単一8MiBの確認（2026-10-08 JST）

root権限0700を維持したdirfd修正r4を実AXへ配備した。probe5でRuntime→code→Runtimeの3段が成功し、CSV合計300とExcel合計30を出力bytesと独立したExcelセル読取で確認。実rootfsのmode700も観測した。probe6では単一8MiBの全256chunkを往復し、全bytes/hashが一致、active_ms=144968で300秒以内だった。両方ともモデル送信なし、全run resolved、Actor停止・未割当・通信deny・同一世代のhost cleanupを正式APIで再確認し、専用gateとroleを閉じた。固定のモデル提案を使った結合試験であり、実モデルの生成成功とは区別する。

永続的な抜粋と元証拠hashは [actual-ax-fixtures.json](evidence/actual-ax-fixtures.json)。4ファイル合計8MiB、隔離境界、通常controller復帰と旧経路の回帰、承認済みの最少有料UI試験は続行中。定期実行の版選択は回答待ちで未実装。

## 無課金結合完了と通常controller復帰（2026-10-08 JST）

probe7は非整列4file・計8MiB、259+259chunkを153213msで全量転送し全hashが一致。probe8は権限/FD/env/書込・network/process/control syscall境界の固定ケースを66426msで完了。双方の各3runと正式Actor APIの停止・deny・未割当、同一host cleanupを照合し、専用gate/roleを閉じた。永久excerptは [actual-ax-fixtures.json](evidence/actual-ax-fixtures.json) に4ケースを収録。C独立レビューは追加必須指摘なし。失敗注入の全組合せを実Actorで行ったという主張には広げない。

通常controllerをr3、code/worker/ateapi/ateletをr4の固定digestで戻し、モデルを閉じた状態で起動とloopback限定・Serviceなしを確認。実Webの旧v1 previewで質問→再読込→回答→成果物を成功し、Bob拒否・2runのPG/Actor停止を確認。旧offlineも1回成功し、成果物の再読込、PG/Actor停止を確認。総既知費用は0.004226 USDのまま。temporary offline helperは初回TS変換時点で停止し、ESM拡張子に修正後1件だけ受付した。

public v8の配備・無課金回帰の証拠はbuildroot/public-v8。続けて承認済み最少有料UI試験のため、一度受付を閉じ、未解決0/費用据置を検査後、trial gateとGatewayを限定有効にした。結果が不明なまま再送せず、終了後は再び両gateと鍵mountを閉じる。

## 初回の有料UI試験と修正対象（2026-10-08 JST）

実Keycloak・Webから15bytesのCSVを一度uploadし、1回だけmodel依頼を受け付けた。root `a1779b3b-e299-4e68-b04a-c8d1006aedd8` はmodel1/tool1/Python0でwaiting_input。モデルがファイル調査の予告をquestionとして提案したため、集計成果物は作られておらずUI試験は不合格。PG/Actorの既知usage・停止・deny・未割当を確認後、通常UIでこのrootを1回停止し、trial/Gateway/key mountと専用secretを閉じた。追加概算0.0004405 USD、総既知概算0.0046665 USD、未解決run0。記録は [paid-trial1.json](evidence/paid-trial1.json)。

同条件の再送はしていない。Aが、添付から分かる事実と利用者判断を要する条件を分けるprompt/固定skillの限定修正を担当し、Cが独立レビューする。新たな少数試験は原因・修正と無課金検証を確認してから判断する。予算・権限・正当な質問は変更しない。

## 調査と質問を分ける指示の修正（2026-10-08 JST）

Aがv2 system promptと固定tabular skillだけを変更し、添付fileの調査にはPython、質問には未指定の利用者判断を使う条件を明記した。Cは旧fa9とのAST/ソース照合と範囲を独立レビューし追加必須指摘なし。親は正式Dockerfile.taskからruntime `sha256:745e2f4527f80c0fe64a7d292514357444ab27f7f3ccbf9116dc36ea2a0815de` をbuild/pushし、source mountなしの固定SDK15件（skip0、9.136秒）とimage全16fileのhash一致を確認。旧fa9との差分もこの2ファイルだけだった。証拠は [runtime-inspection-prompt.json](evidence/runtime-inspection-prompt.json)。実モデルが適切に提案するかは次の1件で確認する。

## 2回目の有料UI試験（2026-10-08 JST）

新Runtime745でも root `ace6d772-46bc-4506-928f-97e739a55ed0` は model1/tool1/Python0、waiting_input となった。モデルが未読のCSVについて空・amount列なしと推測し、集計は未達。実際のSDK mailboxには現在の指示、許可Python、input_1・15bytes・正しいhash・集計要求が含まれている。プロンプト修正だけでは解消しなかったため、配備Gatewayの実payloadとschema、SDKの追加指示を照合する。正常な質問をPythonへ強制変換せず、同条件の自動再送は行わない。

PGusage精算・全Actor停止/deny/未割当を確認し、通常UIで1回停止。trial/Gateway/mountを無効化、専用Secretを削除し、無課金の通常受付だけ再開済み。追加概算0.00053325 USD、既知累計0.00519975 USD、未解決0。証拠は [paid-trial2.json](evidence/paid-trial2.json)。

## SDK指示の置換と3回目の限定試験（2026-10-08 JST）

SDK0.1.20では文字列system_instructionsが既定指示への追記になることを実要求で確認。公開CustomSystemInstructionsによる置換へ2行だけ変更し、修正前Red/修正後16件成功、正式9eb481dc image内16fileのhash一致とC独立レビューを確認した。文言・skill・v1・予算・権限は不変。証拠は [runtime-custom-system.json](evidence/runtime-custom-system.json)。

3回目root `e3d09b17-0ad1-4c45-a9a2-32982b04184d` は「これから調査・計算する」というoutputで終了。model1/tool1/Python0、成果物なしで集計試験は不合格。プロトコル上のsucceededは依頼達成を示さず、UIの取得検証が失敗を検出した。全run usage精算/Actor停止/deny/未割当後にtrial/Gateway/key mount/Secretを閉じ、無課金受付だけ再開した。追加0.0004025 USD、累計0.00560225 USD。[paid-trial3.json](evidence/paid-trial3.json)。SDK既定指示の除去だけでは解消しなかった。Go mapの応答schemaがPython枝をinput_aliases先頭、text枝をkind先頭へ直列化し、モデルの操作選択より前に枝を分けている可能性を、実wireと公式のキー順仕様で確認する。

## schema順序の修正と実モデル集計の成功（2026-10-08 JST）

Goのmapがschemaのpropertiesを辞書順へ並べていたため、text枝はkind先頭、Python枝はinput_aliases先頭だった。両枝をkind先頭にする固定structへ変更した。旧schemaとのparse後完全一致、実wireの順序、count/生成/保存SHAの同一性を確認し、Gateway12件race/vetとC独立レビューが成功。正式controller81adをビルド・配備した。初回のnetwork-none buildは依存取得で停止し、同じ固定依存の通常buildで成功した。 [gateway-schema-order.json](evidence/gateway-schema-order.json)。

4回目root `bee233e5-d345-4bd2-91c4-5b863afcbd8a` は、実モデル→隔離Python→実モデルの3 Taskで成功。CSVの100+200=300をsummary.csv実bytesで確認し、画面からの取得・再表示・同じWorkspaceのBobによるroot/入力/結果の拒否が成功した。model2/tool2/Python1、active72281ms。全3runのusage精算・Actor停止/deny/未割当と、codeの同一actor/worker/generation/image/profile/cleanedをPGと正式inspectで照合した。 [paid-trial4.json](evidence/paid-trial4.json)。

この成功試験は概算0.00119475 USD。今回4試験・生成5回の追加計0.002571 USD、過去込み既知概算0.006797 USD。失敗3件も費用・履歴を保持し、同条件の自動再送は0。成功後は追加試験せず、trial/Gateway/鍵mountを無効化し専用Secretを削除、無課金受付を再開した。Web/APIは現在ソースで稼働中（session97673）。

W1/W2は今回のCSV実モデル例とExcel/8MiB/境界の固定提案例で確認、W3は登録・編集・版選択の経路を確認、W4は保存と私有・共有の境界を確認した。任意の自然言語依頼が必ず成功する証明ではない。定期実行は版選択の人間回答待ちで未実装のため、3機能全体を完了にはしない。
