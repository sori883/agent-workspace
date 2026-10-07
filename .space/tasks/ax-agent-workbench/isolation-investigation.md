# 生成Python用Taskの隔離条件

2026-10-07、担当 `w1_design_review`。基点 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、branch `codex/agent-workbench`。コード読取りだけで調査し、この文書のみ保存した。製品・共通task・OKF・稼働Pod・ネットワーク・DBは変更せず、モデル送信・試験実行は行っていない。設計候補A/Bの選定は対象外。

## 結論

**別AX Taskに分けるだけでは、生成Pythonを安全に開放する条件を満たさない。** 現TaskはUID 0・書込み可能rootfs・debug有効の汎用guest RPCを持つ。egress denyは空のEgressPolicyの保存・再読取りであり、Task内loopbackやDNSを含む全通信遮断の証明ではない。

code Task内の「信頼済み親runner＋権限を落とした子Python」は、親の制御RPCを維持する有力な試作案。ただし固定版でchroot・UID切替・seccomp・資源制限を組み合わせた実Actor証拠はなく、現image／設定のまま成立するとは言えない。隔離ゲートが通るまで、固定の信頼済み集計処理と任意生成Pythonを同等には扱わない。

## 固定版と既存制約

- AX `ac2332829f22360ff97b0ba34d94dd0dd782f17e`、Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` を `.sources` のHEADで確認。AXにはリポジトリのcredential-free patchを重ねる。
- env moduleは `v0.0.11-0.20260912052224-4468a200b170`。module cacheのguest実装を確認した。
- 固定SubstrateのSandboxConfigはgVisor nightly **2026-09-02**、arm64 tar SHA256 `a64916f9813ce7e4841a30480a599337f7dda07b421c6bf0123db2212aa7d1df`（`ax-local/.sources/substrate/manifests/ate-install/sandboxconfig-gvisor.yaml:25`）。今回liveのrunsc版・digestを再取得していない。gVisorのguest syscall実装ソースはこのcheckout／確認したmodule cacheにないため、seccomp等の対応を静的に証明したとはしない。
- OKFの全rule/principle descriptionと `execution/native/`、`ax-local/task_runtime/` のパス検索を実施。費用ルール、boundary-discipline、prove-it-works、agent-runtime、portable-api-postgres、local-kind-environmentの該当本文を参照。全writer共通枠1、未知usage／停止不明hold、鍵をTask外に置く境界を維持する。旧HTTP/HTTPSのallow/deny試験は任意通信・敵対コードの隔離証拠ではない。

## コードで確定した条件

| 項目 | 現版の事実と含意 |
| --- | --- |
| Taskの制御RPC | `execution/native/adapter.go:205` と`:231`でTask specは `Debug:true`。AX `internal/metadata/server.go:73`でdebug時にProcess/FileSystemを有効化し、`:117`で`:80`相当のHTTP/非暗号HTTP2に載せる。runnerは `AX_METADATA_URL=http://127.0.0.1:80` を子へ渡す（`runner/runner.go:140,241`）。Task内部の接続にmTLSはなく、任意子が同じネットワーク名前空間でsocketを使えればloopbackから到達できる。 |
| 外部からの制御 | `execution/native/direct_guest.go:64`以降は現在Actorのworker443へ、CA・SPIFFE・client証明書を検証して接続する。これはworker入口の保護であり、Task内部のlocalhost RPCを認証するものではない。AXの管理gRPCのloopbackはcontroller Pod側で、Task内localhostとは別。 |
| RPCの権限 | env `guest/server.go:79`は認証interceptorなしの `grpc.NewServer()`。`guest/process/tracker.go:345`は任意commandを親と同UID・環境で起動し、Cwdだけを変え、chroot／資格情報変更はしない。APIの10同時process・既定1時間・ログ各10MiBは、このAPIが追跡するjobの上限であり、生成コードのfork数・全ディスク上限ではない。 |
| UIDとrootfs | Substrate `internal/ocispec/ocispec.go:83`はUID/GID 0、rootfs writable、`/proc`あり、rlimitはNOFILE 1024のみ。DockerfileのUSERだけを変えても、このOCI生成がその値を読む経路は確認できない。`cmd/atelet/oci.go:45`の既定capabilityはAUDIT_WRITE・KILL・NET_BIND_SERVICE。子は現在同UIDなのでrunner・receipt・コードの改ざんを防ぐ境界がない。 |
| egress deny | `execution/native/adapter.go:344`以降はEgressPolicyのrulesを空にして再読する。Substrate `internal/ateomnet/net.go:205`以降はIPv4 TCPをtunnelへredirectし、UDPは**宛先53だけ許す**。このルールはDNS宛先のIPや質問名を制限しない。loopbackはこのforward経路を通らず、Task内RPCへ届く。worker NetworkPolicyはIngressのみ（`cmd/atecontroller/internal/controllers/networkpolicy_controller.go:105`、`web/scripts/deploy-execution.ts:40`）。 |
| tunnel無し | Substrate `cmd/ateom-gvisor/main.go:1224`と `internal/ateomnet/net.go:336`はegress gateway無しでTCP redirectを省きmasqueradeへ残す。gateway未設定を「network none」として使ってはいけない。IPv6、ICMP等もこのIPv4 TCP/UDPルールだけで全拒否と断定できない。 |
| CPU・memory | Substrate ActorTemplate/ContainerはCPU・memory limitのみ表現する（`pkg/proto/ateapipb/ateapi.proto:795,984`）。`internal/sizing/sizing.go:73`とOCI生成でcgroup CPU quota／memory limitへ渡す経路はある。現WorkerPool設定は1 CPU／1GiB（`ax-local/deploy/workerpool.yaml:13`）で、親runnerも影響を受ける。AX `TaskSpec.resources`フィールドはあるが、固定 `BuildActorTemplate` に転送されず、`internal`の参照検索でも利用実装を確認できない。任意値をTask YAMLへ書くだけでは制限を設定できない。 |
| PID・disk | 現ActorTemplate APIとOCI生成にPID上限・総書込み量・inode上限の設定を確認できない。durable_dirは空の定義（proto`:1116`）、rootfs overlayとworkspaceは書込み可能。成果物64KiBの検査は保存後の回収上限であり、実行中のディスク枯渇を防がない。外部volumeにはcapacityがあるが、現Taskは使わず、rootfs・一時ファイルまでの総量保証でもない。 |

上記AX相対パスは `ax-local/.sources/ax/`、Substrate相対パスは `ax-local/.sources/substrate/`、env相対パスは `/Users/const/go/pkg/mod/github.com/agent-substrate/env@v0.0.11-0.20260912052224-4468a200b170/` を基準とする。

## 親runnerと子Pythonを分ける案

これは成立条件の提案で、採用・実装・対応確認済みの仕様ではない。

1. **別code Taskを固定profileで作る。** Runtimeとは別image／Task ID／作業領域。鍵・DB・Gateway capability・SDK状態を渡さず、code bytesと許可済み入力だけを渡す。親runnerと制御RPCは信頼済み側に置く。現在のax-runtime credential-free照合はcontainerを厳密比較するので、権限やvolumeを黙って足さず、code専用の期待templateと検証を追加する（`ax-local/patches/credential-free-atespace.patch:38`）。
2. **子の権限を実行前に不可逆に落とす。** 専用chrootへ必要なPython／ライブラリだけを用意し、cwdも内側へ変更。親のコード・状態・`/proc`・制御socket・外部directory FDを置かない。補助group、UID/GID、capability全set、no_new_privsを固定し、root-owned入力／ライブラリを子に書かせない。継承FDは必要なstdin/stdout/stderrだけ、環境もallowlist。現在の既定capabilityではchroot／UID切替ができないので、親launcherにSYS_CHROOT・SETUID・SETGID等の最小権限をどう渡し、子のbounding setまで落とすかを固定版で実証する。広いSYS_ADMIN／NET_ADMINを便宜的に付けない。
3. **子だけにsyscall制限を適用する。** seccompが固定runscで使えることを先に試す。socket作成・接続、UNIX/IPv4/IPv6、既存socket FD経由、io_uring等の別入口、ptrace／process_vm／pidfd／他PIDのprlimit・signal、namespace/mount変更を拒否する固定allowlistを検討する。単にPythonのsocket moduleを外す方式は不可。filterが未対応・設定失敗・解除可能なら生成コードをexecせず終了する。親には必要なRPCを残す。
4. **子の全生存期間と資源を親が管理する。** rlimit CPU/AS/FSIZE/NOFILE/NPROCとwall timeoutを設けても、per-process・per-fileと総量は別。脱退したprocess group、fork/thread増殖、子孫の残存を含めて停止させる。CSV/Excelライブラリが要するthread/syscallは実測し、無制限cloneを許さない。hardな総disk/inode量と集約memory/PID制限が未解決なら公開ゲートは未通過。監視してからkillするだけを厳密quotaとは言わない。

Task全体からネットワーク／debug RPCを除く案はguestの攻撃面を減らすが、現行StartProcessによるstage・start・collectを使えなくなる。別の外部回収方式まで変更する必要がある。親子分離案は現制御経路を再利用できる一方、launcherとsyscall境界が新しい信頼対象になる。固定gVisorでの機能対応と敵対的試験が判断の前提で、現時点で安全性等価とは断定しない。

## ファイル搬送とRuntimeへの復帰

現nativeは固定runner operationをStartProcess経由で呼び、JSON/base64をstdoutで回収する（`execution/native/guest.go:9`）。入力は合計4096 bytesのUTF-8、成果物は1件64KiB（`ax-local/task_runtime/protocol.py:9`）。Excel binaryや一般サイズのCSVをこの契約のまま扱うことはできない。owner/root/attempt/名前・size・SHA256・総量上限を外部のmanifestへ固定し、短いchunkと固定操作による転送契約が必要。

任意pathを汎用FileSystem RPCへ渡すだけでは不十分。env `guest/filesystem/service.go:88`はclean/prefix確認後に通常のOpenFileで開き、symlink追跡を遮断する実装ではない。現runnerのO_NOFOLLOWとregular-file確認（`runner.py:31`）も最終componentの検査で、敵対的な親directory差替え・共有UIDを前提にした境界ではない。子を完全に停止した後、信頼済み親がdirfdを基準に配下限定・symlink/hardlink/special file拒否・数と合計bytesを確認して回収する。

code Taskの出力は内容が未信頼のデータ。receipt、usage、権限、checkpointとして採用せず、再検算可能な集計値・成果物manifestとして外部へ保存する。pickleやcode TaskのPython module／実行環境snapshotを信頼済みRuntimeへ戻さない。Runtime再開時は外部の確認済みcheckpointと選別した結果だけを読み、結果中の文言から権限・送信許可を追加しない。

## 同時枠1を維持する順序

1. Runtimeがcode要求を出す → 外部へcheckpoint・入力manifest・操作intent・既知usageを確定する。
2. **Runtime Taskをdeny→Suspend→Actor SUSPENDEDかつworker未割当の実観測まで終える。** その後だけ、同じglobal slot管理下でcode attemptへ移る。RuntimeをRPC待ちで生かしたまま別code Taskを走らせない。
3. code Taskの親が子と子孫の終了を確認 → 制限付き出力を回収・外部へ保存 → code Taskのdeny・実停止・worker未割当を確認する。
4. その後に本人権限・停止・残時間／費用を再確認してRuntimeの次区間を開始する。枠の移管はDBの一つの順序として扱い、次attemptの開始許可を先出ししない。操作ACK・usage・停止が不明ならhold、開始再送や再resumeで埋め合わせない。

現在の終了手順 `execution/controller/controller.go:224,299` と `native/adapter.go:309` は再利用できるが、生成コードではprocess group killだけを「子孫全停止」とするのは不可。Task全体の実停止が最終の境界になる。複数区間で時間・費用・call数をリセットしない。

## 開放前の無課金ゲート

- 固定image・runsc版／digest・実Actor templateのUID/caps/limit/env/volumeを読み戻し、起動前の不一致で拒否する。資源フィールドをAXからSubstrateへ実際に伝える経路も確認する。
- 子からlocalhost:80のProcess/FileSystem、親PID・状態・外部FD、UNIX socket、IPv4/IPv6、DNS UDP53、任意TCP/UDP、host/pod/service宛てを試し、受信側の観測まで含め拒否を確認する。親のcontroller RPCは引き続き成功すること。秘密の代わりにsentinelを使う。
- chroot脱出、setuid/cap再取得、親へのsignal/ptrace、fork・setsid・thread、seccomp設定失敗、CPU/memory/PID/一時disk/inode/log枯渇を試し、親または外側controllerが必ず終結かholdへ進むこと。機能単体のsyscall成功だけを隔離成功にしない。
- symlink・path差替え・特殊ファイル・巨大／多数ファイル・圧縮されたExcelの展開量超過を拒否し、正常なCSV/Excel集計の数値とbinary download hashが一致すること。
- Runtime→code→Runtimeの各境界で停止・controller再起動・ACK喪失を入れ、常にactive Actorが最大1、codeやモデルの再送0、保存物の混同0を外部台帳とActor観測で確認する。

上記は未実施。調査結果は設計判断へ渡せるが、任意Pythonの公開可否は未確認のまま。OKF保存候補は「egress denyの適用範囲」「guest内部RPCとUID境界」「AX resources未伝播」で、保存・採用は親へ引き継ぐ。

## 追補：guestへmount権限を与えないtmpfsの構成

**既存のActorTemplate Volumeから、任意の場所へsize・nr_inodes付きtmpfsを指定する経路はない。** `ateapi.proto:1074`の型はdurable_dir／external_volume_template／system_info／imageだけで、`internal/ocispec/ocispec.go:165`はこれらをbind mountへ変換する。既定`/dev`だけはOCIのtmpfsだが容量・inode optionが無い（同`:121`）。microvm向けの固定tmpfs設定をgVisor経路の機能と取り違えない。

一方、mountはguestのPythonではなく外側のOCI生成とrunsc createが行う。`cmd/atelet/oci.go:151`でOCI specを保存し、`cmd/ateom-gvisor/runsc.go:60,76`がそのspecを読み、gVisor用に整形して起動する。`ShapeGVisor`は既存mountを消さない（`internal/ocispec/gvisor.go:50`）。したがって**外側で固定mountを追加する小さいpatchは可能な構造**であり、guestへSYS_ADMINを付ける必要はない。ただし、固定runscが`size`と`nr_inodes`を受理・強制するかは今回のソースでは確定できない。

最小試作は、管理者が固定したcode image digestと厳密なtemplateにだけ対応する実行profileを、`prepareOCIDirectory`→`ocispec.Options/Build`へ伝え、image内に予め作った`/sandbox/tmp`と`/sandbox/output`へ`Type:tmpfs`、`Source:tmpfs`、固定の`size=...`・`nr_inodes=...`・`nosuid,nodev,noexec`を追加する案。chroot後の子には`/tmp`と`/output`として見せる。公開Volume APIを一般化するより小さくできるが、選択は管理者設定と解決済みimage digestに結び、Task本文や生成コードが任意mount optionを指定できないようにする。AXのcode用template照合とnativeの期待profileも同期する。実装対象はOCI生成・profile伝播・固定worker配置設定・対応する単体試験であり、現行Task全体の既定mountを変更しない。

2つのtmpfsなら総bytes／inode上限は両方の和として定義する。他の書込み可能領域・継承FDをchroot内へ残すとこの上限を迂回できる。ライブラリ・入力はroot所有で子に書込み不可、tmp/output以外を作業場所にしない。stdout/stderrの親側保存と共有メモリ等はtmpfs quotaの外なので、別途log上限・memory/PID制限を保つ。tmpfsは非永続とし、子の全停止後に親が回収して外部へ確定し、Taskのsnapshotから結果を復旧する経路は作らない。

無課金の実Actorでは、mount情報の読戻しに加え、容量超過と空ファイル大量作成がそれぞれ拒否されること、optionの無視・起動失敗を検出して子を起動しないこと、親RPCが生きたまま回収／停止できることを確認する。`nr_inodes`未対応なら、ファイル数を見て後からkillする方式をhard上限の代用にせず、別の実効quota又は基盤修正を選ぶ。この実証前に「tmpfs設定で総ディスク問題を解決済み」と扱ってはいけない。
