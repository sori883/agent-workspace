# Code 経路の実 Actor 追加確認

2026-10-08、担当 A。読み取りと手順整理のみ。実行・配備・課金は親が単一実行で担当する。旧 direct runsc 12 件と P2 の 8 MiB/port80 4 件を再利用し、実 Actor の配線・権限・回収へ必要な追加確認に絞る。現時点で下記を成功扱いにしない。

## 対象版と再利用する証拠

`/tmp/ax-workbench-build.json` を読み取った時点の code は `localhost:5001/ax-code-runner@sha256:c31da8b762c16fef7085bb17c3593f428cc3de2d667db821ac170ff7f176cafb`、Runtime は `localhost:5001/ax-task-runner@sha256:fa9f1b4e42ac06963552f0ddb4a4c49a41e5e46739c2bbd26508d959220dd52d`。AX/ateapi/atelet/worker/probe の版は実行直前に同 JSON と配置の readback を照合して記録する。後の rebuild をこの版の実測に混ぜない。

- [runsc-probe.md](runsc-probe.md)：socket/process/親アクセス拒否、FD/env/cap、readonly、CPU/AS/wall/log、inode、setup失敗、親急死を含む旧 12 件。実 Actor の証明ではない。
- [code-8m-verification.md](code-8m-verification.md)：新 profile の RPC、4 file ページ端数、8 MiB 入出力、CSV/openpyxl、5cap port80、公開 cleanup の局所 Go 試験。直接 runsc は `--ignore-cgroups` のため Actor の cgroup や mTLS 経路は未確認。
- `bootstrap.py` と `security.py` は旧試験から不変。最終 code image の runner の追加変更は definition/history validator。旧全 12 件を理由なくそのまま反復せず、以下で配備差と実 cleanup を確認する。

## 実行前と共通の合格条件

- [ ] 通常受付と paid gateway は閉鎖。前の root は成功/失敗を保ち、開始不明・cleanup 不明が無いことを確認する。同じ run の start/resume を再送しない。最初の csv-xlsx は Runtime 停止/deny・code未開始までを親から受領したが、code の合格には数えない。
- [ ] 新しい専用 schema/専用 role、preview、固定 scenario/source/hash、`python_enabled=true`、`code_profile=host-quota-8m-v1`、runtime/code の完全な image reference が一致する。既存固定 probe が持たないケースは、別の固定 fixture を準備・レビューしてから実行し、汎用 source 引数や PG の記録書換えで gate を迂回しない。
- [ ] code template は空 env、常駐 ax-task-runner、5cap、cold-only/golden skip。TaskSpec wait と code-start は別操作で各一回。host worker は private PID namespace の PID 1、SPIFFE identity と read-only config の配置を照合する。実行中の診断 exec は cleanup 前に終了させる。残存診断 process は停止判定を保守的に hold させるため、並行監視で false hold を作らない。

すべてのケースで root/run/actor UID/worker UID、image/profile、操作 intent 数、結果コード、成果物 manifest/hash、usage/外部送信 0、経過時間を残す。子の自己申告だけで隔離や停止を証明しない。失敗ケースも後述の cleanup 条件を満たすまで次へ進まない。

## 小さい追加チェックリスト

| 順序 | 固定ケース / 観測 | 実 Actor で必要な合格条件 |
| --- | --- | --- |
| 1 | **csv-xlsx 正常経路**。Runtime→code→Runtime。CSV=300 / XLSX=30、成果物2件 | mTLS の wait開始→stage→seal→code-start→collect が届き、code未停止のまま次Runtimeを起動しない。PG保存したbytes/hashと再取得したCSV/XLSXの値が一致。codeのpublic cleanupを後述の方法で照合 |
| 2 | **配備された子の境界**。成功する1つの小さい固定 Python で socket(AF_INET/AF_INET6 TCP、UDP、AF_UNIX)作成、fork/thread/exec、親signal/ptrace/process_vm、mknod/mknodat、setuid/mountを一回ずつ試し、すべて拒否を確認。input/env/FD/state境界も同じケースへまとめる | UID/GID65532、子cap全0/NNP/seccompはtrusted側の設定・読み取りと対応。FD3以上・親env・`/proc`・`/var/lib/ax-code`・`/opt/ax-code` は子へ渡らず、input/libsへ書けない。socket自体のEPERMによりloopback:80のProcessService、外部HTTP、Unix socketへ送信する前に止まる。実接続や秘密値の読み取りを成功条件にしない |
| 3 | **copy-8m-4**。4入力サイズ 1,048,577 / 2,097,155 / 3,145,733 / 2,097,143 bytes をそのまま4出力へコピー | 論理合計各8,388,608 bytes、全file hashが一致。各33/65/97/64＝259 chunk、入出力518 chunkをmTLSで完了し、全区間予算内。host input=8,404,992 / output=8,400,896 bytes の物理余裕12KiBを確認。1fileの512 chunk成功で代用しない |
| 4 | **資源拒否が結果・cleanupへ伝わる経路**。下表の短い固定 source を別runで使用 | 子の失敗/timeoutを成果物成功へ変換しない。summary<=8192B、usage0、開始一度、deny/停止/host cleanupが完了。CPU制限やAS上限を緩めて通さない |
| 5 | **出力回収の拒否**。宣言CSV名をsymlinkにする代表1件 | symlinkのtarget bytesがsealed出力やPGへ採用されず、失敗としてcleanup。既存のhardlink/directory等の単体/直接runsc試験は再利用する |
| 6 | **cold分離と通常Runtime互換**。成功codeの停止後、新runで同一aliasを別内容にして実行。既存Runtimeの通常再開/停止も1件 | code開始時のtmp/output/親stateが空、前Actorのbytes/開始記録を継承しない。codeにgolden/SourceTag/Restoreを使わず、通常Runtimeのsnapshot経路は従来どおり動く |

資源ケースは CPU 2秒 / AS256MiB / FSIZE8MiB / FD32 / wall5秒のまま実施する。親の 300秒区間上限は別物。

| ケース | 固定入力の例 | 期待する観測 |
| --- | --- | --- |
| wall | `time.sleep(30)` | 5秒前後で親が停止し `timed_out`、成功成果物なし。wall値はコード区間の測定に分ける |
| CPU | `while True: pass` | CPU上限による非負signal終了値、失敗、worker/nodeを巻き込まない |
| AS / FD / inode / filesystem | 既存 `test_code_runtime.py` の拒否を捕捉するケースを8m値へ固定 | 大きい確保は失敗、FDはEMFILE、tmp/output容量・inodeはENOSPC。物理余裕のあるoutputで1 file 8 MiB超を試す場合はEFBIG。限界までに作った試験filesは子が消し、小さい結果CSVだけ出す。旧FSIZE65536の期待値を8m経路へ流用しない |
| log | 上限をわずかに超える固定stdout | log_limitで失敗、保存summary<=8192B。無制限に出し続ける試験でログを膨らませない |

## 各 run で確認する cleanup

- [ ] AX Task の Suspended だけで合格にせず、Substrate Actor が SUSPENDED、worker assignment null、egress deny を独立読取りで確認する。
- [ ] `ActorStatus.code_cleanup` field12 の actor_uid / worker_uid / generation(UUID) / image_digest / profile / cleaned=true が現在runと一致し、PGのcleanup evidenceへ反映されたことを確認する。index `c31da8b7…` は上流imagecacheが要求digestとして保持するため、child manifestへ勝手に置き換えない。
- [ ] 対象workerのrunsc guest/pause状態と残存processなし、対象quota/bundle mountなしを確認する。`.done` と `.pending` 消滅の対応を読む。guestの結果JSON、メモリ上のworker空き、Terminate NotFoundだけで代用しない。通常unmount完了が不明ならmarkerを消さずholdを保つ。
- [ ] 成功・確定失敗の双方で上記が確認できた後だけ、親が次の単一probeへ進む。既存 public の内容と通常実行枠を変更しない。

## 通常成功確認と分ける障害注入

共有workerを突然止める試験は上のケースへ混ぜない。専用の短命試験対象と復旧手順を親が決めてから、**trusted wait親急死の子停止**と、**host unmount失敗/worker世代喪失時のnode hold**を各1条件で確認する。既存direct runscのPDEATHSIG試験とGo fakeの順序試験を再利用するが、実worker経路の合格とはしない。

期待値は「公開cleaned証拠を生成しない・marker保全・全新規workload（通常/golden含む）をnode単位で拒否・自動takeover/再startなし」。同nodeの正常な生存worker markerを孤児扱いしない。安全に注入できない場合は未確認として記録し、手動marker削除やlazy unmountで合格へ変更しない。setup/seccomp失敗の全組合せは既存直接試験を再利用し、実配備に変更した境界だけ追加確認する。

この文書はチェック項目と期待値であり、実施結果ではない。現在のcsv-xlsx seq1後停止の原因修正と、新schemaでの再確認は親/Bの作業として分離する。
