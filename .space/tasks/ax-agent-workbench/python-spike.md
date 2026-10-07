# Python 隔離試作と実 Actor への引き渡し

2026-10-07、担当 A。基点 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、共有 branch `codex/agent-workbench` の未コミット差分。設計・隔離調査・planを再利用し、担当範囲の実装と Docker 検証だけを行った。稼働 AX／DB／モデルには接続していない。有料モデル呼出し 0。OKF・共通task・既存runner・Go・SQLは編集していない。

## 結果と範囲

固定 Python 3.12.15、openpyxl 3.1.5、defusedxml 0.7.1、et-xmlfile 2.0.0 の code image と最小 trusted launcher を作成した。Docker の network none で CSV 集計、XLSX 作成・再読込み、隔離・資源上限・設定失敗・親急死を検証した。後続のhost profileでは親のdirect runsc契約12件も成功した（末尾参照）。**実Actorの隔離は未確認**であり、製品への任意Python開放を受け入れた結果ではない。

Docker初回検証版は `ax-code-spike@sha256:3eb6cf476341e3b948854567f43c762631f8097662f81ec42da0193934141e69`、arm64。後続のhost profile検証版は末尾の `6d983796…`。Dockerfile の base は `localhost:5001/ax-task-runner@sha256:6f4f48e64ae1eab1a9d1755d24675f676b0164e936d316d76ab64fa0246a2cad`。当担当は公開 registry へ push していない。

| 成果物 | 内容 |
| --- | --- |
| `ax-local/code_runtime/launcher.py` | strict小入力、mount/cap検査、入力配置、fork、制限、親監視、停止後の安全な回収 |
| `security.py` / `bootstrap.py` | chroot後の権限・FD・環境確認、seccomp適用、適用失敗時はコードを実行しない |
| `build_sandbox.py` / `requirements.lock` | root所有の最小chroot、固定wheel hash、loader/libseccompのbuild時読込確認 |
| `ax-local/runner/Dockerfile.code` / `.dockerignore` | 既存imageに影響しない code専用試作image |
| `ax-local/tests/test_code_runtime.py` | Docker隔離試験11件。`AX_CODE_IMAGE` 未指定時はskip。`test_code_runtime_watch.py`は終了済み子のログ超過を確認する局所試験1件 |
| `code_runtime/deny-seccomp-test.json` / `README.md` | 設定失敗注入profile、仕様と再現条件 |

## 子と親の境界

子へ渡すのは封じた入力、固定環境、stdin `/dev/null`、stdout/stderr pipeだけ。chroot内に `/proc`、親の台帳、SDK、資格情報、制御RPC socket、外部directory FDを置かない。UID/GID65532、補助groupなし、effective/permitted/inheritable/bounding/ambient capabilityすべて0、no_new_privs=1を確認する。子には seccomp 適用後にだけコードを実行させる。

socket/connectを含むnetwork syscall、fork/clone/thread/exec、親signal/ptrace/process_vm/pidfd、mount/namespace、io_uring、prctl/seccomp/rlimit変更を拒否する。許可済みfilesystem syscallもchrootとUnix権限に拘束される。lib／入力はroot所有で書込み不可。`fcntl`はF_GETFD/F_GETFL、`ioctl`はFIOCLEXだけで、一時ファイル用FDのclose-on-exec設定を許す。

親には **KILL・SYS_CHROOT・SETUID・SETGID・SETPCAPだけ**を付ける。SYS_ADMIN／NET_ADMINは不要。KILLはUIDを落とした子の強制停止、SETPCAPはbounding set全dropに必要。過不足をlauncherが拒否する。PDEATHSIGはUID切替で消えるため、drop後にSIGKILLを設定し既知の親PIDも確認する。親をkillした実試験で子のSIGKILL終了を確認した。

子のCPU2秒、AS256MiB、FSIZE65536、FD32、NPROC1、CORE0、STACK8MiB、親wall5秒、合計log8192 bytes。fork/threadを禁止するので子孫を作る機能はない。親はwait後だけ回収し、dirfd・NOFOLLOW・通常ファイル・link数1・UID・固定名と総bytesを照合する。コードの成果物やログを認可／費用／usageの正本に使わない。

## 上限を混同しない条件

現試作は source UTF-8 4096 bytes、input最大4件・合計4096 bytes、output最大4件・合計65536 bytes、request JSON 32768 bytes。製品 upload の **8MiB/file** をここへ反映していない。実用統合では file ID・size・SHA256・owner/root/attemptを固定した別chunk stagingと封印が必要。code payload／結果metadataと実CSV/XLSX bytesを別に制限する。大きいXLSX入力、8MiB入力、8MiB出力が通ったとは主張しない。

Dockerの4 tmpfsは次の固定値。全てnosuid/nodev/noexec。launcherは子から見える3mountについてtype、実容量、inode総数、所有者、権限、空状態を検査する。

| OCI destination | optionsの追加分 |
| --- | --- |
| `/sandbox/input` | `size=65536,nr_inodes=16,uid=0,gid=0,mode=755` |
| `/sandbox/tmp` | `size=8388608,nr_inodes=128,uid=65532,gid=65532,mode=700` |
| `/sandbox/output` | `size=1048576,nr_inodes=32,uid=65532,gid=65532,mode=700` |
| `/var/lib/ax-code` | `size=65536,nr_inodes=32,uid=0,gid=0,mode=700` |

この表のDocker mountはType/Sourceが`tmpfs`。後続のdirect runscは同じ値のhost Linux tmpfsをType `bind`で渡す。inputの64KiBにはコードと入力の配置余裕を含む。tmp/outputの総容量とinode上限、FSIZEの1ファイル上限、回収総量は異なる制限である。パイプのlogは別上限。外側Dockerはread-only root、PID16、384MiB、1CPU、no-new-privileges。direct runscで確認した範囲は末尾と親のrunsc-probe.mdへ分ける。

## Docker初回検証と失敗の修正

実行コマンドは `AX_CODE_IMAGE=<上記digest> python3 -m unittest discover -s ax-local/tests -p 'test_code_runtime*.py' -v`。全試験は `docker run --rm --network none` で一時コンテナを使う。成功条件は以下。

1. CSV金額合計24.50が正しい。XLSX出力を再読し24.5、ZIP形式、artifact size/hashが一致。defusedxmlが有効でentityを拒否。
2. IPv4 TCP/UDP、IPv6、UNIX socketの作成、fork/thread/exec、親signal、ptrace、privilege再取得、mountを拒否。
3. 子に外部path・親状態・環境sentinel・FD3以降が見えず、libs/inputへの書込みを拒否。
4. 必須cap欠落、tmpfs欠落、seccomp両設定API拒否で、isolation_ready=false／outputsなし。
5. tmpfs byte/inode枯渇、FSIZE、FD、CPU、AS、wall、logの境界が発動。親急死で子もSIGKILL。
6. symlink／hardlink／予期しないファイル／directoryを成果物として採用しない。

途中の失敗は修正後結果と区別する。

- 初期のchdir失敗はrootにDAC_OVERRIDEを足さず、chroot後に`/`へ移動し、UID切替後に子所有outputへ移動して解消。
- NPROC1をUID切替前に設定するとtrusted execがEAGAIN。制限値を緩めず、exec済みtrusted bootstrapの先頭でNPROC1を設定し、その後にコード開始。fork/cloneは独立してsyscall拒否。
- chrootのloader cache不足でlibpythonを読めなかった。固定cacheを含め、build時にchroot内importを検査。
- XLSX一時ファイルがEPERM。FD読取りだけでは解消せず、CPythonが使うFIOCLEXだけを許可して成功。広いioctl許可は追加していない。
- seccomp syscallだけを拒否した試験fixtureではlibseccompがprctlへfallbackして成功した。fixtureで両APIを拒否し、設定失敗時に未実行となることを確認。製品のfilter突破ではない。

終了済み子のpipeをdrainする時に超過ログを失敗へしない点はCの独立レビューで検出。局所試験で `None != log_limit` のRedを確認し、reason設定と生存中だけのkillを分けてGreenになった。保存ログの上限8192は修正前も維持されていた。

この時点の結果・hashは「Docker初回検証版」に記す。独立レビューは親へ渡し、自己試験を独立レビューとは扱わない。

## 固定runscの一時OCI probe

親からの実測報告（当担当は未実行）：workerとkind nodeに `gvisor-a64916f9813ce7e4841a30480a599337f7dda07b421c6bf0123db2212aa7d1df/runsc` があり、versionは `release-20260824.0-120-g727c8c389c36-dirty` / spec1.2.1。これを固定した一時OCI probeはDocker検証より実Actorに近いが、Actorの生成・snapshot・RPC・停止の証明とは別に残す。

当初の「4tmpfsをOCI内部に設定する」案はinode上限が効かず不採用となった。後続ではimageを一時bundleへexportし、信頼側で4つのLinux tmpfsを作成・検査してOCIへbindする。固定argvは `python3 -I -B /opt/ax-code/launcher.py --profile host-quota-v1`、UID/GID0、上記5cap、stdin有効、root readonly。`/proc`と`/dev/null`は親launcher用に用意し、子chroot内へはmountしない。stdinに小さい固定JSONを渡してEOFを閉じる。Python内部でmountせず、未対応optionを見逃すための検査緩和もしない。host版の直接試験結果は末尾に記す。

## AX実Actorに必要なpatch入口と手順

以下は後続作業の概要。詳細と追加の必須条件の正本は [host-quota-design.md](host-quota-design.md) とする。旧OCI内部tmpfs案はhost quotaへ差し替わった。golden snapshot、cleanup、reset前guardや旧状態不明workerの全新規受付停止（HQ1）まで必要であり、mount追加だけで実Actorへ進めない。当担当は上流やliveを変更していない。

1. **Substrateの固定code profile**：`cmd/atelet/oci.go:79`の`prepareOCIDirectory`が保存する解決済みImageDigestをateom側でも固定digestと照合する。`cmd/ateom-gvisor/main.go`のSetupBundleRootfs後・runsc create前に、Actor専用のhost Linux tmpfsを作成・検査し、固定4pathへOCI bindで渡す。ateletやguestにmount権限を追加せず、Task本文やenvを任意mount指定に使わない。必要なOCI process/root/resourcesとbindの固定値をcodeだけに設定し、ShapeGVisor後も検査する。既存imageのspecは変えない。解除や再起動時の条件はhost-quota-design.mdに従う。
2. **AXのcode専用template**：`internal/substrate/client.go:212`のBuildActorTemplateと`:279`のEnsureActorTemplateWithImageのcode専用分岐を同期する。guest commandは既存`/usr/local/bin/ax-task-runner`でRPCを保ち、code image digest、env鍵なし、`capabilities.drop=[ALL] / add=[KILL,SYS_CHROOT,SETUID,SETGID,SETPCAP]`、固定CPU/memory、必要最小volumeを生成する。単に既存ActorTemplateを管理APIで書き換えない。
3. **厳密な照合**：`ax-local/patches/credential-free-atespace.patch:38`の期待templateも同じcode生成関数を使い、Readyz timeout30の上流defaultを含めてreadbackする。Containers/Volumes/Sandbox/Snapshotsに加えResources等profileを左右する項目も照合。credential-free atespaceに限定し、通常Runtimeのcapsは増やさない。ats namespace/workerpoolを隔離根拠にしない。
4. **無課金の実Actor probe**：同時枠1で既存Actor停止を確認してから一つの新code Taskをcreate/resume。env.protoのProcessServiceで固定launcherを`stdin:true`で一度だけStartProcessし、`WriteProcessInput`で小requestと`close:true`を送る（env固定moduleの`guest.proto:146,197`）。出力／exitをboundedに回収し、設定失敗ならコード開始なし。Start/入力ACK不明では新processを再実行しない。将来の8MiBはこのstdin JSONの拡張で済ませず、別の封印済みstageを作る。
5. **実効確認**：子からTask内localhost80 Process/FileSystem、IPv4/IPv6/UDP/DNS/UNIX、親PID/state/FDを試し、受信側sentinelにも届かないことを確認する。親RPCは維持されること。quota超過、fork/thread、親急死、設定失敗、zip展開量過大も確認する。codeからは通信不能でも、親RPCには必要な通信が残る区別を保つ。
6. **終結**：子wait→成果物/hash照合→外部保存→egress deny→AX SuspendだけでなくSubstrate Actor停止・worker未割当を確認。開始ACK／停止不明はhold。失敗Actorをresumeして同じコードを再実行しない。Runtime→code→Runtimeは各Actorの実停止を挟み、PG rootの時間／費用／回数を引き継ぐ。

host profileのdirect runsc試験を終え、次はcode profileの基盤差分・golden/cleanup/HQ1と独立レビュー→実AX固定fixture→chunk/PG統合→模擬model→承認済み最少の実modelへ進む。任意Pythonの実Actor gateが未通過なら、その部分は公開しない。現launcherはstandalone stdin/stdoutであり、DB job、stage/start/collectの永続操作台帳、stop/recovery、8MiB搬送への接続は未実装。

## 依存の一次資料と保存候補

wheel版/hashは [openpyxl PyPI](https://pypi.org/pypi/openpyxl/3.1.5/json)、[defusedxml PyPI](https://pypi.org/pypi/defusedxml/0.7.1/json)、[et-xmlfile PyPI](https://pypi.org/pypi/et-xmlfile/2.0.0/json) で照合。FIOCLEXの調査は [CPython fileutils](https://github.com/python/cpython/blob/v3.12.10/Python/fileutils.c) のFD継承設定を参照し、image Python3.12.15で実測した。

OKF保存は親担当。候補は「同じguest内の制御RPCから未信頼子を隔離するにはchroot/UID/cap/FD/seccomp/quotaを全部満たす」「Docker成功と固定runsc・実Actor成功を区別する」「コード/metadata/fileのサイズ上限を分ける」。局所実装・Docker検証と、親が実施したdirect runsc検証を出所付きで分け、実Actor成功として保存しない。


## Docker初回検証版

- Docker隔離11件＋終了済み子ログの局所1件、合計12件が13.712秒で成功。修正後imageは上記 `3eb6cf47…`。コンパイル確認と担当範囲のdiff whitespace確認も成功。
- launcher SHA256: `b8fac0eeca8fd9d048a071007c4b7f9fa153cedac5b3cc66c90bb553a1328dd1`。security SHA256: `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255`。
- 検証対象source/tests一式 SHA256: `577ba4270195efe3104d8bfef3bb6846cd18e9248ec9c0f1221b35ab5105ae8c`。対象はcode_runtimeの4つのpy、requirements.lock、deny-seccomp-test.json、Dockerfile.codeとそのdockerignore、test_code_runtime*.py。相対パス順にpath/NUL/bytes/NULを連結して計算。READMEとこの文書はhash対象外。
- 保存した知識はこの試作記録のみ。OKF保存、独立レビュー受け入れ、実runsc/AX実行・配置は親に引き継ぐ。

## 追補：固定runscの実測で未達となった条件

親の無課金probe報告により、固定runscの内部tmpfsでは `nr_inodes=32` が効かず64空fileを作成できると判明した。f_filesもinput/tmp/outputすべて1,003,178で、nodevはguestのmountinfoに表示されない。image `9a644079…` のlauncherは `setup_failed/unsafe_mount` で止まり、未信頼コードを実行していない。Docker12試験の成功を実runsc成功へ読み替えない。現在の内部tmpfs profileでは実AX統合の隔離条件が不合格であり、検査は緩めていない。

続く親の限定診断では、Linux host tmpfsをOCI bindで渡すとf_filesが16/128/32へ一致し、outputは31空file後にENOSPC(28)。guestでは9p,nosuid,noexecとして見え、nodev表示はない。これはhost quotaの実効性の根拠で、この時点では全隔離・実Actor検証は未了だった。実行証拠は親の [runsc-probe.md](runsc-probe.md)、当担当の読取り調査と限定変更案は [host-quota-design.md](host-quota-design.md) に分けた。既存Docker profileを変えず、host専用profileと信頼側mount検証・終了処理・snapshot境界をそろえる案を親へ引き継いだ。

## host-quota-v1 の実装・最終検証版

親承認により、固定argv `--profile host-quota-v1` をlauncherへ追加した。引数なし／`--profile docker-tmpfs-v1` は既存条件のまま。環境変数での選択はなく、未知値・不足・余分な引数は `invalid_profile` でコード実行前に拒否する。host profileはinput/tmp/output/stateの4mount全部を9p＋nosuid/noexec＋正確なbytes/inodes/UID/GID/mode＋空で検査する。nodevの保証は信頼側host mount検査と固定worker版に依存する。Docker profileのnodev必須は変えていない。

新imageは `ax-code-spike@sha256:6d9837961abc3e28164a7db1ab54d62cd67e222dc4496c195ad98b35099fd8d7`。launcher SHA256は `5230ab96f0dad895c64b83651a79e294a362bebeec82bfbe16f6334a935860f6`。securityは前版と同じ `c96c70ce…`。syscall/cap/FD/CPU等の制限値は変更していない。

試験は変更前imageでhost指定や未知引数が無視されるRed（5失敗）を確認後、変更版で新profile試験6件が1.789秒で成功した。host表示の受理・4mountそれぞれの値/欠落/残存拒否は模擬filesystemの局所試験であり、実9p/runscの成功ではない。Docker試験は明示default成功、環境変数無視、host指定でtmpfsを拒否、未知CLIを拒否。既存のlayout経路へ影響するDocker11件も12.430秒で成功した。mknod/mknodatのFIFO作成拒否を既存敵対ケースへ追加。変更していないwatch局所1件は前版の成功を再利用した。構文確認も成功。

親のrunsc harnessは新規 `test_code_runtime_runsc.py` を親が所有し、`CodeRuntimeTests.run_code` を差し替えて既存11ケースの入力とassertをそのまま再利用する。元のrun_codeは末尾 `launcher_args=None` を追加した以外は呼出し互換。渡される source/inputs/outputs から、`{"version":1,"source":source,"inputs":{name:base64(bytes)},"outputs":outputs or ["result.txt"]}` を作り、固定argv `python3 -I -B /opt/ax-code/launcher.py --profile host-quota-v1` のstdinへ一度だけ渡してEOFを閉じる。

既存11件はCSV、XLSX、network/process/device、chroot/env/FD、setup cap/mount失敗、seccomp失敗、総容量、親急死、CPU/AS/wall/log、inode/FSIZE/FD、出力リンク拒否。期待値は各testメソッドのassertを維持する。`driver` がある親急死試験ではdriver内部の子launcherにもhost argvを付ける必要がある。`omit_cap` / `omit_mount` / `extra` はそれぞれOCI capability、host mount除外、環境sentinel／seccomp失敗注入へ対応させる。既存watchの1件はJSON入力を持たないOS不要の局所試験。Docker用のclass skip条件をrunsc harnessの明示実行条件へ置き換え、誤ってskipを成功として集計しない。

HQ1の採用内容はhost-quota-design.mdへ反映済み。atelet.Runのreset前guard、Terminate NotFoundだけで削除しない条件、mount前workerUID/世代marker、旧状態不明workerの全新規workload停止は後続の基盤実装である。この小単位ではAX patch、Pod/node、live DBを変更せず、課金もしていない。任意PythonのAX配備ゲートは引き続き未通過。

親の最終実測報告では、上記image `6d983796…` と固定runscのhost profileで契約12件が56.853秒で成功した。quota、親急死、nodevによる実device open拒否を確認した。OCI seccompフィルタによる設定失敗注入はこのrunscでは効かなかったため、信頼済みguest driverがseccompとprctlの両設定APIを事前に拒否し、launcherが設定失敗でコード実行前に止まることを確認した。当担当による再実行ではなく、詳細証拠は親の [runsc-probe.md](runsc-probe.md) に置く。direct runscの成功であり、AX実Actorでの生成・golden・停止・cleanupは引き続き未確認。
