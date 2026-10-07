# 固定runscの保存領域制限を実測する

2026-10-07。親が既存kind nodeで実施した無課金の診断。AX Task/Actor経路の試験ではない。モデル送信、稼働DB移行、Worker設定変更は行っていない。

## 対象と条件

- node: `ax-local-control-plane`
- 実行ファイル: `/var/lib/ateom-gvisor/static-files/gvisor-a64916f9813ce7e4841a30480a599337f7dda07b421c6bf0123db2212aa7d1df/runsc`
- 実測version: `release-20260824.0-120-g727c8c389c36-dirty`、OCI spec `1.2.1`
- Docker試作のimage `sha256:9a644079a37b24616bef8c51c3affa76d89e792d4ff00395a75434264b42214e` を停止containerからexport。後続のログ超過修正前の版であり、最終imageの成功試験には数えない。
- 外側OCI: rootfs readonly、親capはKILL/SYS_CHROOT/SETUID/SETGID/SETPCAPのみ、noNewPrivileges、network none。`--ignore-cgroups`の固定・少量診断であり、ActorのCPU/memory cgroup検証ではない。
- 一時bundle: nodeの `/var/lib/ax-code-runsc-8f0357e5cb31`。最初はnodeの`/tmp`へ置いたが、同領域がnoexecでrunscのlower mount remountが拒否された。実行可能な`/var`へ移して解消。実行権限を緩めるためのhost remountは行っていない。

## OCI内のtmpfsではinode数が制限されない

inputはsize64KiB/nr_inodes16、tmpは8MiB/128、outputは1MiB/32、親stateは64KiB/32としてOCIにtmpfsを定義。uid・modeとnosuid/nodev/noexecもDocker試作の値を渡した。

launcherは`setup_failed / unsafe_mount / isolation_ready=false`で終了し、依頼コードを実行しなかった。

固定の診断用Pythonでstatvfsを確認すると、bytes・uid・modeは指定どおりだが、`f_files`は全領域1,003,178。mountinfoではnosuid/noexecが表示され、nodevは表示されなかった。

outputのnr_inodes32指定に対し、UID65532で最大64個だけ空ファイルを作る診断では、**64個すべて成功し、エラーなし**。inode上限はメタ情報の表示だけの差ではなく、実際に効いていない。試作のチェックを外して任意Pythonを開放する根拠にはできない。

## 信頼側のtmpfsをbindで渡すとinode上限が効く

node側でActor専用候補の4ディレクトリを作り、Linuxのtmpfsをそれぞれsize/nr_inodes/uid/gid/modeとnosuid,nodev,noexec付きでmount。そのpathをOCI bindとして同じrunscに渡した。

| 領域 | bytes | f_files | uid | mode |
| --- | ---: | ---: | ---: | --- |
| input | 65,536 | 16 | 0 | 755 |
| tmp | 8,388,608 | 128 | 65,532 | 700 |
| output | 1,048,576 | 32 | 65,532 | 700 |
| 親state | 65,536 | 32 | 0 | 700 |

同じ最大64ファイルの固定診断は、**31個でENOSPC（errno28）**となった。rootディレクトリが1inodeを使うため、指定した32に整合する。

追加の容量確認では、UID65532で同一outputファイルへ最大2MiBを試み、**1,048,576 bytesでENOSPC（errno28）**。host tmpfsの1MiB上限が実際の書込みにも適用された。各診断後にrunsc containerを削除し、作成した4つのhost tmpfsを通常unmountした。

guest mountinfoの種別は`9p`、nosuid/noexec表示、nodev表示なし。したがって現launcherの「tmpfsであること」という検証とは別profileが必要。nodevは信頼側の実mount設定で保証し、guestのmknod拒否などと合わせる必要がある。guestのfilesystem名だけで信頼されたsourceと認める設計にはしない。

## 残る条件

この結果はhost側quota方式の成立性を示す少量診断であり、Pythonの全隔離試験やAX実行成功ではない。厳密なcode image/template識別、信頼側mountの作成・検証・後片付け、Worker間のmount可視性、再起動・停止時の失敗扱い、子processの全境界、8MiB入力搬送を統合して確認する必要がある。完成成果物はTask外へ回収し、これら一時mountは正本にしない。

## 最初の診断の後片付け

両runsc stateのlistが空、該当bundleを参照するprocessがないことを確認した。各stateに残ったnull-netns mountを通常unmountし、配下mountがないことを再確認して、旧`/tmp`と`/var/lib`の診断bundleを削除した。最終imageの試験は新しい専用bundleで行う。

## 最終host profileの実効試験

候補imageのDocker content IDは `sha256:6d9837961abc3e28164a7db1ab54d62cd67e222dc4496c195ad98b35099fd8d7`。registry manifest digestではなく、AX配備に使うdigestは後続で確定する。新しい専用bundleへexportし、実行時launcher SHA-256が作業中sourceの `5230ab96f0dad895c64b83651a79e294a362bebeec82bfbe16f6334a935860f6` と同一なことを照合した。

`ax-local/tests/test_code_runtime_runsc.py` は実装済みDocker契約11件の入出力とassertを継承し、固定node/runsc/bundleを明示したときだけ動く。追加のdevice/process_vm拒否を含む**12件が成功（56.853秒）**。証拠は [runsc-contract.txt](evidence/runsc-contract.txt)。skipはない。

- CSV合計24.50、XLSXの保存・再読24.5、出力のsize/hashを確認。
- IPv4 TCP/UDP、IPv6、UNIX socket、fork/thread/exec、親signal/ptrace/process_vm、mknod/mknodat、特権再取得を拒否。
- chroot外、親state・環境・FD、入力とlibraryの書換えを拒否。親急死時に子がSIGKILLで終わる。
- host tmpfsのflags・bytes・inode、nodevでデバイスopenがPermission deniedになる実効性を確認。guest側では9p、nosuid/noexecを厳密に照合。総容量・inode・FSIZE・FD・CPU/AS・wall・log超過を確認。
- 必須cap/mount欠落、seccomp設定失敗でisolation_ready=false、出力なし。symlink/hardlink/directoryを成果物として採用しない。

最初の12件相当の一巡では11成功・1失敗。OCIの`linux.seccomp`へ拒否profileを指定してもこのrunscでは注入できず、seccomp設定失敗のfixtureが成立しなかった。生成コードに適用するallowlistの突破ではないが、OCI seccompを拒否の根拠に使えない発見として残す。信頼したguest driverがseccompとprctl(PR_SET_SECCOMP)を先に拒否してlauncherをexecする注入に変更し、`E:seccomp:0`で未実行停止を確認した。製品のfilterや判定を緩めていない。

初回harnessはmountpointの非mount終了値を1と仮定して失敗したため、この環境の32へ修正した。実行コードの問題と区別する。

## 応答不明時の試験harnessと後片付け

独立レビューH2により、timeoutしたローカルdocker execの終了をnode内処理の終了と扱わないよう補正した。node操作のtimeout/実行失敗はdirtyとし、自動delete/unmountを行わず、後続probeの開始を拒否する。次の新しい試験processでも旧state・専用process・quota mountがあれば開始を拒否する。正常応答のときだけrunsc delete、list空、専用processなし、通常unmountとmount消滅を順に確認する。

実fault注入では、runsc応答を0.7秒でtimeoutさせた時点でnodeに3processが残っていた。4quota mountを保全し、後続のrun呼出しを拒否した（[runsc-timeout.json](evidence/runsc-timeout.json)）。別の試験でmountをnode側1秒遅延、通信を0.1秒でtimeoutさせ、応答終了後に現れるmountも保全し、次の開始を拒否した（[mount-timeout.json](evidence/mount-timeout.json)）。親がそれぞれ実完了・list空・専用processなしを別に確認してから通常unmountで復旧した。

この最後のguard変更後は正常CSVとcleanupを再確認し、1件成功（2.544秒、[runsc-final-cleanup.txt](evidence/runsc-final-cleanup.txt)）。同じ生成コード・imageの他の成功試験は再利用した。最終的にlist空と専用processなしを確認し、stateのnull-netnsも通常unmountして、全mountの消滅を確認した後に専用bundleを削除した。残存した試験Actor/Task、quota mount、processはない（今回はActor/Taskを作成していない）。

この合格はdirect runscの固定fixtureまで。`--ignore-cgroups`であり、RLIMITの試験をAX/workerのcgroup制限や課金の確認に読み替えない。実Actorの制御RPC、template/digest照合、golden回避、worker再起動、cleanupと再受付、8MiB入力搬送、モデルによる一連の作業は未確認。[host quota設計](host-quota-design.md)と[独立レビュー](host-quota-review.md)を後続の前提とする。
