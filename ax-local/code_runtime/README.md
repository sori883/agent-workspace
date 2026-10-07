# 隔離 Python code runtime

`runner.py` は、固定 code Task に入力ファイルを搬送し、未信頼 Python を一度だけ実行して成果物を回収する。現行の統合用 profile は `host-quota-8m-v1`。Docker と固定 runsc の局所試験は成功しているが、AX の実 Actor 経路は未確認。対象版・結果・配備前条件は [code-8m-verification.md](../../.space/tasks/ax-agent-workbench/code-8m-verification.md) にまとめる。

## 信頼境界

信頼された親は staging、開始記録、子の監視、出力封印を担う。子は専用 chroot、UID/GID 65532、空の補助 group、全 capability set 0、`no_new_privs=1`、固定環境、FD 0–2 で実行される。親終了時には子を SIGKILL する。libs と入力は root 所有で子から書込み不可。chroot に `/proc`、制御 socket、外部 directory FD は置かない。

`bootstrap.py` は制限を再検査し、seccomp の設定に成功した場合だけコードを実行する。許可 syscall 以外は EPERM。socket、fork/clone/thread、exec、親への signal/ptrace/process_vm/pidfd、mknod/mknodat、mount/namespace、io_uring、制限の再設定を拒否する。Python の module 制限は隔離境界にしない。

親は子を wait してから成果物を回収し、宣言名、通常ファイル、link 数 1、UID、サイズ、dirfd、NOFOLLOW を照合する。封印後は read-only の manifest/chunk 操作で返す。コード、stdout/stderr、ファイル内容は未信頼データであり、認可、モデル費用、AX の実停止証拠には使わない。

## 8 MiB profile

| 項目 | 固定条件 |
| --- | --- |
| 入力 | 最大 4 件、論理合計 8,388,608 bytes、子には `/input/<alias>` |
| source | UTF-8 最大 4,096 bytes、入力上限とは別枠の `/input/main.py` |
| 出力 | 最大 4 件、宣言上限の合計 8,388,608 bytes、`/output/<name>` |
| 出力名 | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,58}\.(csv\|xlsx)$` に相当する CSV/XLSX basename、最大 64 ASCII 文字 |
| 子 | CPU 2 秒、AS 256 MiB、FSIZE 8 MiB、FD 32、NPROC 1、CORE 0、STACK 8 MiB |
| 親の監視 | wall は 5 秒と区間残時間の小さい方、stdout/stderr 合計 8,192 bytes |
| 親 capability | ALL を drop し `KILL,SYS_CHROOT,SETUID,SETGID,SETPCAP` のみ |
| ライブラリ | 固定 Python/stdlib、openpyxl 3.1.5、defusedxml 0.7.1、et-xmlfile 2.0.0。動的導入なし |

物理 quota にはファイル末尾のページ端数を含める。論理入力・出力の上限を増やすものではない。

| host tmpfs → guest mount | bytes | inodes | UID:GID | mode |
| --- | ---: | ---: | --- | --- |
| input → `/sandbox/input` | 8,404,992 | 16 | 0:0 | 0755 |
| tmp → `/sandbox/tmp` | 8,388,608 | 128 | 65532:65532 | 0700 |
| output → `/sandbox/output` | 8,400,896 | 32 | 65532:65532 | 0700 |
| state → `/var/lib/ax-code` | 262,144 | 32 | 0:0 | 0700 |

入力 quota は 8 MiB + source 4 KiB + 4 ファイルのページ端数最大 12 KiB。出力 quota は 8 MiB + 最大 12 KiB。信頼側が host tmpfs を `nodev,nosuid,noexec` で作り、固定 runsc へ bind する。runner は全 4 mount の `9p`、nosuid/noexec、正確な容量・inode・所有者・mode・初期空状態を検査する。固定 runsc の guest mountinfo には nodev が表示されないため、nodev は信頼側の作成・検査を必要とする。guest の mknod/mknodat 拒否は維持する。

## 起動と RPC

AX TaskSpec command は `python3 /opt/ax-code/runner.py wait`。ActorTemplate command は `/usr/local/bin/ax-task-runner --task-file /opt/ax-code/server-task.json`。image 内の固定 JSON は `spec.debug: true` だけを有効化し、guest ProcessService と readyz を提供する。固定 JSON には command/env/workspaces を入れず、run の認可・所有者・実行状態の正本にも使わない。code template の環境は空なので、TaskSpec command は環境変数から自動起動されない。controller が Resume intent 内で AX Resume 後に固定 wait process を一度だけ開始する。起動 ACK が不明なら再送しない。

wait は全待機時間の独自タイマーを持たず、ProcessService の区間 timeout（最大 300 秒）に依存する。stage 後は `remaining_ms` から monotonic 経過時間を差し引き、期限後の code-start と子実行を拒否する。wait の ready 記録が無い RPC は拒否する。status は起動を行わない。

操作は `python3 /opt/ax-code/runner.py OP BASE64_JSON` の固定 argv。JSON は重複キー、未知 field、不正な整数・サイズ・SHA・base64 を拒否する。要求・応答は最大 64 KiB、ファイル chunk は最大 32 KiB。

| OP | 要求 | 結果 / 再送 |
| --- | --- | --- |
| `stage-begin` | `{request,workbench}` | `{run_id,state:"staged"}`。同一 envelope は再読取り可 |
| `stage-chunk` | `{run_id,descriptor_sha256,alias,index,content_base64,sha256}` | staged。同じ chunk の再送は seal 前だけ可。異なる内容・順序は拒否 |
| `stage-seal` | `{run_id,descriptor_sha256}` | sealed。全ファイルの size/SHA を検査して read-only 化。同一再送可 |
| `code-start` | 同上 | started。一度だけ開始記録を作成。再送不可 |
| `code-status` | 同上 | `{run_id,state,attempted,result}`。waiting/staged/started/running/finished |
| `code-collect` | 同上 | `{result,artifact_base64:null}` |
| `output-manifest` | 同上 | `{run_id,descriptor_sha256,outputs,manifest_sha256}` |
| `output-chunk` | `{run_id,manifest_sha256,alias,index}` | `{run_id,alias,index,content_base64,sha256}` |

成果物 manifest は descriptor の出力順を保つ。manifest SHA は `manifest_sha256` 自身を除く sorted-key UTF-8 JSON の SHA-256。入力は file ID/alias/size/SHA、出力は alias/name/size/SHA に束縛する。JSON に大きいファイルの bytes を直接入れない。

code result は schema_version/run_id/adapter/status/exit_code/error_type/summary/usage/estimated_usd の 9 field。adapter は python、usage は 5 field の 0、estimated_usd は 0。これはモデルを呼ばない code 区間の値で、root の累積予算をリセットしない。summary は最大 8,192 UTF-8 bytes、signal 終了は非負の `128+signal` に正規化する。親 process 死亡で結果不明なら成功とは扱わない。

## 検証と旧 profile

```sh
docker build -f ax-local/runner/Dockerfile.code -t ax-code-8m:local ax-local
AX_CODE_IMAGE=ax-code-8m:local python3 -m unittest discover -s ax-local/tests -p 'test_code_runtime_8m.py' -v
AX_CODE_IMAGE=ax-code-8m:local python3 -m unittest discover -s ax-local/tests -p 'test_code_runtime_server.py' -v
CODE_TEST_IMAGE=ax-code-8m:local ax-local/patches/verify-code-runtime.sh
```

build のみ固定 SHA の wheel を取得する。Docker 実行試験は network none。8 MiB の Docker harness は guest の mountinfo 名だけを 9p として模擬するため、host bind の証拠には数えない。実際の 9p、quota、nodev、32 KiB 往復は専用の固定 runsc 試験で別に確認した。

`launcher.py` の引数なし / `--profile docker-tmpfs-v1` と `--profile host-quota-v1` は旧試作契約を保持する。入力は合計 4,096 bytes、成果物は合計 65,536 bytes、inline JSON は 32 KiB。`launcher.py --profile host-quota-8m-v1` に小プロトコルを流すことは拒否し、8 MiB は上記 runner RPC だけを使う。環境変数から profile は選ばず、未知の argv は拒否する。

旧 Docker / host profile の 12 境界試験は [python-spike.md](../../.space/tasks/ax-agent-workbench/python-spike.md) と [runsc-probe.md](../../.space/tasks/ax-agent-workbench/runsc-probe.md) にある。旧 image の成功を新 image や実 Actor の合格へ読み替えない。

## AX 配備前に残る条件

[host-quota-design.md](../../.space/tasks/ax-agent-workbench/host-quota-design.md) と [code-8m-verification.md](../../.space/tasks/ax-agent-workbench/code-8m-verification.md) の順序で確認する。実 Actor の cold start、private PID 1 worker、stop→process 不在→通常 unmount→durable marker→公開 code_cleanup、worker 障害時の node 受付 hold は未確認。公開証拠は Substrate の信頼側が生成し、guest の result から代用しない。SYS_ADMIN/NET_ADMIN の guest 追加や quota 検査の緩和で通過させない。
