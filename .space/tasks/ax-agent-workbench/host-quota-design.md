# 固定code profileのhost tmpfs案

2026-10-07、A。Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` と既存AX patchを読み取った調査・設計。製品コード、稼働環境、DB、OKFは変更していない。親の実測は [runsc-probe.md](runsc-probe.md) に分ける。

## 判断

**ateom-gvisorのmount namespaceでActor専用のLinux tmpfsを作り、そのsourceをrunscへbindする案が成立候補。** ateletやguestへmount権限を足す必要はない。既存Volume APIを一般化せず、固定code image digestと固定profileだけに限定できる。ただしmount追加だけでは不十分で、終了失敗の伝播、golden snapshot、再起動時の不明状態を併せて扱う必要がある。

親が同じrunscで報告した実測：内部tmpfsは`nr_inodes=32`でも64空fileを作成でき、f_filesが1,003,178だった。host tmpfsをbindした場合はinput/tmp/outputのf_filesが16/128/32、outputは31空file後にENOSPC(28)。guest表示は9p,nosuid,noexecで、nodevは表示されない。当担当は実行していない。この結果はhost quotaのbounded診断であり、全隔離・実Actorの合格ではない。

## 既存の責務と限定する入口

パスは `ax-local/.sources/substrate/` 基準。

| 現在の入口 | 事実／変更案 |
| --- | --- |
| `cmd/atelet/oci.go:79,137,151` | imageを解決し、overlay specのImageDigestとOCI specを生成。capを持たないのでmount自体を置かない。code profileを選ぶなら固定digestとの一致を確認し、任意mount path/optionsをユーザー入力にしない |
| `internal/imagecache/spec.go:38,75,110` | OverlaySpecに解決済みImageDigestが既にある。manifest/index digestの値であり、任意tagやDocker config IDではない。ateomもこの値を照合できる。新しい公開protoは不要 |
| `cmd/ateom-gvisor/main.go:710,732` | RunWorkloadでSetupBundleRootfs後、cmdCreate前にcode quotaを準備する。goferがsourceを解決するのはこのworkerのmount namespace |
| 同 `:1013,1048` | Restoreも同じrootfs構成を行う。codeの復元を許すなら同じ検査が必要。最小案ではcodeのsnapshot再開を禁止し、後述のcold start専用にする |
| `cmd/ateom-gvisor/runsc.go:61,77,264` | shapeSpecはcreateとrestoreで繰り返される。ここでは準備済みhost quotaと固定bindを再照合し、勝手に再mountして中身を消さない |
| `internal/imagecache/bundle_linux.go:38,332` | rootfs/image volumeの既存mountと解除。新しいtmpfsをoverlayの中身として扱わず、同じbundleの兄弟sourceに置く |

最小の新しい内部helperを`codequota`相当とし、`Prepare(bundle, expectedDigest)`、`Verify(bundle)`、`RemoveAfterStopped(bundle)`の三つに分ける。profileの定義は一箇所、呼び元はactor全体の既存lockの中。atelet側に新proto/公開Volume型を足す案より狭い。code用に期待するdigestやprofileが欠落する設定は起動拒否し、通常profileへのfallbackを作らない。

## mountとbind

1. sourceは`<ActorPath>/bundles/<container>/code-quota/{input,tmp,output,state}`。actor UIDとcontainer名は既存内部識別子から組み立て、rootfsやdurable-dirの配下にしない。dirfd/openat相当でsymlinkや既存の別mountを拒否し、root所有0700の親を使う。
2. ateomが固定4mountを`tmpfs`として作成する。size/nr_inodes/uid/gid/modeは[python-spike.md](python-spike.md)の固定値、flagsはMS_NOSUID|MS_NODEV|MS_NOEXEC。sourceのstatfs、mountinfo、容量・inode数・所有・空状態をホスト側で確認する。未反映・未知mount・残存データならrunsc create前に失敗。
3. OCIには`Type:bind`、`Source:<上記source>`、Destinationを`/sandbox/input,/sandbox/tmp,/sandbox/output,/var/lib/ax-code`へ固定して渡す。`rw,bind,nosuid,nodev,noexec`を指定し、意図しない再帰mountは許さない。rootfsは既存imageから生成し、子のlibs/input readonly条件を保つ。
4. code digest／5cap／固定command／固定resource／bind先を照合してから実行する。image名だけ・guestの環境変数・生成コードのprofile要求から選ばない。後からgeneric volumeを同じdestinationへ重ねる経路を拒否する。
5. 不明な既存mountを`MNT_DETACH`して作り直す処理はしない。既知の同一prepare呼出し内で作ったmountだけは再照合できるが、プロセス再起動後の残存は回復対象。途中作成失敗では自分が作ったmountだけを逆順に解除し、解除確認ができなければworkerを新規受付不可にする。

`workerpool_apply.go:126`のBasePathはHostToContainer。ateomで作ったmountを同じnamespaceのrunsc/goferが使うので、host全体やateletへ伝播させるBidirectional変更は不要。host tmpfsはここでは「Linuxホストカーネルのfilesystem」を意味し、nodeの初期mount namespaceで管理する必要まではない。workerは既にSYS_ADMINを持つ（同`:289`）；guestへ追加しない。

ateletからはmountpointの通常directoryだけが見える点に注意する。別namespaceのateletがRemoveAllしてよいという証明にはならない。既存overlayと同様、ateomの停止・解除の完了応答が先で、ateletのdirectory resetが後であることをcodeでは必須にする。

## overlay／Volume／snapshotとの整合

- 新しいsourceはrootfs overlayのupperに作らず、bindで隠す。host tmpfs内容はdurable-dirではなく、`durable-dir.tar`へ入れない。通常Volume/image volumeや他imageの生成結果は変えない。
- 既存 `BuildActorTemplate` の`/workspace` durable-dirを残せばDATA Suspendは成立候補。コードからchroot外のworkspaceへ到達させず、成果物保存は外部PGへ完了してからSuspendする。tmp/outputの再利用・復元はしない。
- **COLD_BOOTだけではgoldenを止めない。** `template_reconciler.go:167,189`は全templateのgolden actorを作り、`workflow_suspend.go:173`はgoldenをFULLにする。`actor.go:91`はSourceTag無しでも現在のgolden tagを選ぶ。したがって、新bindを加えたままgolden/FULLの互換性を当然視してはいけない。
- 最小の製品案は固定code profileをcold start専用とし、template reconcilerのcode限定golden生成skip、CreateActorのcode限定sourceTag/golden採用拒否、onResume=COLD_BOOT、onPause/onCommit=DATA、codeのRestoreWorkload拒否を組み合わせる。新規Actorの最初のRunだけを使い、Suspend後は再開しない。これらは上流patchの追加範囲であり、通常Runtimeのsnapshot契約は変えない。
- goldenを維持する代案は、空host mountを持つgolden FULL capture→別Actor/sourceへのrestore→quota維持を別途実証する必要がある。コードを一度開始したsnapshotの再開はどちらの案でも採用しない。現時点でこの代案を成立済みとは扱わない。

## cleanupと再起動時の拒否

`terminateWorkload`（main.go:1153）はstop/delete後にbundle下を解除するが、`UnmountAllUnder`はlazy detach。さらにCheckpointWorkload（同:843）はterminate失敗をwarnして成功応答を返し得る。codeではこのままを完了証明に使えない。

1. codeについて、全runsc container/sentry/goferの終結を確認してからquota sourceを通常unmountする。EBUSYや不明状態は失敗を返す。lazy detachの成功を資源解放・全停止と同一視しない。
2. quota sourceのmountが消えたことをreadbackし、rootfs overlay解除へ進む。code専用markerにはactor/container/profile/source情報だけを保持し、ユーザー内容を入れない。成功後にmarkerを除去する。
3. Run/Restore失敗のdefer（main.go:689,984）、正常Terminate、Checkpoint後、graceful shutdownに同じcleanupを適用する。codeではcleanupエラーをwarnだけで捨てず、checkpoint成功・worker空きへの遷移を止める。
4. atelet.Runの先頭はresetActorDirs（main.go:492）なので、**その呼出しより前**に旧quota/workerのguardを置く。削除時だけの検査では遅い。ateom側cleanup成功を必要とし、既存の`RemoveAllWritable(bundleDir)`へ生きたquotaを渡さない。TerminateがNotFoundであっても旧process/mountが無い証拠にはならず、これだけでremoveActorDirsを許可しない。
5. mount前にactor UID・worker UID・実行世代・profile・固定sourceのmarkerを耐久保存する。これはローカルcleanup用の記録で、受付／所有権／費用／再送権の正本は外部PGのまま。ateomプロセス／Pod／nodeの再起動時に旧runsc記録・PID・mount・markerを照合する。メモリ上のactiveSessionが空、または新namespaceにmountが無いことだけを旧実行終了の証拠にしない。
6. 旧process/mountの状態が不明なworkerは、codeに加え通常Runtime・goldenを含む**全新規workloadの受付を閉じる**。明示復旧で旧世代の終結を確認するまで再利用しない。新規試行へ古いinput/output/stateを引き継がない。これらはCのHQ1を親が採用した追加条件であり、この文書変更で基盤に実装済みにはならない。

global slotと費用のholdは外部PGに残す。nodeが失われても、quota消失やcold startを根拠に同じコードを自動再送しない。host tmpfsのメモリ消費がguest memoryと同じcgroupへ課金されるとも断定しない。各mountの総量上限とworker Podの外側memory上限を別々に検証する。

## launcherの最小変更案

調査後に親が承認した小単位として、launcherの明示引数 `--profile host-quota-v1` を実装した。既存Docker用profileは`tmpfs`とnodev表示を引き続き必須にする。host bindは別profileに分け、controllerの固定argvだけが選ぶ。AXのmount/cleanup patchは未実装。

- 共通検査は5cap、所有者、mode、正確なbytes/inode数、空状態、readonly libs、NNP、FD、seccomp、回収上限。通常tmpfs profileの条件は緩めない。
- host profileだけ、親が実測した9p filesystemとnosuid/noexec表示を期待する。nodevがguest表示に出ない点は「nodev確認済み」と偽装せず、固定workerのhost mount検証を信頼前提に明記する。設定の不一致・古いworker・profile不明は拒否する。
- 起動前host verifierが固定mount flagとinode quotaを確認した証拠を、code専用profile/worker版と対応付ける。必要ならroot-owned readonlyの小さいprofile descriptorをchroot外へbindし、actor UID・image digest・quota版をcontroller期待値と照合する。guestが自作したdescriptorを保証の代替にしない。
- seccompはmknod/mknodatを引き続き全面拒否し、回収は通常file以外を拒否。host nodevの実効試験に加えてguest mknod拒否を実測する。これをinode quotaが無い場合の代替策にはしない。
- この変更の目的は異なるfilesystemの検査方式を明示すること。f_filesの期待値を無視する、上限を大きい観測値へ変更する、失敗を警告にする変更は行わない。

## 次の無課金ゲート

1. 親のhost bind診断を再利用し、同じ固定runsc＋候補launcher host profileで既存12試験相当を実行。host/guestのbytesとinodeの両ENOSPC、mknod、network、FD、親状態、caps/seccomp、親急死を確認。
2. codeと非codeのOCI unit差分、digest違い／欠落・mount重複・symlink・既存mount・途中失敗の拒否。通常imageは差分0を検査。
3. 作成途中、ready前、code終了後、quota解除中、checkpoint中の障害を入れ、解除不明時に新規Actorを開始しないことを実Actorで確認。
4. 一つのActorのsource/内容が次へ混ざらず、停止→worker未割当→mount解除が揃うこと。codeのgolden/restore拒否と通常Runtimeのsnapshot互換を確認。

ここまでが成立してから8MiB stagingとRuntime→code→Runtimeを統合する。親のhost bind成功は有用な成立性の根拠だが、これらの実装・実Actor試験はまだ未実施。
