# Runtime・ファイル・逐次code Taskの統合契約案

2026-10-07、C。基点 `ede929e`、`codex/agent-workbench` の既存実装と今回の作業中資料を限定読取りした結果。**当初の統合契約と、末尾のv8確定契約**を記録する。前半は調査時点の案、末尾は実装・専用DB試験に対応する。稼働適用と実Actor検証は未実施。親は旧API分離・既存実行経路への合流・累積を維持する版別費用guardを採用。8 MiB profileとcleanup証拠の取得方式は後続小単位で固定する。

## 採用済み構成へ足す最小単位

既存のTypeScript API、app PG、Go controller、AX内Runtimeを維持する。Go controllerにcode用Executorを追加し、同じ `ax_runs / ax_jobs / ax_execution_slot / ax_effects` でRuntimeとcodeを一つずつ実行する。新daemon、別の受付台帳、費用台帳、再送キューは作らない。

Runtimeは初期統合でも**1区間につきモデル1回と提案1件**を返して終了する。提案をPGに確定し、旧Runtimeの実停止を確認してからcode Taskを新規作成する。codeの結果をPGへ封印し、実停止とhost quota解除を確認してから新しいRuntimeを作る。複数段階の継続はアプリのcheckpointを使い、SDK・Pythonプロセス・Task snapshotを復元しない。製品のサブエージェント機能は追加しない。

参照する確定条件は [task.md](task.md)、[design.md](design.md)、[registry-contract.md](registry-contract.md)、[host-quota-design.md](host-quota-design.md)、[runsc-probe.md](runsc-probe.md)。旧v1 Runtimeを拡張して読めなくするのを避け、新しいworkbench protocolと公開endpointに分ける。

## 現コードの制約と変更入口

| 根拠 | 現在の制約／統合時の対応 |
| --- | --- |
| `web/data/schema-v4.sql:2–29`、`schema-v5.sql:81` | rootは3model/2tool、segmentは最大2、旧会話も最大2往復として作る。v8の版別制約へ変更し、旧rootの上限・mode・profileは変えない |
| `web/shared/agent-contracts.ts`、`web/data/repository.ts:59,121` | 旧応答はstrict、run・会話はv1 request/短文artifactを検証する。v2の内部attemptを旧一覧へ混ぜると一覧全体が壊れるため、互換projectionを無理に作らず除外する |
| `execution/controller/controller.go:17,38,144,299` | claim→intent→外部操作→evidence→collect→deny/suspend→finishを再利用する。Task切替はfinishのPG transactionでのみ行う |
| `execution/controller/interactive.go:34,105`、`web/data/schema-v5.sql:156,183,209` | mailbox予約→count→送信直前認可→生成1回→実usage精算を維持。tool提案の受理とPython実行の完了を別の事実として記録する |
| `execution/native/protocol.go`、`native/adapter.go:417,469` | Request inputs計4 KiB、artifact64 KiB、RPC応答128 KiB。8 MiBを従来request/Collect/base64一括へ載せない |
| `ax-local/task_runtime/interactive_protocol.py:10`、`adapters/interactive.py:197,218` | brief-v1固定、提案はquestion/output/unsupported、SDK toolなし。v2だけ定義bundleとpython提案を扱い、SDKの任意tool・shell・subagentは引き続き無効 |
| `web/data/schema-v6.sql:58,120,133` | 本人＋Workspaceのreadyファイル、8 MiB/件、32 KiB/chunk、封印後不変を再利用する。execution roleに一般の本人指定読取り関数を開放しない |
| `ax-local/code_runtime/launcher.py:22`、`host-quota-design.md` | 現試作は入力合計4 KiB、host input64 KiB/output1 MiB。8 MiB成功とみなせない。専用profile、launcher、AX/Substrate固定digestの同時更新と実Actor試験が必要 |

## 公開APIと互換性

新しい `/v2/agent-roots` をworkbench用とする。認証・内部API token・選択Workspace header・BFFのOrigin/CSRF・no-storeは既存の共通経路を通す。APIが確定したownerとWorkspaceだけをDBへ渡す。本文からowner・予算・image・atespace・接続先を指定させない。

| 操作 | 入出力案 |
| --- | --- |
| `POST /v2/agent-roots` | `{key, text, mode, allow_model?, agent_version_id?, input_file_ids:[]}`。modelは明示true、公開版ID又は製品同梱の固定版を使用。返却 `{root_id,run_id,replayed,protocol_version:2}` |
| `GET /v2/agent-roots`、`/:id` | 本人＋現在Workspace。一覧50件/ページ。詳細はroot状態、revision、現在stage、実費/予約/残枠、質問、段階の要約、出力file ID。bytes・任意長ログ・全定義本文を埋め込まない |
| `POST /:id/answer` | `{key,question_id,expected_revision,text}`。保存済み入力fileと定義版を引き継ぐ。本人の新しい検証済みgrantだけ更新できるが、予算・消費・送信済み操作はリセットしない |
| `POST /:id/stop` | 既存同様に本人の明示停止。cleanupは利用者の失効後も限定した運用権限で継続 |
| `POST /:id/recover` | 実行の観測・回収・停止だけ。未完codeの再Startや新Runtimeの自動生成許可にはしない |

新規受付・answerは同じowner/keyについて元payloadの正規化規則を固定してhashを保存する。照合は定義の再展開や新しいrun ID採番より先に行い、transaction内でも再確認。同key異本文は409、同一なら元IDのみ返す。GETも再送もworkerを増やさない。503で受付不明なら元body/keyを保持し、一覧/詳細確認か同一再送だけを案内する。

旧 `/v1/agent-roots` と `/v1/runs`、旧会話API・旧profileは従来どおり。v2 root/内部attemptは旧一覧から除外し、旧詳細/変更APIでは既知IDでも404または専用の管理対象拒否を返す。v2内部attemptの `ax_runs.conversation_id/sequence/parent_run_id` はNULLにして、従来chat turnを水増ししない。rootの所有・Workspace・履歴はPGのroot関連表で引き続き持つ。v8ではrootのconversation_idを版別制約（v1は既存非NULL、v2はNULL）へ変え、空の旧conversationを作らずv2 checkpointを会話履歴にする。

## v2の小さい実行要求と提案

共通claimの `request` を版で判別する。v1は現在の型を変更せず、v2は `schema_version:2, run_id, root_id, adapter:interactive|python, checkpoint_revision, descriptor_sha256` を持つ厳密な型にする。segmentのattempt_kindとadapterは対応を固定する。claim内の不変manifestは固定image/profile/atespaceと一致することをGoとPG双方で検査する。descriptorはPG由来の小さいJSONで、binaryや未封印データを含めない。

Runtime descriptorは、依頼本文、bounded履歴、入力の `{alias,file_id,name,size_bytes,sha256}`、出力要約、定義公開version ID/shaと依存version ID/shaを持つ。モデルへ渡すfile識別にはaliasを使い、任意file IDを生成させない。Runtimeはfile本文を自由に読めず、初期はcode toolに集計・先頭行確認を依頼する。定義や以前のcode出力は命令/データの区分を明示し、権限やimageの根拠にしない。

v2提案は次の厳密なunionにする。

```text
{kind:"question"|"output"|"unsupported",text:string}
{kind:"python",source:string,input_aliases:string[],
 outputs:[{name:string,size_limit_bytes:integer}],purpose:string}
```

pythonのsource上限4 KiB、output宣言はCSV/XLSXの安全なbasenameのみ、URL・command・package・env・mount・絶対pathの指定fieldは持たない。`input_aliases` はrootに結び付いたreadyファイル又は前段で確定した出力だけ。初期の候補上限は入力最大4件/合計8 MiB、出力最大4件/合計8 MiBで、1件の8 MiBを搬送できる。個数・総量は実装前にA/親と固定する技術的提案であり、現在の試作の達成値ではない。

同じmailboxのseq1=model、seq2=提案という小さい方式を再利用する。v2 mailboxには版を明示し、元bytesのhashで照合する。python提案を許すのは固定tool権限と現在の定義利用権があるrootだけ。モデルの出力提案とseq2本文を照合してPGへ保存したら、返すACKは「提案受理/hand-off予定」を意味し、「Python成功」を意味しない。RuntimeはこのACK後に短い段階receiptを書いて終了する。Pythonの成功/失敗は別attemptの確定結果である。

定義bundleはv7の `DefinitionRepository` と公開版正本を再利用する。start時に公開version ID・sha・全skill依存を固定し、毎段の新規実行時に現在の利用権・archive状態を再検査する。共有定義を使ってもroot/file/resultは実行者本人のまま。bundleの全量は最大128 KiB×依存件数になり得るので、従来inputs4 KiBへ押し込まない。版/hash固定のbounded chunk転送を使い、モデルへ入れる本文量はcountTokensで判定する。初期は収まらない定義を明示拒否し、黙って別版・最新版本文・部分切捨てへ変えない。登録scriptをRuntime内でexec/importする入口は作らず、実行するならPython提案と同じcode Task境界へ通す。

## 8 MiB搬送と出力の封印

既存mTLS guest RPCから固定runnerの操作だけを呼ぶ。別HTTP待受、任意URL、guestのDB資格情報を増やさない。全fileをメモリやargvへ一括展開せず、DBとguest間で32 KiBずつ処理する。最大base64は43,692文字、frameは64 KiB以内とし、decode前長さ・canonical base64・index・期待chunk長・全体size/hashを検証する。

| 固定操作候補 | 契約 |
| --- | --- |
| `stage-begin(descriptor)` | run ID、image/profile、descriptor hash、入力alias/bytes/hashを確定。root-owned stateへ原子的保存。同じ内容のみ再生、異なる内容は拒否 |
| `stage-chunk(run,descriptor_hash,alias,index,base64,sha256)` | 開始前の入力領域だけへwrite-once。既存chunkが同bytesなら成功、異なるなら拒否。名前はaliasから固定pathへ写し、pathを引数にしない |
| `stage-seal(run,descriptor_hash)` | 全chunk数/bytes/hashを検査してmanifestを原子的に封印。以後変更拒否。封印済みreadbackをPG stage evidenceへ残す |
| `code-start(run,descriptor_hash)` | 既存 `ax_intent(start)` の一度限りの送信権でのみ呼ぶ。入力封印・全profile検査・remaining deadline確認後に子を1回作る。Start不明時にこの操作を再送しない |
| `code-status / output-manifest` | 信頼した親runnerが子のwait完了後に生成。codeの自己申告JSONを終了/資源/料金の証拠にしない |
| `output-chunk(run,output_manifest_hash,alias,index)` | 終了後に固定された通常fileだけを32 KiBで読む。同じmanifest/bytesを繰返し読める。sourceを実行・再生成しない |

子の終了後、親runnerがsymlink、device、FIFO、socket、hardlinkなどを拒否し、dirfd/NOFOLLOWで通常fileを検査する。内容/合計量/file数/hashを検証してimmutableな回収対象にする。APIへ公開するready状態への遷移は外部PGで全chunkが揃ってから。一部回収のfileを成功成果物として公開しない。

PGの入力読取り関数は `(run, generation, controller, file_id, index)` を受け、current claim、root owner/Workspace、rootに固定した入力集合、ready/hash、現在の所属/定義利用権/stopを確認する。execution roleが任意ownerを指定して `ax_file_read_chunk` を直接呼べる権限は与えない。chunk途中の失効は次readとStartを拒否してcleanupへ進む。

出力には `(run, output_alias)` 一意の内部importを使い、owner/Workspaceはrootから導出する。宣言した容量をcode開始前にv6と同じquotaロックで予約し、通常uploadとの並行超過を拒否する。内部uploadは利用者の途中cancel対象・未完了一覧へ混ぜず、seal後だけ通常fileとして返す。占有量は予約と実bytesで二重計上しない。失効後も同じclaimの既知出力を保存/封印する限定権限は許容するが、新入力の読取り・新code開始・本人への公開認可とは区別する。

未知の停止・回収が残るimportは取消で枠を空けない。実停止と未送信/欠損が確定した場合だけ内部importをfailed/cancelledとして解放する。既にreadyの成果物を回復処理が自動削除しない。

## PG状態と全体実行枠1

rootは既存stateを維持し、`stage` にruntime/code/collecting/stoppingを追加する。各Taskは異なるrun IDを持つ同じ `ax_runs` の行。1 root内の連番は `ax_agent_segments` 側に持ち、`attempt_kind` でRuntimeとcodeを区別する。モデル操作はRuntime segmentだけに所属する。

```text
runtime accepted → 実行 → 提案確定 → 回収 → deny/Suspend/実停止
  ├ question → waiting_input（slot解放）→ 本人answer → 新runtime
  ├ output/unsupported → succeeded/failed（slot解放）
  └ python → 新code accepted → 封印入力搬送 → Start → 子終了/出力PG封印
                 → deny/Suspend/実停止＋host cleanup → 新runtime accepted
どこかが不明 → blocked_unknown＋既存global hold（次Taskなし）
```

`ax_finish` のv8分岐が、一つのtransaction内で旧attemptのresolvedを確定し、checkpointを追加し、必要なら次 `ax_runs/ax_jobs` を1件だけ作ってslotをそのrunへ移す。slot lock保持中に共通guardを再検査するので、別のrunが間へ入らず、停止前の次Taskも作らない。次を必要としないときだけslotを空にする。独立した二段階の「slot解放→APIから再受付」は採用しない。

次attemptは `(root_id, predecessor_run_id)` の一意制約、進行はexpected revisionで固定する。finishのACKが失われてもreadbackが同じ次runを返す。通常finishにより作られた未着手の次jobは既存controllerのclaim対象だが、前attemptがheld/unknownなら作らない。既存recoverで回収/停止できた場合はrootを停止状態へ確定するだけにし、自動で有料後続を生成しない。

次段階のguardが失効・費用・時間を理由に拒否しても、直前attemptの既知結果/実費/停止確定をrollbackしてはならない。旧attemptをresolvedとしてcommitし、次jobは作らずrootをstopped/failedへ確定する。台帳破損や停止不明の拒否はholdと区別する。finishの再生を先に照合してからcurrent claimを要求し、完了した旧claimのACK再取得を新しい外部操作へ変えない。

codeの停止完了はActor SUSPENDED/worker未割当だけでは不足する。固定profileを扱うSubstrateの正常Terminate/Checkpoint応答が、sentry/gofer/子の不在→通常unmount→quota mount不在→耐久完了記録を含むことを実証する。controllerがactor UID/worker世代/profileへ束縛されたhost cleanup証拠を取得してPGへ保存する。証拠の取得口はA/親で未確定。guest receiptや単なるNotFoundを代用しない。

ロックは、既存owner grant advisoryとWorkspace→global→claim/rootの順を拡張し、rootを取った後に新たなWorkspace lock待ちを作らない。current claimの検査もjob/runをロックするため、v8のfinish/intent/reserveの実装時に取得順を明示し、API start/answer/revokeと所属失効を含めて照合する。file容量操作はv6同様にWorkspace→quota advisory→fileで行い、chunk transactionからglobal slot待ちを作らない。file seal・definition参照を含む実際のSQLで並行試験が必要。権限失効は既存のpermanent stop/revoked-tokenをv2にも適用し、再加入で旧grantを復活させない。

## 費用・回数・時間

新しいrootにだけ不変の `workbench-trial-2026-10-07-v1` 実行policyを付ける。料金profileとは別の実行制限であり、モデル/料金は既存の固定profileを再利用する。HTTP payloadからpolicyや閾値を自由選択させない。modelのexplicit consent、Goのモデルgate、DBのtrial gateが全部必要。gateは既定false、今回の限定検証後に閉じる。有料scheduleは対象外。

| 判定 | v2 trial案 |
| --- | --- |
| model送信 | root合計6回。Count後のPG送信権付与で一度だけ増加。生成再試行0 |
| tool受理 | root合計8回、うちpython提案最大3回。question/outputを含む提案1件を1回と数え、chunk、status、ACK再生では増えない。Python数は提案受理時に予約・消費し、Start失敗でも戻さない |
| input/output | **1生成あたり**input6000、output512（思考込み）。Countは6000−128以内、maxOutputTokensは512以下。実usage差の絶対入力保証はしない。旧v1のroot累積6000/512や生成256の扱いは変更しない |
| root費用 | 全段階の実費＋未精算予約＋次予約が概算0.01 USD以内。1生成の最大予約は6000×0.25/1M＋512×1.50/1M＝0.002268 USD（固定の現料金profile） |
| 今回の検証 | 親採用の保守的な扱いとして**過去分も含む通算**実費＋未精算予約＋次予約が概算0.05 USD以内。今回分だけで0.05を使い切る枠を新設しない |
| 時間 | root合計300秒。v2は各attemptの最初のcreate intentから実停止/host cleanup確認までをPGで加算し、搬送・モデル・codeを含む。利用者の回答待ちは除外。cleanupは超過後も実施し、実測超過を隠さず保存する |

費用正本は `ax_paid_total(true)` を維持する。ownerなし旧antigravityの費用、v1/v2全model operationの実費と未精算予約を含め、root result由来の料金を重ねて足さない。累積リセット、月変更、trial再作成、新ログイン、answerで枠を戻さない。root内合計も同じoperation行から計算する。

`ax_guard` の台帳整合・未解決・未知usage・有料失敗審査を共通private helperへ分け、全writerが使う。旧paid受付は通算0.01 USDの判定を維持する。v2受付と継続だけ、DBが確定した不変policyとtrial gateに基づき通算0.05へ分岐する。新trialで累計0.01を超えれば旧paid経路は停止するのが意図した動作。文字列adapterや公開helper直呼びで新閾値を選べないようrole権限を閉じる。

reserveとCount後の送信直前に、current claim・所属/本人・定義利用権・grant期限・stop・残時間・両費用枠を再検査する。既知usageは提案不正/超過でも実費を保存してfailed/追加送信停止とし、例外rollbackで消さない。Generate/usage不明は予約を保持してglobal hold。Pythonにモデル料金はないが、以前の料金とunknownは消さない。countTokens・円換算・請求遅延を含む全請求の絶対上限保証とは区別し、総2,000円と少数試験の運用条件を維持する。

## schema-v8と公開関数候補

v7はregistry用に予約済み。v1〜v7の既存SQL本文は編集せずv8 migrationを追加する。旧履歴はruntime_version=1として扱い、旧request bytes/hash、receipt、定義や費用の意味を再生成しない。

| 対象 | 最小の追加 |
| --- | --- |
| `ax_agent_roots` | protocol/runtime version、immutable execution policy、definition version/hash依存manifest、python_calls。CHECKは版ごとに旧3/2/90秒と新6/8/3/300秒を区別 |
| `ax_agent_segments` | `attempt_kind`、predecessor_run_id、checkpoint revision、固定descriptor bytes/hash、code profile。旧最大2の制約を旧版限定にし、新版はRuntime最大6＋code最大3の有限数で検証 |
| `ax_agent_operations` | 費用/予約/送信権/ACK正本を再利用。v2 toolのpython提案を保存し、tool ACKは不変の受理結果。Python結果でACKを上書きしない |
| root input/checkpoint | root owner/Workspaceとfileの複合FK、alias/size/hash、入力/出力の参照、質問/回答とbounded要約。checkpointは追記型でprevious revisionを持つ。実費・送信権を別保存しない |
| `ax_files`内部import関連 | originと `(run, output_alias)` 一意関連、予約容量、宣言hash/実hash、sealed状態。bytesはv6 chunksを使う。別オブジェクトストア・別ファイル正本は作らない |
| code cleanup evidence | `ax_observations` にactor/worker世代/profile/確認事項を保存。code版のfinishはこれを必須にする。ホストmarker自体は費用や受付正本にしない |

実行側共通関数 `ax_claim / ax_heartbeat / ax_intent / ax_evidence / ax_collect / ax_finish / ax_fail` は既存と同じ入口を維持し、v2を厳密分岐する。GoのClaim decoderも版で分岐し、未知版は操作前拒否。旧関数をrenameして残す場合はPUBLIC/API/executionの旧helper直接EXECUTEを剥がす。

追加する限定関数候補は次のとおり。

```text
API role:
  ax_workbench_start(owner, workspace, payload, verified_grant, proposed_ids)
  ax_workbench_answer(owner, workspace, root, payload, verified_grant, proposed_run)
  ax_workbench_list/get/stop/request_recovery(...)
Execution role（常に run, generation, controller を照合）:
  ax_workbench_input_manifest/read_chunk(..., file_id, index)
  ax_workbench_definition_chunk(..., version_id, index)
  ax_workbench_output_begin/put_chunk/seal(..., output_alias, ...)
既存Gateway入口のv2分岐:
  ax_agent_reserve / ax_agent_authorize_generation / ax_agent_settle
```

最小案では「次段階を作る」公開関数は追加せず、`ax_finish` 内部のprivate helperに閉じる。output sealやstageの再送は同bytes・同manifestのみ再生可能で、外部Startの再送権とは結び付けない。所有・Workspace・定義利用権を検査する関数を、cleanupの限定権限で代用させない。

## 不明時の扱いと必要な検証

| 不明/失敗した地点 | 許す処理／次Task |
| --- | --- |
| API受付のACK喪失 | 同key照合・GET。新keyで再開しない |
| chunk/封印ACK喪失 | 同じbytes/hashの再送又はreadback。Start許可は別に必要 |
| model予約/送信ACK/usage不明 | 既存hold、予約維持。Generate再送不可 |
| 提案ACK喪失 | PGにある同じACKだけ再生。python attemptを2件作らない |
| create/resume/Start不明、lease喪失 | 既存retirement/明示復旧へ。codeを再起動しない。NotFoundだけで未実行としない |
| codeが既知エラー | wait/回収/実停止を確定して結果を記録。初期はroot failedで止める。自律的な再生成・再試験は新提案の明示契約を後続で追加するまで行わない |
| 出力回収中にTask/node喪失 | 確定済みPG chunk/readyは保持。欠損を成功扱いせず、同codeを再実行して補わない |
| cleanup/host mount不明 | root/global hold＋worker全新規workload停止。新Runtimeも開始しない |
| finish transaction ACK喪失 | 旧runと一意の次runをreadback。旧run復旧を新しい開始理由にしない |

次の小単位は、(1)Aの現在の固定code profile/host lifecycle完成、(2)別の8 MiB profileとcold/cleanup証拠の実Actor成立、(3)PG v8の版別guard/逐次slot/限定roleと無課金fixtureでchunk＋Runtime→code→Runtime、(4)SDK/実モデルの最少検証、の順。親の指示どおり8 MiB対応の成立までRuntimeのPython gateを開かない。fixtureは同時Actor0/1、停止前handoff拒否、各ACK喪失、失効/再加入、同key、wrong file/Workspace、8 MiB exact/chunk欠損/hash不一致、元file不変、成果物全bytes一致、code host cleanup、旧preview/有料guardとownerなし費用維持を確認する。32 KiBごとの固定RPC搬送が300秒内に収まるかも実Actorで測り、間に合わない場合は安全境界を維持した搬送最適化を先に行う。

当初調査時点のdirect runsc試験は隔離の成立材料であり、8 MiB profile・AX cold start・host cleanup証拠・本統合の成功証拠ではなかった。その時点ではsource以外の照合・実行は担当していない。後続のPG実装・検証結果は次節と検証記録へ分ける。OKFへの保存と全体の受け入れは親へ渡す。


## v8の確定契約（2026-10-07、保存層実装後）

この節を前半の仮の関数名・型より優先する。`schema-v8.sql` だけを追加し、v1–v7のSQLファイルは変更しない。`WorkbenchRepository` はDB接続だけを受け、image/profile/gateは運用者の `ax_workbench_control` に置く。trial/Pythonは既定false。start時にimage/profileをrootへ固定する。PG局所検証は [workbench-store-verification.md](workbench-store-verification.md) に記録する。

受付本文は `{key,text,mode,allow_model?,agent_version_id?,skill_version_ids?,input_file_ids}`。skillのみ指定は最大8公開版、agentと非空skillsの同時指定は拒否。agentを使う場合はagent先頭とそのskill依存配列順、それ以外は指定skill配列順を保存する。agent指定時だけallowed_toolsのPython許可を要求し、builtin/単独skillは製品固定Python権限を使う。すべて現在の利用権を再確認する。

公開SQL署名:

```text
ax_workbench_start(owner uuid,wid uuid,payload jsonb,proposed_run text,
                   expires double precision,token_hash text) -> jsonb
ax_workbench_answer(owner uuid,wid uuid,root uuid,payload jsonb,proposed_run text,
                    expires double precision,token_hash text) -> jsonb
ax_workbench_list(owner uuid,wid uuid,before_id uuid DEFAULT NULL) -> jsonb
ax_workbench_get / ax_workbench_stop / ax_workbench_request_recovery
                   (owner uuid,wid uuid,root uuid) -> jsonb
```

API roleは上記6関数だけを追加する。実行roleは共通ax_claim/intent/evidence/collect/finish等を維持し、次の限定関数だけを追加する。先頭の `claim` は `(run text,gen bigint,controller text)` を表す。

```text
ax_workbench_input_manifest(claim) -> input reference[]
ax_workbench_read_chunk(claim,fid uuid,part integer) -> hex string
ax_workbench_definition_chunk(claim,vid uuid,part integer)
 -> {version_id,kind,sha256,size_bytes,chunk_count,index,content_base64}
ax_workbench_output_begin(claim,output_alias text,size_bytes integer,digest text)
 -> {file_id,replayed}
ax_workbench_output_chunk(claim,output_alias text,part integer,bytes bytea)
 -> {ok:true,replayed}
ax_workbench_output_seal(claim,output_alias text) -> {file_id,replayed}
ax_workbench_cleanup(claim,value jsonb) -> void
```

file chunkは32 KiB。definitionはv7 canonical content bytes（公開SHA対象）を返す。一般file/definitionの読取り権限をexecution roleへ追加せず、現在のclaimとroot固定参照に絞る。出力はcodeの固定宣言aliasだけ。内部uploadingは本人の通常file APIからも非表示・取消不可で、停止確認後に未完分を解除する。quota予約と既存file容量は同じロックで足し合わせ、seal後のbytesを二重計上しない。

v2 claimは旧共通9field（run_id,generation,kind,request,image,manifest,result,effects,lease_until）＋workbench。旧v1のagent fieldは付けない。

```json
{"version":2,"attempt_kind":"runtime|python","execution_policy":"workbench-trial-2026-10-07-v1","mode":"preview|model","profile_id":"固定profile","remaining_ms":300000,"descriptor":{"version":2,"root_id":"UUID","instruction":"現在の依頼","definition_manifest":[{"id":"UUID","kind":"agent|skill","sha256":"64hex","size_bytes":1}],"code_profile":null,"inputs":[],"outputs":[],"history":[],"code":null}}
```

`inputs` は `{alias,file_id,name,size_bytes,sha256}`、`outputs` は `{alias,name,size_limit_bytes}`。runtime inputsは元4件＋過去出力最大12件のmetadata、code inputsは選択した4件/合計8 MiBだけを提案順に並べる。code descriptorだけ `code_profile=host-quota-8m-v1` とpython提案全体を持つ。出力aliasは `output_<segment連番>_<1始まり連番>`。出力名は先頭英数＋`[A-Za-z0-9_.-]{0,58}`＋`.csv|.xlsx`（最大64 ASCII文字）。

historyは保存済みstart/answerの `user_start/user_answer` と結果checkpointを実行順にまとめた `{kind,text}`。canonical UTF-8（PG ax_json compact、Python sorted keys）でhistory最大16 KiB、descriptor全体最大40 KiB。超過時は直前の結果と精算を残し、次Taskを作らずrootを失敗終了する。前の回答や長いログを黙って切り捨てない。stageのencoded frameは64 KiB以内。

`ax_collect` はartifact引数NULL、厳密9field `{schema_version:2,run_id,adapter,status,exit_code,error_type,summary,usage,estimated_usd}` を受ける。summaryは8 KiB、exit_codeは非負整数、成功はerror_type=null、usageはnull又は5field非負整数、費用はnull又は非負数。guestの値を料金正本にせず、finishで既存model operationの実usage/実費と照合・補完する。精算済みの費用は不正な提案・収集結果・後続生成失敗でも巻き戻さない。

cleanupのDB証拠は `{actor,actor_uid,worker_uid,generation,image,profile,cleaned:true}`。generationは**worker起動時UUID文字列**。Goはserver-owned ActorStatusの `image_digest` をclaimのfull image ref末尾と照合して `image` へ写す。profileはhost-quota-8m-v1。DBに提出できるのはexecution role/current claimだけで、raw RPC証拠の真正性と実unmountの証明はAX側/Go側の責任。Suspendedだけをhost cleanup証拠へ置き換えない。

Gateway SQL署名はv5のreserve/authorize_generation/settleを維持し、v2 mailbox/replyだけversion=2。seq1=model、seq2=提案、tool ACKは `{accepted:true}`。入力上限6000/出力512は毎call、root6model/8tool/3Python・createからcleanupまで累積300秒、root予約込み概算0.01 USD・旧費用込み通算0.05 USD。旧guardは0.01 USDのまま。生成権ACKが不明なら送信不可、未精算予約は停止後もhold。

root viewへ `messages:[{run_id,kind,text}]` 最大17件を追加する。詳細GETは全messages/checkpointsを返す。一覧50件ではmessagesを最初のuser_start1件、checkpointsを空配列へ投影する。input/output metadataは維持し、UIは詳細GETで全履歴を取得する。新v2のAPI/BFF応答枠は親担当で2 MiBに固定する。内部source/descriptor全体は公開しない。

PG canonicalとの境界照合用 [workbench-pg-fixture.json](evidence/workbench-pg-fixture.json) は専用test DBで生成した合成claimとagent/skill chunkであり、liveの会話・秘密を含まない。実Actor、8 MiB RPC時間、host cleanup、課金確認はこの局所DB試験の対象外である。
