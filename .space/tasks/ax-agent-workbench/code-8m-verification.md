# P2: 8 MiB code runner と公開 cleanup 証拠

2026-10-07、担当 A。`codex/agent-workbench`、基点 `ede929e` からの未コミット成果物。既存 design / host-quota-design / HQ1 を再利用し、割当範囲の実装と局所検証を完了した。実 AX Actor の配備・結合は親の次工程であり、この記録の合格に含めない。モデル送信 0、稼働 AX / DB の変更なし。

## P2 初回受け渡し時の成果物と版

所有範囲は `ax-local/code_runtime/`、`runner/Dockerfile.code`、対応 Python tests、`patches/code-runtime-*.patch`、prepare/verify、8 個の Go test fixture、code profile 用 Dockerfile 2 個。親の task_runtime、B の execution、C の SQL は変更していない。共有 `.sources/ax` と `.sources/substrate` は差分なし。

| 製品成果物 | SHA-256 |
| --- | --- |
| code_runtime/runner.py | `a0aa485c64e8068eedf89ad3b4829643063d44db09fde211fb44b1f9e51c218b` |
| code_runtime/launcher.py | `e21f7e4b1962529d958a37b02ac0a286421485a8f894b035df9fda39b982804b` |
| code_runtime/bootstrap.py | `66a1d161919e533f2528e161afe6ace47b5e97691403a1dff6cb686d64e6c7aa` |
| code_runtime/security.py | `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255` |
| code_runtime/build_sandbox.py | `5f1a4903e3450814c675c3220a182dde01ce96bfde4dfcb1f32cee844fd86ab2` |
| code_runtime/requirements.lock | `770e1a29d5ead5489aaa872cf1e6cf1482101d75a6aa97bddd3e684849b21a88` |
| runner/Dockerfile.code | `608eb6f27be2d5bb2efa8296946d226664944075a2ce8054cd6e81768a7e953d` |
| patches/code-runtime-ax.patch | `d11b279ca526e1615a13916277abe68e4b0da8cab0a3a0a5fc81e0c97b519ccc` |
| patches/code-runtime-substrate.patch | `b221906a87c15e14dcc9baa742a8ab64e30b72f896f884786f55d1f7c23cb473` |
| patches/prepare-code-runtime.sh | `6eeb61c611562c1a35c5a0034f9700070ebbda86ccceae1efe30e3cdcb3751aa` |
| patches/verify-code-runtime.sh | `ddd1c40cc41e1c6a8ae7dfd7ec2441a390119242079f932824f8478178e2c0fa` |

P2 ローカル image `ax-code-8m:local` の Docker identifier は `sha256:c31da8b762c16fef7085bb17c3593f428cc3de2d667db821ac170ff7f176cafb`。build 出力の image manifest は `85de7e4193804c83bf47e33b6111225ef78e9c5fcde38c50a347c72fd7d534b2`、config は `72b8b634122ac03bfbffdaac5706e2c7aa34c80d158549455e68d4ffb4f9d1e2`。README 更新後に再ビルドした最終 image 内で runner/launcher/security/bootstrap の上表 SHA を実読照合済み。直前の実 CLI 試験 image `86a3174c…` から製品 Python の変更はない。ここでは registry へ push していない。設定する `repository@sha256:...` は親が公開先で確認した manifest digest を使い、config ID や tag から推定しない。

## 実装した契約

- 固定 TaskSpec command は `[python3,/opt/ax-code/runner.py,wait]`、ActorTemplate command は `[/usr/local/bin/ax-task-runner]`。AX patch は code command/debug を厳密検査する。ActorTemplate の env は空で、鍵も `AX_TASK_YAML` も持たない。OCI には固定 image の Python/CA 用 ENV が継承される。
- B の controller は Resume intent 内で AX Resume 後に固定 wait process を一度だけ開始する合意。ProcessService timeout は区間残時間（最大 300 秒）。ACK 不明なら hold、recovery/status から再起動しない。runner wait 自体は全待機の timeout を持たず、stage 後の開始と実行では区間残時間を検査する。
- `stage-begin/chunk/seal` は固定 32 KiB chunk、run/descriptor/file/alias/index/size/SHA を照合。begin と seal の同一再送、seal 前の同一 chunk 再送だけを許す。`code-start` は exclusive な開始記録を作り、一度しか送信できない。
- 入力 4 件・合計 8 MiB、source 4 KiB、出力 4 件・宣言上限合計 8 MiB。code は `/input/<alias>`、`/output/<CSV/XLSX basename>`、`/tmp` を使う。出力順と canonical manifest SHA は descriptor に一致する。成果物は旧 inline Collect へ載せず、manifest / chunk で回収する。
- input/source は child から read-only。親 state は chroot 外、mode 0700。state 保存は NOFOLLOW、通常 file / root owner / link 数、atomic publish、file/dir fsync を検査する。unknown な部分保存を実行成功へ読み替えない。
- summary は stdout/stderr 合計 8,192 UTF-8 bytes。result は既存 v2 の 9 field、usage 5 field は 0、estimated_usd 0。signal exit は `128+signal`。出力・summary は未信頼で、使用量や権限・停止の正本ではない。
- code descriptor の definition manifest は agent 0–1 件（指定時は先頭）と skill 最大 8 件。history 最大 17 件、canonical JSON 合計 16 KiB。root/descriptor の固定 SHA と残時間を検査する。

profile は `host-quota-8m-v1`。論理 8 MiB と物理 quota を区別する。

| host quota | bytes | inodes | UID:GID | mode |
| --- | ---: | ---: | --- | --- |
| input | 8,404,992 | 16 | 0:0 | 0755 |
| tmp | 8,388,608 | 128 | 65532:65532 | 0700 |
| output | 8,400,896 | 32 | 65532:65532 | 0700 |
| parent state | 262,144 | 32 | 0:0 | 0700 |

input は 8 MiB + source 4 KiB + 4 file のページ端数最大 12 KiB、output は 8 MiB + 最大 12 KiB。host 側 nodev/nosuid/noexec と guest 9p/nosuid/noexec の照合を維持する。CPU 2 秒、AS 256 MiB、wall 最大 5 秒、FD 32、NPROC 1、child 全 capability 0 は旧試作から変更していない。未信頼コードへの SYS_ADMIN/NET_ADMIN や新たな cap は追加していない。

## 公開 cleanup 証拠

Substrate 公開 `ActorStatus` field 12 に message `CodeCleanup` を追加した。nested field は 1 actor_uid、2 worker_uid、3 generation（UUID string）、4 image_digest（sha256:64hex）、5 profile、6 cleaned（bool）。新 field を知らない既存 client は protobuf unknown field として扱える。B は公開 module を更新せず bounded decoder で field 12 を読み、欠落・不正・重複を証明失敗にする。

worker が code を停止し、runsc 状態と private PID namespace の残存 executable process が無いことを確認し、quota と bundle を通常 unmount して不在を再確認する。network cleanup と耐久 `.done` 保存、`.pending` 削除後にだけ証拠を生成する。既存 marker の worker UID / generation / actor UID / image digest / profile の一致を要求し、再起動した worker の世代から旧 done を流用しない。

内部 ateom TerminateWorkload/CheckpointWorkload → atelet Terminate/Checkpoint → control API を同じ型で通す。atelet は証拠を検査してから reset 等へ進む。control は現在の actor UID と割当 worker を再検査し、server-owned status に保存する。Terminate NotFound、worker 喪失、cleanup 不明から証拠を生成しない。証拠が保存された直後は SUSPENDING の場合もあるため、controller は最終 Suspended / worker 未割当も別に必要とする。guest result は証拠の入力にしない。

P1 の cold-only / golden skip / SourceTag・Restore 拒否 / reset 前 guard / node orphan hold を維持する。node の未完了 marker の lock owner が不在なら、通常 Runtime / golden を含む全新規 workload を保留する。PID 単独判定、lazy unmount、自動 takeover は追加していない。

## 実行した確認

| 確認 | 結果と対象 |
| --- | --- |
| patch prepare/verify | 最終 2 patch で成功。追加 top-level 36 件、AX controller/substrate race と build、Substrate codeprofile/codequota/ocispec/atelet/control API race、Linux 固有 quota/ateom tests、ateapi/atelet/ateom の Linux build |
| 旧 Docker 隔離 | 11 件成功、12.644 秒。P2 初版 image。以後の変更は新 8m quota と runner descriptor の検査のみ。旧 launcher の小入力経路、security/bootstrap は不変 |
| profile 条件 | 7 件成功、1.432 秒。最終 quota の exact / wrong size / owner / mode / contents、Docker/host 混同拒否、未知 argv 拒否 |
| RPC fixture | 最終 runner で 11 件成功、0.137 秒。8 MiB 256 chunk、再送/競合/順序/seal/start 一度、stage 無実行、期限、失敗 usage 0、出力順、単独 skill、history 17 |
| Docker 結合 | 1 file 8 MiB / CSV-openpyxl / signal exit の 3 件が 77.088 秒で成功。物理 padding 追加後の 4 非整列 file 計 8 MiB は 19.145 秒で成功。最終 descriptor 修正後、実 image の単独 skill + history 17 → CSV/openpyxl が 0.952 秒で成功 |
| 固定 runsc | 4 件成功、54.326 秒。CSV/openpyxl（2.851秒）、1 file 8 MiB RPC+network拒否（21.814秒）、4 非整列 file 計 8 MiB（26.706秒）、5cap で ax-task-runner port80 readyz |
| log 監視局所回帰 | `test_code_runtime_watch.py` 1 件成功 |
| 共有上流 | AX/Substrate `.sources` 両方 git status 空 |

Docker 8m harness は mountinfo の FS 名だけを模擬する。隔離 syscall と tmpfs quota は実際の Docker によるが、この成功を host 9p の証明に数えない。固定 runsc は実 host tmpfs → 9p bind、bytes/inodes/flags、nodev device open 拒否、network none で実施した。`--ignore-cgroups` の直接 OCI 試験なので、Actor の cgroup 制約や制御系 mTLS の証明にはならない。

固定 runsc の対象 image identifier は `0905aabbbb680117ac183a743ec99b0ce232a9d3c4db3ef99dd01d53e3c644d8`、runner SHA は `eef4cd2670e6d36ee1c956ebd569c434e408b1e822827d6a8afe42f11cedac50`。その後の変更は definition/history の validator だけ。最終 image で該当 Red→Green と実 CLI 結合を確認し、隔離・quota・cleanup のコード変更はない。最終 image そのものの実 Actor 試験は親へ残す。

### 観測した失敗と修正

- signal exit の最初の Docker 確認は古い image を使って -9 を観測した。製品 source の 128+signal 修正を含む image に更新して成功。同じ試験の期待値は緩めていない。
- port80 の最初の直接 probe は `/workspace` mount が無く、runner の workspace 初期化で終了した。実 ActorTemplate と同じ workspace mount を用意すると 5cap のまま成功。cap の増加は不要だった。
- 4 file の論理合計 8 MiB に対し tmpfs のページ端数分が不足することを確認し、親承認の最大 12 KiB を物理 quota にだけ追加した。4 件とも非整列の fixture で Docker と runsc の成功を確認。
- C の独立レビューで旧「先頭 agent 必須 / history<=9」を検出。2 件の回帰が invalid_request で失敗することを先に確認し、現在の共有契約へ修正。5 契約試験、11 RPC 試験、実 image の CSV/XLSX が成功。C も ContractTests 5 件を別途実行して成功と報告。その他の独立レビューの最終判定は親の記録へ委ねる。

作業用ログは `/tmp/code-8m-{patch-final,runsc-final,rpc-reviewed,integrated-reviewed,profiles-final,contract-red,contract-green}.log`。これらは一時ログであり、永続証拠は本書の対象版・観測結果と再現可能な tests とする。秘密・ユーザーの実データは含めていない。

### owned bundle の後片付け

node `ax-local-control-plane` の `/var/lib/ax-code-runsc-a8m-5e54ab6870c8` だけを使用。最終試験後に runsc state 空、bundle を参照する process 0、quota mount 0 を確認した。残っていた所有 `state-contract/null-netns` を通常 unmount し、全所有 mount 0 / process 0 を再確認して bundle を削除、directory 不在を確認した。既存 Actor、Pod、worker marker は操作していない。途中結果不明時に他の bundle を削除する規則は追加していない。

## 再現と推奨する次の順序

```sh
docker build -f ax-local/runner/Dockerfile.code -t ax-code-8m:local ax-local
AX_CODE_IMAGE=ax-code-8m:local python3 -m unittest discover -s ax-local/tests -p 'test_code_runtime_8m.py' -v
CODE_TEST_IMAGE=ax-code-8m:local ax-local/patches/verify-code-runtime.sh
ax-local/patches/prepare-code-runtime.sh /absolute/new/code-sources
```

AX は `ac2332829f22360ff97b0ba34d94dd0dd782f17e` + 既存 credential-free patch + code patch、Substrate は `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` + code patch。公開・内部 protobuf の `.proto` と固定 generator 由来 `.pb.go` を patch に含むため、prepare に新たな生成ツールは不要。

1. 親が最終 code image を registry へ配置し、manifest digest を確定する。code image を更新すると以後の固定値も更新が必要。
2. 隔離 source tree の Substrate Dockerfile で `COMPONENT=ateapi|atelet|ateom-gvisor`、同一 `CODE_IMAGE=repository@sha256:...` を使って 3 image を作る。AX Dockerfile も build する。worker 用 wrapper は新 binary path `/server` に対し `--atunnel-client-identity=spiffe://cluster.local/ns/ax-system/sa/ax-server` を保持する。旧 `/ko-app/ateom-gvisor` をそのまま指定しない。
3. 受付と有料 gateway は閉じたまま、既存 Actor 停止・割当 0・未解決実行なしを親が確認する。旧/新 worker が混在した状態で code を開始しない。worker に code の未完了 marker がある場合は通常 rollout で消さず、証拠を保って hold する。
4. control API、対象全 node の atelet、全共有 worker を同じ固定 code digest の版へそろえる。worker は単一 container/private PID namespace/PID1、既存 hostPath と runsc を保つ。code quota root/worker lock の永続先も既存 node BasePath の下で確認する。順序中は新規 work を受け付けず、全版の readback が揃うまで保留する。
5. AX に同一 `AX_CODE_IMAGE` と `AX_DISABLE_CREDENTIAL_ATESPACES` の `ax-code` を設定し、B の対応 controller と一緒に版を揃える。既存 ax-runtime 設定・鍵なし境界・mTLS identity を保つ。code の golden skip と template 完全一致、TaskSpec と常駐 command の区別を確認する。
6. 無課金で実 Actor の小 CSV/XLSX → 8 MiB 転送 → seal/start 一度 → manifest/chunk 回収 → deny/suspend →公開 cleanup を確認する。private PID1 / quota flags / bytes / inodes / owner / data 非継承と worker 未割当を観測する。GetActor の field12 を B decoder/PG evidence まで通し、未確認を resolved にしない。
7. 実 Actor の mount/setup/start/stop/unmount/worker急死・再起動の失敗系、SourceTag/Restore/golden拒否、通常 Runtime の snapshot と cleanup を確認する。停止 ACK 不明や孤児 marker で node 新規受付が閉じること、開始やモデルを再送しないことを確認してから一般受付を検討する。

direct runsc 再現は専用の空 OCI bundle と固定 binary を親が用意し、`AX_CODE_RUNSC_NODE` / `AX_CODE_RUNSC_BUNDLE` / `AX_CODE_RUNSC_PATH` を明示して `test_code_runtime_runsc_8m.py` を実行する。現在の owned bundle は削除済みなので、そのパスを再利用する前提ではない。全境界の旧 12 件は別 `test_code_runtime_runsc.py`、今回の新 8m/port80 4 件とは分けて数える。

## 残る条件と旧記録の扱い

本単位は実装・局所検証まで完了。実 Actor の host lifecycle、再起動時 hold、公開 code_cleanup の end-to-end、実 mTLS での最大 518 chunk（4 件の非整列 file、入力 259 + 出力 259）往復時間、実 cgroup 制限、通常 Runtime の実 Actor 回帰は未確認。依存更新や性能上限の引上げで未確認を解消したことにはしない。任意の Excel ブックが CPU 2 秒 / AS 256 MiB / wall 5 秒内に処理できる保証はない。

[ax-code-profile.md](ax-code-profile.md) は P1 の歴史的証拠として保持する。P1 の小 quota、runner 未実装、公開証拠なし、古い patch SHA の記載は P2 の現状を表さない。旧 Docker/host profile の上限と検証は保持し、8 MiB 用の別 profile/runner/proto が追加された。本書は親の配備許可や全体受け入れを代行しない。OKF と台帳の更新は親が担当する。


## 2026-10-08: 開始前拒否と停止再送の修正

親の実 Actor 試験 probe2 では、固定 code image 由来の `REQUESTS_CA_BUNDLE` が OCI に継承され、worker の ENV allowlist に無いため `ValidateBundle` が拒否した。code-start 前に停止しており、code は実行されなかった。当時は full OCI 検査の後に `Begin` を呼ぶ順序だったため、同世代の cleanup marker が無く、通常 `stopCode` で回収できなかった。`/server` という worker binary 名が原因ではない。

修正後は次の順序になる。

1. trusted request の atespace / 固定 runsc / CPU・memory / guest 1 件、および bundle overlay の固定 image digest を照合する。
2. actor UID / worker UID / worker 世代 / image digest / profile / bundle を束縛した `.pending` を耐久保存する。
3. full OCI の command / capabilities / ENV / mount shape を検査する。image が持つ `REQUESTS_CA_BUNDLE` だけを許可項目へ追加し、`GEMINI_API_KEY` / `AX_TASK_YAML` / `PYTHONPATH` などの未許可キーは拒否を維持する。
4. 検査失敗にも RunWorkload の cleanup defer が働き、同世代の runsc / process / mount / network を従来の順で回収する。不明な観測・失敗では pending を残す。
5. 同世代の `.done` が既にある Terminate は、runsc list 空 / private PID namespace の executable process 無 / bundle 配下の mount 無を読取だけで再観測する。再 delete / unmount / Complete は行わず、既存証拠を返す。marker 無し・他 worker・他世代は拒否する。

これは過去の markerless Actor を新しい世代へ取り込む API ではない。親が旧 probe2 を writer 停止、旧 worker の mount namespace/process 確認、正式 worker 退役で回収し、標準 reconciler による Actor CRASHED / assignment 無しを確認した。専用 PG の unknown と旧記録は保持し、通常 cleaned を捏造していない。この旧 Actor の実回収は親の観測であり、担当 A は live 操作をしていない。

| 修正確認 | 結果 |
| --- | --- |
| image ENV 回帰 | 修正前 `code_quota_worker_hold`、1 キー追加後成功。未許可 3 キーは拒否 |
| spec 拒否後の marker | 修正前 marker 不在で失敗、修正後は同 worker/世代の pending を保持 |
| done の再 Terminate | 修正前 Current 不在で失敗、修正後 2 回成功。世代変更後は拒否 |
| readback / unknown | runsc 取得失敗・残存 container・process・mount は全て拒否。readback は unmount しない。markerless は proof 無し |
| RunWorkload 検査失敗 | cleanup 観測へ進むこと、runsc 未確認時に pending を残し public proof を出さないことを確認 |
| 固定上流 prepare / verify | 成功。AX controller/substrate race と build、Substrate codeprofile/codequota/ocispec/atelet/control API race、Linux codequota/ateom tests、ateapi/atelet/ateom build。8 fixture 合計 44 top-level。最後の RunWorkload 回帰 1 件は同じ製品 source で追加局所実行 |
| 未作成 runsc root | 親が固定 binary を Actor 用ではないランダム新規 path の `test ! -e` 成功を前置して `list -quiet` を実測し exit 0 / stdout 0 bytes / stderr 0 bytes。A の unit fake とは別の証拠 |

現版 Substrate patch SHA は `7e7eb939a8f6fd62cb5f38c09c8e43879f8004d22100de4ee85c6ea29731654f`。ateom test fixture は `8aff76b4f09eed33fdca8086e9b8bdae2366dff91a42e023fa3b80d649eb57ce`、mount test fixture は `2a92d872b68c501c7858f2e7215b65a476847088b9d05fcd803e54a1d077259a`。本節が上の初回 Substrate patch SHA に優先する。AX patch、code Python/image、public proto、prepare/verify script はこの修正で変更していない。

局所ログは `/tmp/code-8m-start-cleanup-final.log`。親の空 root 観測は buildroot の `empty-runsc-absent.json` / `.stdout` / `.stderr`（`/tmp/ax-workbench-empty-e6a7d8bd91264902b109a2de55b35419` の不在確認付き）、旧回収観測は `probe2/host-after-retirement.txt` / `actor-after-retirement.json` に保存されたと報告を受けた。実 Actor での新開始・通常 cleanup、同世代停止再送は引き続き親の検証が必要。配備前の独立レビューを C へ依頼済み。


## 2026-10-08: 固定 code server の guest RPC 有効化

実 probe3 の worker log から定型 signal のみを集計し、workspace setup ready 1 件 / command 未指定 1 件 / setup failure 0 件を確認した。上流 AX `runner/runner.go` は Task 無しでも空 workspace を setup して readyz を返す一方、`internal/metadata/server.go` は `spec.debug` が true のときだけ guest ProcessService を登録する。前節以前の「Task YAML が無くても ProcessService を提供する」という起動契約には欠落があった。AX Task Ready は AX 自身が workerIP:80 又は router の HTTP readyz を観測した状態であり、mTLS ProcessService の到達性や code wait の準備完了とは別である。

固定 code image `c31da8…` を秘密なし・network none・read-only root・既存 5cap で起動して確認した。

- 元の argv だけでは readyz は 200、固定不存在 ID の `ProcessService.GetProcess` は Unimplemented。
- 固定 JSON を既存 runner の `--task-file` で渡すと readyz は 200、同じ read-only RPC は NotFound。ProcessService の登録を確認でき、Start RPC は送信していない。
- 両者の runner binary SHA は `89f1d9a3510a35741392d476b80c2256a599bbc2bcde6bc99c886602ba09b9c1`。Task 内モデル送信や未信頼 code 実行はない。

親承認の最小修正として `code_runtime/server-task.json` を image へ同梱する。内容は固定 apiVersion/kind、`metadata.name=ax-code-server`、`spec.debug=true` のみで、command/env/workspaces は含めない。これは guest server を有効化する image 内設定であり、run ID・所有権・認可・実行結果の正本には使わない。既存 Dockerfile の `COPY code_runtime/ /opt/ax-code/` が同梱するため、Dockerfile 自体の変更はない。

code ActorTemplate の command を `[/usr/local/bin/ax-task-runner,--task-file,/opt/ax-code/server-task.json]` に固定した。AX の生成、Substrate の template 完全一致、worker の OCI 完全一致が同じ argv を要求する。旧 argv、別 file path、余分な引数は拒否する。TaskSpec の `[python3,/opt/ax-code/runner.py,wait]`、template env 空、同世代停止、Go から wait 一回の契約は不変。通常 Runtime の template/binary は変えない。B が担当する Go validator と read-only ProcessService 観測も同じ契約へ更新する。

新 `test_code_runtime_server.py` は上の 2 経路を自動化し、固定 JSON の完全一致、AX_TASK_YAML env 無し、wait の ready.json 未作成も検査する。2 件成功、4.255 秒。元 Dockerfile の network-none build は wheel cache miss により依存取得不可で終了し、その未生成 tag を使った最初の test setup も失敗した。局所試験では既存 code image に固定 JSON だけを COPY した別 tag `ax-code-8m-r3:local`（identifier `sha256:c43662712d677c7ca6eebf166f7cfe95c0aaddd9f4aed509bb8329d72d1f79b6`）を作成した。この派生 image を正式再build済み image や registry digest と呼ばない。正式 Dockerfile の build / push / digest 確定は親が担当する。

AX/Substrate の template 回帰は修正前に新 argv が拒否される Red を確認した。最初の full verify は control API fixture に旧 argv が残り `TestCodeGoldenSkip` が失敗したため、fixture を新しい正規 command へ補正した。製品 validator を緩めて解消していない。補正後の `verify-code-runtime.sh` は成功した。8 fixture 合計 46 top-level、AX controller/substrate race/build、Substrate codeprofile/codequota/ocispec/atelet/control API race、Linux codequota/ateom tests、ateapi/atelet/ateom Linux build が成功。ログは `/tmp/code-server-patch-verify-final.log`、局所 image 試験は `/tmp/code-server-offline-test-final.log`。通常 template 不変の回帰も含む。

| 現成果物 | SHA-256 |
| --- | --- |
| code-runtime-ax.patch | `3c36bd4a8f72dcc10590357363b3cc43e5f66b191d14338fecdc7d6737a23ec2` |
| code-runtime-substrate.patch | `be45d8366b57159140ffaab06fed8eb9d223adbbba560ca513befb8d21dff4f3` |
| code_runtime/server-task.json | `383d1e70dfa457e6018a3c0c0f7be118121be95cb5915090a844e49a4c689ec8` |
| tests/test_code_runtime_server.py | `066cb7a47ff2ec98582deee4f82264fd1c72cceee61427be26fe1ac07d9a61d5` |

本節の 2 patch が前節までの SHA に優先する。新固定 command により image digest と template 内容が変わるため、旧 code Actor の同世代 cleanup を先に完了し、AX/Substrate/Go の固定 image を同時に揃える。親から旧 r2 Actor は同 worker で正式 cleanup、pending→done、停止、PG resolved/slot free を確認したと報告を受けた。A は live 操作をしていない。

局所再現は `AX_CODE_IMAGE=<既存ローカルの新code image> python3 -m unittest discover -s ax-local/tests -p test_code_runtime_server.py -v`。一時コンテナは終了時に削除する。旧 direct runsc の port80 検査も新 argv に追従したが、その実行は今回行っていない。新 image の実 Actor 起動、Go による固定 wait、stage/start/output/cleanup 全経路は親の次の検証であり、局所 RPC 成功に含めない。

親は正式 Dockerfile 由来の image でも `test_code_runtime_server.py` 2 件の成功と content hash の一致を確認し、buildroot の `code-task-file-content.json` に保存したと報告した。A の局所派生 image 試験とは区別する。r3 patch は固定済みで C の限定独立レビューへ渡した。
