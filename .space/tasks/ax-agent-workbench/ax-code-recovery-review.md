# Begin前に失敗したcode Actorの回収レビュー

2026-10-08。対象はprobe2の `ax-run-386e2e8fca6e4cef`、Actor UID `fd5608ac-c341-4373-945e-53e18d278838`、worker Pod `ax-local-7b65544557-wqd62`。実環境の観測は親の報告を引き継いだ。Cはソース読取りのみで、稼働環境・DB・モデル操作、製品コード変更をしていない。記録作成のみを担当した。

## 結論

今回の既存失敗には、対象を限定した管理者のhost回収と、専用schemaのPG unknown/hold・元Actor/Task記録の保全を推奨する。正常なserver-owned `code_cleanup` を作れたとは扱わず、成功・通常finish・slot解放の証拠を手書きしない。Aともこの区別で一致した。

修正版workerの「同世代のpendingから回収」だけでは、既に起きた今回の失敗を回収できない。worker再起動後に新世代の記録を作って過去の実行世代として扱う方法、pending不在をcleanedへ読み替える方法、未知Resumeの再送は採用しない。

## 確認した原因と通常経路の限界

確認したSubstrate patch SHA256は `b221906a87c15e14dcc9baa742a8ab64e30b72f896f884786f55d1f7c23cb473`、固定上流は `944abe3278b895ccbf5d45555a49dd0f2f6ceae7`。Aが作成中の修正はこの判定対象に含めない。

- `ax-local/patches/code-runtime-substrate.patch:371–395` の `beginCode` は、固定request検査→`ValidateBundle`→`Worker.Begin`の順。今回の `REQUESTS_CA_BUNDLE` 不許可はBegin前に返る。`RunWorkload`側のcleanup deferもこの戻りの後なので、pendingを持つ通常cleanupへ入らない。
- 同patchの `stopCode`（397以降）は `Current(actor)` が必要。`Current`（1386以降）はpending内のworker UIDと起動世代UUIDの一致を要求する。`Completed`（1420以降）も現世代のdoneしか返さない。親報告のpending/done共に0なら、Suspend/Terminateを呼んだだけでは正常証拠へ到達しない。
- `OpenWorker`（1314以降）は起動ごとに新UUIDを作る。旧世代はこの事例ではメモリ内にしかなく、新版の起動で復元されない。同Pod UIDのcontainer再起動でも同じ世代にはならない。
- Begin検査はactiveRPC/session登録・Actor用network setup・runsc createより前に挿入されている。固定上流 `cmd/atelet/oci.go:94–102` では、この時点のOCI準備は空rootfs/upper/workとspecの保存。これは親報告の「bundleあり・runsc未作成・PID1の/serverのみ」と整合する。ただし今回の実環境不在確認そのものはC未実施。
- 固定上流 `cmd/ateom-gvisor/main.go:515–521` はsession=nilならshutdown cleanupを実行しない。Pod終了だけでcode cleanup完了を生成する実装ではない。
- 固定上流 `cmd/atecontroller/internal/controllers/workerpool_apply.go:127–130` のBasePathはHostToContainer mount。node側のmount一覧だけではworker private namespaceのoverlay/tmpfs不在を証明できない。
- 固定AX `internal/controller/reconciler.go:192–204` はSuspendActorエラーをwarningとしてTaskをSuspended表示へ進める。今回はTask表示を実停止・host回収の証拠に使わない。

## 最小の管理者回収条件

以下は親が実施する場合の条件であり、Cが実施済みの手順ではない。

1. 専用schemaの受付、probe/通常controller、対象ActorへRun/Resumeを送れる直接・router・再照合経路を停止する。既存RPCの終了を確認し、回収中にbundleが再生成されない状態を保つ。PGの停止だけでAXへの別経路まで遮断できたとは扱わない。
2. root/run/Actor UID、workerの**Pod UID**・container ID・PID/mount namespace ID、image digest、profile、固定runsc path、対象bundleの対応と失敗時の観測を保全する。Pod名だけ、PIDだけ、runsc NotFoundだけでは対象と終了を確定しない。秘密・ユーザー本文を公開記録へコピーしない。
3. 旧workerのnamespaceが存続している間に、対象actorのrunsc state、guest/pause、runsc create等の遅延process、対象bundle/quotaへの参照・mountを確認する。親報告どおり未作成なら、それを数値と対象ID付きで残す。node/atelet側も同じActor配下のmountを照合する。
4. mountがあれば対象Actor配下だけを深い順に通常unmountし、同じnamespaceで不在を再確認する。quota layout等が想定外、processや処理中RPCの不在が確定しない、unmountが失敗する場合は中止・保全する。lazy/force unmountや共有image-cache/BasePath全体の削除を使わない。今回mount0なら不要なunmountや削除を増やさない。
5. 回収確認より先にworkerを退役させる必要がある場合は、旧namespaceの確認手段を先に保持する。単に再起動して新namespaceで0件を観測する方法は不可。旧workerの退役後はcontainer/cgroupのprocess不在、旧worker UIDの通信経路・割当再利用不可、対象mountの不在を確認する。別workloadを巻き込まない。
6. bundle/specとPG/AXの元記録は調査用に保全する。既存pending/doneを削除・生成しない。手動回収は「管理者が対象host資源を回収」と別記録に残し、`code_cleanup.cleaned=true`、PG resolved/succeeded、通常finishへ転記しない。
7. 修正後の検証は新schema/root/Actor UIDで行う。旧専用schemaのholdが残っていることを明記し、これを全run resolvedや復旧機能の合格件数へ含めない。新試行に進める条件は旧実行の再開不能とhost資源不在であり、DB未解決行を消すことではない。

## 代案の比較

| 案 | 今回への適合 |
|---|---|
| 現workerで通常Suspend/Terminate | SuspendActorはRESUMINGを受け付けない。workerのTerminateもpendingが無くCurrentで止まる。正常cleanupの解決策にならない |
| 修正版へ再起動し、現世代の回収markerを後付け | 元世代・in-flight・private namespaceを失う。過去失敗を通常cleanedにする入口として不可 |
| 未解決記録を保持した管理者host回収 | 今回の隔離schema・無モデル・開始前失敗には最小。hostの実測とwriter排除が必須 |
| 明示的な旧worker引継ぎ・管理者attestationを新protocolとして実装 | 別世代・退役証拠・mount namespace・再利用防止を定義すれば検討余地はあるが、今回は過剰。既存CodeCleanupと混ぜず後続の復旧設計で扱う |

今後の同種失敗について、Aはtrusted requestのactor/bundle/imageを束縛したpendingをValidateBundleより前に保存し、失敗時も同世代のstopCodeへ渡す順序を検討中。将来の開始前失敗を通常cleanup可能にする方向として妥当だが、今回の既存失敗を遡及して解消したことにはならない。最終差分と「ValidateBundle拒否→runsc未作成→通常回収→証拠」「各途中失敗ではhold維持」の検証は別途必要。

## 正式APIによる割当解除の確定手順

同日追補。固定Substrateには、**worker Podの物理退役後**にActorをCRASHEDへ移す既存経路がある。独自の回収markerやstatus更新APIを追加する必要はない。

- `cmd/atecontroller/internal/workersync/syncer.go:246–270,394–407` はPodのTerminating中はDrainWorkerだけを呼び、Pod消滅又は同名PodのUID変更後にDeleteWorkerを呼ぶ。
- `cmd/ateapi/internal/controlapi/workflow_worker_delete.go:39–77,166–232` はWorkerをDRAININGにし、現在のActor UIDとworkerへの逆参照が一致する割当を確認して、RESUMINGを含む未停止ActorをCRASHEDへ変更し、workerAssignmentを消す。その後Worker登録を削除する。guestの停止操作やcode_cleanup生成は行わない。`workflow_worker_delete_test.go:152–196` にRESUMING→CRASHED＋割当なしの回帰がある（今回は読取りのみ）。
- `workflow_resume.go:299–313` の割当経路はCRASHEDを拒否する。Actor/Taskの記録を削除せず残すことで、同じActorを再開する通常経路を閉じられる。

したがって手順は、全writerとin-flightの排除→旧worker内とnodeの対象process/mount不在確認→対象worker Podの物理退役と旧process消滅確認→標準reconcilerのDeleteWorker完了→同じActor UIDがCRASHED・割当なしであることのreadback、となる。DeleteWorkerは物理停止の代用にせず、旧Podが生存する間に手動呼出ししない。WorkerPoolを一時0にする場合は対象poolの全割当を事前に把握し、他の稼働Actorがいないことを確認する。

標準reconcilerが進まない場合に限る管理者の代替は、物理退役を確認したWorkerへの正式DeleteWorker RPC。requestは `worker:{name:<取得したWorker名>}, options:{uid:<Worker metadata.uid>,version:<metadata.version>}`。Worker名/Pod UIDとWorker resource UIDを混同しない。競合時は対象を再読取し、別世代へ対象を差し替えない。今回は標準reconcilerで成立したため、この代替操作は不要。

## 親が実施した回収結果との照合

親は上記の案を受けて、AX Deploymentと実行writerを退役、停止後のhost観測、WorkerPoolの一時0化・旧2 Podの退役を実施した。Cはlive操作せず、次の既存private証拠を読取り照合した。原ファイルやbundleは公開・Git追加せず、ここには結果のみを記す。

証拠ディレクトリ: `ax-local/.state/workbench-build-arg973la/probe2/`

| 証拠 | 読取りで確認した内容 |
|---|---|
| `workers-before-retirement.json` | 対象PodのUIDは `83cadd64-2714-4cde-a66a-e2e27a41ba4c`。同poolのもう1 Podは別UID。退役前は両方Running |
| `host-pre-retirement.txt`, `host-writer-stopped.txt` | 旧worker PID 1329537/1329535、mount namespace 4026535460/4026535457を識別。各private PID namespaceはPID1 `/server`のみという出力 |
| `actor-held.json`, `actor-after-retirement.json` | 同じActor UID `fd5608ac-c341-4373-945e-53e18d278838` がversion 2のRESUMING＋対象worker割当から、version 3のCRASHEDへ遷移。後者のstatusにはworkerAssignmentもcodeCleanupもない |
| `host-after-retirement.txt` | 対象Actorのrunsc-state/pidfilesは空。quotaにはlockファイルのみでpending/doneはない。既存の他Actor lockも保全されている |

旧Pod削除、旧host PID消滅、worker各namespace及びnodeの対象mount検索0件、専用PGのunknown維持は親の実測報告として引き継ぐ。保存されたhostテキストの空検索出力だけでは、コマンドの成功・検索条件をCが独立実行したことにはならない。Cが直接照合したJSON上のActor遷移は、固定上流の標準reconciler/DeleteWorkerの挙動と一致する。

**判定:** 今回のmarkerless Actorは、管理者の物理退役と標準登録回収により、通常Resumeが可能なRESUMING状態から隔離された。専用PGのunknown/hold、元Actor/Task/bundleを保全し、手書きのcleaned/successを作らない方針に追加の必須修正はない。これは通常code cleanup・probe成功・PG復旧の合格ではない。public v5の復帰は、専用schemaを実行対象に混ぜず、workbench/Python/model gateを閉じた標準構成のreadinessと既存経路を親が確認する別工程である。報告時点ではpublic closedで、復帰完了は未確認。

今回の担当作業は設計調査と結果照合まで完了。今後のBegin順序・Terminate冪等性の修正と新規Actor試験は別単位であり、この回収結果から合格を推定しない。OKF更新は担当外のため行っていない。

## 新Begin順序・同世代done再観測の独立レビュー

同日、親の追加依頼でAの修正を別単位としてレビューした。製品source、共有fixture、稼働環境は変更せず、関係するLinux局所試験だけ独立実行した。対象は固定Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` に以下のpatchを適用した版。

| 対象 | 最終SHA256 |
|---|---|
| `code-runtime-substrate.patch` | `7e7eb939a8f6fd62cb5f38c09c8e43879f8004d22100de4ee85c6ea29731654f` |
| `code_runtime_ateom_test.go.txt` | `8aff76b4f09eed33fdca8086e9b8bdae2366dff91a42e023fa3b80d649eb57ce` |
| `code_runtime_mount_linux_test.go.txt` | `2a92d872b68c501c7858f2e7215b65a476847088b9d05fcd803e54a1d077259a` |

Aのtemp source全体の`git diff --binary` SHAはpatchと一致し、実行対象fixtureも上表と一致した。最終読取時にも3hash不変を確認した。

### 境界の判定

- `cmd/ateom-gvisor/code_runtime.go:24–50` はnode/worker guard、ax-code、固定runsc path・CPU/memory・guest 1件、imagecacheの固定digest・image volumeなしを検査してからBeginを実行する。BeginはActor IDを検査し、既存doneで再開を拒否し、Actor/worker/起動世代/image/profile/bundleをpendingに耐久保存する。その後のfull OCI検査を弱めていない。
- `internal/codequota/mount_linux.go:57–95` のENV許可追加は`REQUESTS_CA_BUNDLE`。任意の追加ENVは引き続き拒否し、command/capability/mount検査を保持する。imageとrequestの初期条件が不正な場合にはpendingを作らない。
- `cmd/ateom-gvisor/main.go:659–681` のdeferはbeginCodeのエラー分岐より前に登録される。耐久Begin後の検査失敗は`isCode=true`で従来の同世代cleanupへ進む。runsc観測等が不明ならpendingを保全し、成功証拠を作らない。Begin自体が不明な失敗を返した場合はcleanupを成功と推定しない。
- `code_runtime.go:52–91,147–158` はCurrentがない場合、同Actor・worker・起動世代の既存doneだけを採用する。固定bundle/imageを照合し、runsc list空→private PID namespaceの実行processなし→bundle配下mountなしを再観測する。done側ではdelete/unmount/Completeを再実行しない。pendingが存在する場合、記録破損、markerなし、別worker/世代ではCompletedが拒否し、通常の完了証拠へ昇格しない。

### 独立確認と限界

Cは最終sourceから`GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go test -c`で2本のtest binaryを作り、固定local image `sha256:c31da8b762c16fef7085bb17c3593f428cc3de2d667db821ac170ff7f176cafb` の通信なし・rootfs読取専用・private PID1コンテナで関係16 top-level試験を実行し、skipなしで全件成功した。対象はcodequota 7件（ENV、mount再観測、同worker再起動、at-most-once、別世代、done途中停止、耐久完了）とateom 9件（孤児/Restore拒否、public proof、spec拒否pending、別image、done再観測、各観測失敗、markerなし、RunWorkload検査失敗cleanup）。この局所試験はCGO無効であり、独立race実行ではない。

Aの全prepare/verify、8 fixtureの44 top-level、AX/Substrate race・3binary build成功は作者の報告として区別した。親の`empty-runsc-absent.json`は`precondition_absent=true`、exit 0、stdout/stderr各0 byteを確認し、対応する2ファイルも0 byteだった。これは固定runscの未作成root読取の実測であり、局所試験の`/bin/true`代替とは異なる。ただし新Actorやworker cleanup全経路の実証には代えない。

**判定:** 限定差分に追加の必須修正はなく、親による配備・新規Actor検証へ引き渡し可能。新Actorでの開始、失敗時cleanup、同世代停止応答再取得、server-owned code_cleanupの正式API伝播は未確認として残す。RunWorkloadの失敗応答が返る以上、hostでdoneができたことだけでAXのRESUMINGやPG unknownが自動解消するとは主張しない。旧markerless Actorを再送・再開する根拠にも使用しない。

## probe3: 同worker世代での通常回収結果

同日追補。親が修正版r2上で実施したprobe3は、Actor自体はRUNNINGになったが、AXのworkspace readiness待ちによりcode区間のResume intentが不明となった。対象schemaは `ax_workbench_probe_5bf3496ffd4703c8`、rootは `d99be836-004c-4100-8dab-fc81aff44007`、code runは `ax-run-d14c6629b50e48c3`。stage/startは未実施との親報告を引き継ぐ。

Cは実行せず、`ax_authorize_recovery`が旧controller ID/claim generationと3つの退役条件を要求すること、通常controllerのrecoveryはcreate/resume/stage/startを送らないこと、`-once`にroot指定が無いため専用schemaのready対象1件を事前確認する必要があることをソースで確認し、親へ伝えた。親は旧writer Podを退役させ、同じworkerを維持したまま管理承認し、通常controllerを1回だけ実行した。

`ax-local/.state/workbench-build-arg973la/probe3/` の以下のprivate証拠を読取り、JSONの対応関係もPythonによる読取assertで照合した。秘密設定・password・本文は読んでいない。

| 証拠 | 照合結果 |
|---|---|
| `recovery.stdout`, `recovery.stderr` | `controller_ready`、`job_processed`を各1回記録。stderrは0 byte。イベントだけをPG完了の証明にはしない |
| `pending-before-recovery.json`, `done-after-recovery.json` | 全fieldが一致。Actor UID `9947fe27-293c-4e48-a90d-e705960911f8`、worker UID `661ee27a-221f-4d62-99d0-cd80613c8a20`、起動世代 `5ad1b9cd-4301-4afc-9ad7-d32a928e7fe1`、固定image digest `c31da8…`、`host-quota-8m-v1`、対象bundleが同一 |
| `actor-before-recovery.json`, `actor-after-recovery.json` | 同Actor UIDのversion 3 RUNNING・対象worker割当から、version 6 SUSPENDED・workerAssignmentなしへ遷移 |
| `code-inspect-after-recovery.json` | AX Suspended、Actor停止・未割当、egress deny、verified=true。7fieldのserver-owned cleanupは同run/Actor/worker/起動世代/profileで、full image refのdigestがpending/doneと一致し、cleaned=true |
| `host-before-recovery.txt`, `host-after-recovery.txt` | worker PID `1331899`、mount namespace `4026535460`を維持。前にはrunsc state、overlay、null-netns、4つのquota tmpfsとrunsc/sentry processが記録され、後にはrunsc-stateが空、対象mount行なし、実行processの出力は`/server`だけ |
| `pg-after-recovery.json` | 対象code jobがrecovery/done/generation 2、runがfinished/resolved=true/outcome=failed、`error_type=execution_unconfirmed`を保持。root stopped/revision 3、slotのrun_id/hold_reasonはnull。login/accepting/pythonはfalse、接続0 |

PG snapshotは親が追加保存した後にCが読取り照合した。対象runのeffectsは旧generation 1のcreate（confirmed）・resume（evidence null）と、新generation 2のegress_deny・suspendだけで、stage/startはない。Resumeの不明な応答を成功へ書き換えていない。rootのpython_calls=1は予約済み操作数であり、生成Pythonの実行成功を示さない。pendingファイル不在は親の実測報告として引き継ぎ、Cがlive filesystemへ再照会したとは扱わない。

**判定:** probe3について、同worker世代のpendingから通常停止・doneへの移行と、正式APIでの停止/cleanup証拠取得が保存証拠で整合した。旧probe2の管理者退役・CRASHED/unknown保全とは異なる回収結果として記録する。codeの生成Python実行、Runtime→code→Runtime全体の成功、cleanup完了後の停止RPC再送、未知途中停止からの全復旧を実証したものではない。readiness不具合の修正はBの後続単位であり、本追補では変更後の成立を先取りしない。
