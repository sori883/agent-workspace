# 固定 runsc の host quota 案の独立レビュー

2026-10-07、担当 `w1_design_review`。対象は [host-quota-design.md](host-quota-design.md)、[runsc-probe.md](runsc-probe.md)、[Pythonレビュー](python-review.md) と固定 Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` の関連箇所。設計・実装担当とは別担当による読取りレビュー。同じモデルを使っており、異モデル検証ではない。devlow の review と既存の OKF 検索・制約を再利用した。

編集はこの報告のみ。コード、DB、live AX、Kubernetes、モデル、課金に関する操作や試験は行っていない。

## 判定

固定 image/profile に限って ateom の mount namespace に Linux tmpfs を作り、runsc に bind する案を、**次の direct runsc 無課金試作として推奨する**。guest への mount 権限付与、新しい常駐サービス、公開 Volume API の一般化は不要。現在の案は cold start・golden・cleanup の追加変更が必要であることを正しく扱っている。

最終再確認では、HQ1 の設計反映と H2 のハーネス修正を確認し、両指摘を解消とした。親による direct runsc 契約 12 件、runsc/mount の実 timeout 保全、最終正常 CSV/cleanup の証拠も照合した。今回の小単位に残る確定した必須修正はない。mount helper の成功だけで既存 AX ライフサイクルが安全になるとは判断できず、実 Actor、cgroup、再起動・障害時の統合検証は後続に残る。

## 初回確認時の事実と未検証の範囲

| 内容 | 根拠と扱い |
| --- | --- |
| runsc 内部 tmpfs の inode 制限は不足 | 親の固定診断では nr_inodes=32 に対し 64 個の空ファイルを作れた。表示だけの差ではない。現 launcher の拒否は維持すべき。 |
| host bind は inode/bytes 制限の成立候補 | 親の診断は 32 inode の領域に 31 個で ENOSPC、追加実測は output に 1,048,576 bytes 書いた後 ENOSPC(28)、finally cleanup 成功。本担当は実行していない。容量と inode の二つの観測がある。 |
| namespace の置き場所 | `workerpool_apply.go:127` は BasePath を HostToContainer で mount。`ateom-gvisor/main.go:710` 以降の rootfs 構成も ateom 側で行う。gofer と同じ namespace に quota source を置く案は既存構造に沿う。Bidirectional への変更は必要条件ではない。 |
| 必要な管理者権限 | `workerpool_apply.go:289` で worker は既に SYS_ADMIN を持つ。guest の 5 capability と子の全 capability 0 を変えずに済む。 |
| cold start と golden | `template_reconciler.go:167` 以降は通常すべての template の golden を処理し、`actor.go:91` は未指定 SourceTag に golden を採用する。COLD_BOOT だけでは回避できないという設計の指摘は正しい。 |
| 通常停止の既存仕様 | `ateom-gvisor/main.go:843` は checkpoint 後の terminate 失敗を警告にし、`:859` で activeSession を消して成功応答へ進める。`imagecache/bundle_linux.go:332` の解除は MNT_DETACH。これらを code の停止・資源解放の証明として再利用できない。 |
| まだ実証していないもの | 最新 image の全 syscall/UID/cap/FD/親急死試験、host nodev の実効性、gofer を含む終了、quota の cgroup 課金、Worker namespace、実 Actor、snapshot/cold-start 拒否、障害時 cleanup。少量 probe は `--ignore-cgroups` であり、CPU/memory/PID の実 Actor 制限を証明しない。 |

親の追加 bytes 実測は今回の依頼メッセージを根拠として記録した。probe 文書の旧 image を最新 image の全試験成功に読み替えていない。

## 実 AX 実装前の必須補足

### HQ1：証拠を消す前の検査と、汚れた worker 全体の受付停止

`host-quota-design.md:51–54` は marker と cleanup 成功を必要条件にしているが、既存コードへの適用点と crash 時の保持条件を具体化する必要がある。

- `cmd/atelet/main.go:492` の Run は ateom の RunWorkload を呼ぶ前に `resetActorDirs` を実行する。`:1863` 以降の reset は bundle・runsc state・PID file を削除する。同 Actor の開始再試行や再起動時にここへ入ると、ateom 側で残存を調べる前に証拠を失える。code の guard はこの reset より前に置き、既存 code state の有無・該当 worker/実行世代を照合する必要がある。
- `cmd/atelet/main.go:1308` は TerminateWorkload の NotFound を成功扱いし、`:1333` で actor directory を削除する。code では NotFound 単独を解除成功の代わりにせず、同じ世代について process 終結・通常 unmount・mount 消滅の確認がそろう場合だけ、証拠と directory を消すことを明記する。
- marker は最初の mount より前に永続化し、reset の削除対象へ無条件に巻き込まれない位置または削除 guard で保持する。少なくとも actor/container、worker UID/起動世代、profile/image、作成した source を結び付ける。marker と mount の間、runsc create の途中、cleanup の途中で停止しても「旧状態がない」と誤認しない書込み順を決める。
- 旧 code の process/mount が不明な worker は、**code だけでなく通常 Runtime・golden を含む新規 workload 全体**を受け付けない。RPC の mutex は同時呼出しを直列化するだけで、終了失敗後の再受付を自動的に防がない。設計の「worker 空きへ遷移しない」を worker 全体の条件として統一する。別 worker の運用まで一律に止める独自仕組みを作る必要はないが、PG の global hold は既存規則のまま残す。

これは新しい実行正本を追加する提案ではない。PG は実行・再送・費用の正本を維持し、marker は既存 worker のローカル資源を安全に片付けるための記録に限定する。実装単位では、初回 mount 前／部分作成後／stop 後 unmount 前／marker 削除前の障害、同 Actor 再試行、別 Actor の新規開始、Pod 再起動を拒否・復旧試験へ含める。

その他に、現設計案を差し戻す確定した矛盾は見つからなかった。golden skip・明示 SourceTag 拒否・Restore 拒否を一組にすること、DATA Suspend 用 durable-dir を残すこと、子からはそこへ届かせないことは、既存の cold-start 分岐と整合する。ただし code profile の判定は API/template/worker で同じ固定対象へ適用し、通常 Runtime の snapshot は変えない回帰が必要である。

## 次に許容できる小単位

次は **live AX を変更せず、最新版 code image と明示 host-quota profile に限った direct runsc 試験**までが妥当。既存 Docker profile はそのまま残す。

1. 固定 host source の mount flag・size・inode・owner・空状態をホスト側で検査し、未知 source、重複 bind、symlink、古い profile、容量・inode 不一致はコード開始前に拒否する。guest の `9p` という名前だけで信頼を判定しない。nodev を表示確認済みとせず、信頼側検査と実効試験を別に残す。
2. 同じ runsc、最終 image、host profile で CSV/XLSX と Docker 隔離試験相当を実行する。特に socket/loopback/UNIX、親操作、FD、全 capability、seccomp の設定失敗、mknod、親急死、log、bytes/inode ENOSPC を確認する。子の通信不能と、後の実 Actor で親 RPC が必要なことは別の条件として扱う。
3. 全 runsc process 終了→通常 unmount→mount 消滅→一時 path 削除を固定 fixture で確認する。途中失敗も証拠を残し、finally が走っただけで合格にしない。cgroup を無効にした場合は CPU/memory/PID 検証済みとしない。

この小単位の成功後に、固定 profile の OCI 差分と HQ1 の lifecycle guard を一緒に実装・レビューし、その後に実 Actor の障害試験へ進む。先に shared worker を改造したり 8 MiB staging・定期実行まで統合したりしない。

## 複雑さを増やさない代案との比較

- **現 runsc の内部 tmpfs をそのまま利用**：最小だが inode 上限が実測で不成立。任意 Python の要件を満たさない。検査削除や RLIMIT_FSIZE だけでは複数ファイルの総量・inode を代替できない。
- **host tmpfs の固定 helper**：今回の推奨。既存 ateom の権限・namespace・Actor lifecycle を使い、source は一時的、永続成果物は外部正本へ返す。新しい volume 管理 daemon、汎用 mount API、CSI driver は初期範囲に不要。
- **固定 runsc の更新または内部 tmpfs への上流修正**：対応が得られれば host mount 管理を減らせるが、今回は版変更・snapshot・通常 Actor 全体の互換検証が追加になる。現固定版での小試作を置き換える方が簡単とはまだ言えない。今回調べていない新しい版の対応を保証しない。
- **任意 Python を保留して固定 CSV/XLSX 処理だけ提供**：隔離条件を満たせない場合の製品上の代案。任意コードを動かしたまま制限を弱める代替ではなく、提供範囲を狭める判断が必要。

知識の保存は本報告のみ。設計本文・OKF・稼働環境の更新と全体の採否は親へ引き継ぐ。

## direct runsc harness の先行レビュー

追加対象は親作成の `ax-local/tests/test_code_runtime_runsc.py`。最初に確認した SHA256 は `9b3b2c4dbb05da0b5219830386a97b0dc51e02e3d32f747a953ca03421145c5a`。AST parse は成功したが、テスト本体は実行していない。A の候補 image `sha256:6d9837961abc3e28164a7db1ab54d62cd67e222dc4496c195ad98b35099fd8d7` は親が手動 export して使う前提で、ハーネス自体が image digest を実証するものではない。

### H2 / P2：remote command の終了が不明なまま delete NotFound を停止証明にする

`:39–40` の `node()` はローカルで `docker exec` を `subprocess.run(timeout=...)` する。`:102` の runsc が timeout になっても、ローカルクライアントの終了だけでは node 内 runsc の終了を証明できない。一方、`:108` は delete の `does not exist` を成功扱いし、その後通常 unmount へ進む。

再現条件は runsc create の登録前後で外側 timeout が発生し、node 側 command が残る場合。delete 時点の未登録を終了とみなすと、create 継続や子process残存を見逃し得る。元の試験は timeout により不合格になるものの、finally の後片付けと後続 test に同じ root を使うことの安全性は別に満たしていない。mount 呼出しの timeout/ACK 喪失も、成功返却後だけ `mounted` へ追加する現在の方式では追跡外の mount を残し得る。

**初回版では要修正。** 最小の対応は、専用 root の既存 state/owned process が空であることを実行前に確認し、node 側の起動 command とその process を識別して終了を確認すること。delete 後には list 空と該当する process 不在も確認してから通常 unmount へ進む。作成する mount の intent は呼出し前に把握し、失敗時は専用 source の実状態を照合する。停止・解除が不明な場合は、その root の後続 test を中断して証拠を残す。test 用の自動復旧基盤を増やす必要はなく、不明時に中断して親の明示的な限定 cleanup へ渡す方式でもよい。

その他に大きな問題は現時点で確認していない。確認した点は以下。

- 明示された node/root/runsc がない通常実行では skip。root の固定 prefix と realpath、既存 mount の拒否があり、他 workload の path を意図的に列挙・変更する処理はない。ただし専用 root の所有・export 版は親の準備条件も必要。
- 既存 11 契約試験を継承し、Docker で動いた証拠を runsc 成功へ読み替えず実行する構造。親急死用 driver にも固定 host profile を付ける。
- host の tmpfs flags・正確な容量/inode と、nodev の device open 拒否を検査する。子の mknod/process_vm ケースは追加され、元の network/fork/FD/caps/setup 失敗ケースも維持されている。
- `--ignore-cgroups` と外側 OCI の資源指定がないことは明示的な試作制約。ここで確認できる child の rlimit と、実 Actor の CPU/memory/PID cgroup 制限を分ける必要がある。
- finally は lazy detach を使わず通常 unmount と mountpoint 消滅を要求する。ただし H2 の process 終了確認が先に必要であり、このコードを読んだだけで後片付けが実証された扱いにはしない。

HQ1 の設計反映は A から完了報告を受けている。H2 は親へ共有済みで、修正後の読取り確認と実行結果は後続の証拠として扱う。

### H2 の修正途中の再確認

harness SHA256 `e458293696c5ef907c3cf2f685995b3068cd3a54ba97f50a219de85459d4a2ab` を読取り確認した。runsc の呼出しが timeout または非 0 終了の場合は delete/unmount を行わず dirty とし、後続 `run_code` を拒否する。正常 0 終了時だけ delete→list 空・専用 bundle 参照 process 不在→通常 unmount へ進む。runsc 開始の不明結果については H2 の修正を確認した。

ただし、この版には mount 呼出しの timeout が残っている。`:119` で timeout になると `mounted.append` より前であり、`attempted_run=false` のまま。finally はその未知 mount を追跡せず、dirty も立てない。node 内 mount が後から成功する可能性が残るため、`node()` の TimeoutExpired を一律 dirty として、それ以降は finally でも delete/unmount せず保全する最小修正を親へ依頼した。該当箇所を直すまで H2 全体は解消扱いにしない。process の照合は `ps -ww` で引数を省略しないことも共有した。

親から、初回 runsc 試験は timeout なしで 11 件成功・1 件失敗、終了後 list 空・owned process なし・4 quota 通常 unmount を別途確認したと報告を受けた。失敗は OCI seccomp の拒否注入が適用されず succeeded となったもの。製品フィルタを弱めず、信頼した guest driver が libseccomp で seccomp syscall と prctl(22) の両方を事前拒否してから launcher を exec する fixture へ変更した。コードを照合し、親の `E:seccomp:0`／生成コード開始前失敗の実測報告と対応している。これは設定失敗の注入方法の修正であり、OCI seccomp が有効になったという証拠ではない。最終全 12 件と実 timeout の保全・後続拒否の結果はこの時点では未受領。

### launcher の host profile 再確認

launcher SHA256 `5230ab96f0dad895c64b83651a79e294a362bebeec82bfbe16f6334a935860f6`、security SHA256 `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255` を照合した。security は前回から不変。

- profile は固定 argv の `--profile` で既知の 2 値だけを受け付け、不明・余分な引数を拒否する。既定は docker-tmpfs-v1。環境変数や生成コードの入力から host profile を選ばない。
- host-quota-v1 は input/tmp/output/state の 4 mount に 9p・nosuid/noexec、正確な bytes/inode、UID/GID/mode、空状態を要求する。古い大きい f_files を許容する変更はない。nodev は固定 host 側の検査が必要という設計条件を維持する。
- 既存 Docker profile の tmpfs・nodev 必須条件、capability・FD・chroot・seccomp・回収制約は緩めていない。新しい profile 試験は mock layout と Docker の失敗経路を分けている。

この限定差分に追加の必須指摘はない。host profile を選べること自体は信頼した host mount の証明ではなく、固定 fixture／後続 worker の host 検査とセットで使う前提である。

HQ1 の設計本文も再読し、reset 前の guard、NotFound 単独での削除禁止、mount 前の marker、worker 全新規 workload 停止が反映されたことを確認した。設計上の HQ1 は解消し、実装・障害検証は後続に残る。

### H2 最終確認：解消

最終 harness SHA256 は `757c3add12cbecdaba2bc0a877a50dd50dbeb11ac87eaf225f5a63624f7bcc91`。`node()` が classmethod になり、TimeoutExpired/CalledProcessError で dirty を立てる。finally は dirty または runsc の完了不明時に delete/unmount へ進まず、その専用 root を保全する。新規開始は dirty を先に拒否し、開始前にも list 空、`ps -ww` による専用 bundle 参照 process 不在、旧 quota mount 不在を確認する。正常 0 終了後だけ delete→list/process 確認→通常 unmount を行う。前回残った mount timeout もこの同じ保全経路へ入ることを読取り確認した。

親による以下の証拠と報告を照合した。本担当による実行ではない。

| 証拠 | 確認結果 |
| --- | --- |
| [runsc-timeout.json](evidence/runsc-timeout.json) | 実 runsc の通信 timeout 0.7 秒後に node 側 3 process が残る条件で、dirty=true、quota 4 mount 保全、2 回目の開始拒否、run 呼出し合計 1 回。 |
| [mount-timeout.json](evidence/mount-timeout.json) | node 側 mount を 1 秒遅延し通信を 0.1 秒で timeout にした条件で、dirty=true、後発 mount 保全、2 回目の開始拒否、mount 呼出し合計 1 回。 |
| [runsc-contract.txt](evidence/runsc-contract.txt) | CSV/XLSX、UID/chroot/FD、network/親操作、資源、成果物、親急死、seccomp 設定失敗等の direct runsc 契約 12 件が 56.853 秒で成功。 |
| [runsc-final-cleanup.txt](evidence/runsc-final-cleanup.txt) | node timeout 一律保全の最終修正後、正常 CSV と正常 cleanup の経路を 2.544 秒で再確認し 1 件成功。 |

timeout の JSON は保全・後続拒否の証拠であり、自動復旧成功を示すものではない。親は各実験後に node command の終了、list 空、owned process 不在を別途確認して通常 unmount したと報告している。保全と手動の限定復旧を分けた仕様と一致する。契約 12 件すべてを最後の node timeout 修正後に再実行したとは数えず、後続差分に対応した 2 種の timeout と正常 CSV の検証として扱う。

H2 は source と実 timeout 証拠の照合により解消した。今回レビューした host profile／direct runsc harness に追加の確定した必須指摘はない。固定 AX/Substrate への code profile・HQ1 の lifecycle guard の実装、実 Actor の停止と worker 再利用、CPU/memory/PID の cgroup、8 MiB staging、Runtime→code→Runtime の統合は未実施であり、任意 Python を製品公開する判定には含めない。
