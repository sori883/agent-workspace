# Python 隔離試作の独立レビュー

2026-10-07、担当 `w1_design_review`。基点 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、共有 branch `codex/agent-workbench` の未コミット差分を確認した。製品実装に参加していない別担当によるレビューであり、同じモデルを使っている。異モデル検証ではない。編集はこの報告のみ。live DB・AX・Kubernetes・モデルの操作は行っていない。

## 判定

Docker 局所試作として、最終版に残る確定した必須コード修正はない。発見したログ超過の P2 は修正と局所回帰で解消した。ただし、**固定 runsc の mount 条件が成立しておらず、任意 Python を実 AX で開放できるという判定ではない**。親の独立 OCI probe では現在の launcher が `unsafe_mount` で拒否しており、チェックを緩めて先へ進めるべきではない。

## 対象と根拠

`ax-local/code_runtime/{launcher,security,bootstrap,build_sandbox}.py`、固定依存、seccomp 失敗注入設定、`runner/Dockerfile.code` と専用 dockerignore、`tests/test_code_runtime*.py`、[試作報告](python-spike.md)、code_runtime README を読んだ。既存の [隔離調査](isolation-investigation.md) を再利用し、上流全体の再監査はしていない。

devlow の全体フロー・review、interrogate のレビュー担当指示を適用。use-principles と OKF の先行検索を引き継ぎ、code_runtime のパス検索を行った。費用規則、境界の明示、実経路による検証、既存 AX の制御 RPC・通信・資源制限の条件を照合した。既存のモデル上限や未回答の追加予算を変更・承認した扱いにはしない。

## 指摘と解消

### PY1 / P2：終了済み子の残りログを上限超過の失敗にしない

初回 `launcher.py` の `watch()` は、ログが 8,192 bytes を超えた場合の `reason = log_limit` と kill を共に `status is None` へ従属させていた。子が先に正常終了し、その後 pipe を読み切る間に上限を超えると、保存ログは上限内に切り詰めるものの実行を成功扱いできた。仕様はログ超過を実行失敗とするため、正常結果が誤って採用される。

担当 A が修正前の `None != log_limit` を確認し、最終 `launcher.py:177` 付近では reason 設定を生存状態から分離、kill だけを生存時に限定した。`test_code_runtime_watch.py` は waitpid 済みの子と残り 8,193 bytes を再現し、失敗理由、保存上限、終了済み PID への kill がないことを確認する。担当自身もこの局所試験を実行し 1 件成功。**解消済み**。

## 静的に確認した境界

| 境界 | 確認結果 |
| --- | --- |
| 子の権限 | `security.py:57` で補助 group、real/effective/saved UID/GID、effective/permitted/inheritable/bounding/ambient capability、no_new_privs を設定・再検査する。生成コードが動く前に全 capability set が 0 になる構造。親へ SYS_ADMIN/NET_ADMIN を足していない。 |
| 親・RPC・秘密 | `launcher.py:110` で stdin を `/dev/null` とし、外部 FD を閉じて chroot。固定環境で trusted bootstrap へ exec する。bootstrap は seccomp 成功後だけ準備完了を通知し、その FD を閉じてから生成コードを実行する。chroot に `/proc`、親状態、外部 directory FD、資格情報を渡していない。 |
| syscall 制約 | `security.py:95` の allowlist 外は拒否する。socket、fork/clone/thread、exec、親への signal/ptrace/process_vm/pidfd、mount/namespace、io_uring、prctl/seccomp と制限変更を許可しない。fcntl/ioctl は特定操作だけ。Python の module 制限に依存せず、生成コードがモジュール変数を書き換えても kernel 設定を解除する経路を許可しない構成。 |
| 失敗時 | mount/capability/環境/seccomp を満たさなければ生成コードより前に拒否する。PDEATHSIG を UID 変更後に設定し、親 PID も確認する。親監視は wall/log の超過を失敗にし、子を wait した後だけ回収する。 |
| 成果物 | `launcher.py:199` の collect は固定名、通常ファイル、link 数 1、UID、サイズ、dirfd、NOFOLLOW と open 後の inode 等を照合する。成果物の本文・ログは未信頼であり、認可・費用・usage・Actor 停止証明にはしない。 |
| 資源 | rlimit に加え外側 profile が必要。子の書込み先は容量・inode 上限付き tmpfs とし、CPU/AS/FSIZE/FD/NPROC/wall/log/回収総量を別々に制限する。4 KiB 入力・64 KiB 出力の試作であり、製品 upload の 8 MiB 搬送を実装したものではない。 |

これらはコードと対応する試験内容の照合であり、全ての hostile code や kernel 脆弱性に対する安全性証明ではない。

## 検証の主体と版

担当 A の報告は Docker 隔離 11 件と終了済み子ログの局所 1 件、合計 12 件成功。最終 image は `sha256:3eb6cf476341e3b948854567f43c762631f8097662f81ec42da0193934141e69`。CSV/XLSX、通信・親操作・プロセス生成拒否、設定失敗、資源超過、成果物の symlink/hardlink 拒否、親急死を試験ソースと照合した。Docker 11 件は本レビュー担当自身の再実行ではない。

担当自身は `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ax-local/tests -p 'test_code_runtime_watch.py' -v` を実行し、1 件成功した。これは mock を使う局所回帰であり、コンテナ隔離の実証には数えない。

最終 source と A の版記録の hash 一致を確認した。

- launcher: `b8fac0eeca8fd9d048a071007c4b7f9fa153cedac5b3cc66c90bb553a1328dd1`
- security: `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255`
- 対象 source/tests 一式: `577ba4270195efe3104d8bfef3bb6846cd18e9248ec9c0f1221b35ab5105ae8c`。試作報告の path/NUL/bytes/NUL の方法で再計算した。

## 実 Actor へ進む前の残件

親からの固定 runsc `release-20260824.0-120-g727c8c389c36-dirty` の独立 OCI probe 報告では、旧試作 image `9a644079…` は `setup_failed / unsafe_mount` で拒否した。tmpfs size/uid/mode は適用されたが、nr_inodes 指定 16/128/32 に対し statvfs の f_files は全て 1,003,178、mountinfo に nosuid/noexec はあるが nodev 表示がなかった。これは本担当の実行ではなく親の観測であり、AX Actor でもない。inode の実効上限を確かめる固定診断は親が実行中で、現時点では結果を先取りしない。最終ログ修正は mount 検査を変えていない。

必須条件は、固定 runsc で総書込み量・inode と device 条件を成立させること、固定 OCI/AX template の厳密照合、親 RPC を維持しつつ子から loopback 制御 RPC・外部通信・親状態へ届かない実 Actor 確認、実停止・worker 未割当までの確認である。Docker の network none と局所 syscall 拒否だけでこの段階を済ませた扱いにはしない。

同時枠 1 の Runtime→code Task→Runtime は各 Actor の実停止を挟む。開始/入力 ACK 不明で新 process を再送しないこと、封印した file の chunk 搬送、PG の操作台帳、成果物の外部確定、累積予算/時間/権限の再検査は未接続である。これらは現 standalone 試作の隠れた完成条件ではなく、任意 Python の製品開放前に別途満たす統合条件として引き継ぐ。

知識は本報告にのみ保存した。OKF 更新、稼働環境の変更、全体の受け入れは親の担当範囲である。
