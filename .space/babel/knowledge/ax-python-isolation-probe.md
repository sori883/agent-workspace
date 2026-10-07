---
governance: context
code_refs: 
  - ax-local/code_runtime/
  - ax-local/runner/Dockerfile.code
  - ax-local/tests/test_code_runtime*.py
  - ax-local/patches/code-runtime-substrate.patch
  - ax-local/patches/code-runtime-ax.patch
  - execution/native/code_cleanup.go
sources: 
  - resource: ax-local/code_runtime/README.md
  - resource: .space/tasks/ax-agent-workbench/python-spike.md
  - resource: .space/tasks/ax-agent-workbench/runsc-probe.md
  - resource: .space/tasks/ax-agent-workbench/host-quota-design.md
  - resource: .space/tasks/ax-agent-workbench/host-quota-review.md
  - resource: .space/tasks/ax-agent-workbench/evidence/actual-ax-fixtures.json
type: knowledge
title: 隔離Pythonの固定runsc試験とAX統合前の境界
description: Python試作で確認したchroot・syscall・host quotaと、固定runscの差異、実Actorでは未確認の統合条件
generated: 
  by: agent:codex
  at: 2026-10-07T17:42:52.669Z
---
# 隔離Pythonの試作で確認した境界

2026-10-07、CSV・Excelの集計用に、信頼した親launcherと未信頼Pythonの実行環境を分離する試作を行った。初期のDocker／direct runsc試作と、その後の実AX統合を分けて記録する。後半の「実AX統合」以外の初期試験だけを実Actorの合格とは扱わない。

## 子へ渡さないもの

親がchroot、UID/GID65532、補助groupなし、capability全消去、no-new-privileges、固定環境、FDの閉鎖を行い、信頼したbootstrapがsyscall allowlistを設定してから生成コードを開始する。子に/proc、親の制御RPC・state、秘密、外部ディレクトリFDを渡さない。network、fork/thread/exec、親process操作、mount、device作成、制限の再設定は拒否する。親の急死に備えたPDEATHSIGと親PIDの再確認を行う。

CPU/AS/FSIZE/FD/NPROC等の上限と親のwall/log監視を分ける。子の終了確認後だけ、指定名の通常file、link数1、UID、size/hashをdirfdとNOFOLLOWで回収する。成果物本文は認可・usage・費用・停止の証拠にはしない。上限値と入力JSON契約は `ax-local/code_runtime/README.md`、Dockerと局所試験の証拠は `.space/tasks/ax-agent-workbench/python-spike.md` にある。初期試作の入力総量4KiBは旧profileの制限である。後続の8MiB用profileと搬送は下記の実AX統合で追加した。

## 固定runscの差異

Substrate固定版で配布されたrunsc `release-20260824.0-120-g727c8c389c36-dirty` の内部tmpfsは、nr_inodes=32を指定しても64空fileを作成できた。launcherは正確なinode数の不一致でコード開始前に拒否した。内部tmpfsの検査を外す案は採らない。

信頼側のLinux tmpfsをbindした場合は、32inodeの領域で31file、1MiBの領域で1,048,576bytesの後にENOSPCとなった。guestでは9p、nosuid/noexecが見え、nodev表示は出ない。専用host-quota-v1は固定argvのみで選び、親stateを含む4mountの種別・bytes/inodes・UID/GID/mode・空状態を照合する。信頼側は実mountのnosuid/nodev/noexecとquotaを検査する。nodev上のdevice open拒否と子のmknod拒否は別々に実測した。既存Docker用のtmpfs/nodev必須条件は維持する。

同じ固定runscのOCI linux.seccomp指定では拒否の試験注入が効かなかった。生成コード用filterはguest内で明示設定し、敵対操作の拒否を実測している。設定失敗の試験では信頼guest driverがseccompとprctl(PR_SET_SECCOMP)を事前拒否し、未実行停止を確認した。OCIの指定だけを実効性の証拠にしない。

## 確認範囲と後続

direct runscでCSV/XLSXと隔離契約12件が成功した。試験harnessの通信timeoutはnode側処理を止めた証明にならないため、旧process・mountを保全して後続開始を拒否する。実runscのtimeoutと、応答終了後にmountが完成する遅延試験でこの条件を確認した。手動の終了確認後に通常unmountし、診断bundleを回収した。記録は `.space/tasks/ax-agent-workbench/runsc-probe.md` と `host-quota-review.md` にある。

試験は --ignore-cgroups を使った。RLIMITの成功をworkerのcgroup/メモリ課金の証明としない。AXへ組み込む場合は固定registry digestとtemplate/argvの一致、信頼側mount、cold start専用化、golden/restore拒否、worker全体の新規受付停止を伴うcleanup失敗の扱いが必要。ateletはRunの先頭でresetActorDirsし、TerminateのNotFoundを成功扱いするため、これらの前に旧状態の保全と世代照合が必要になる。COLD_BOOTだけではgolden snapshotを回避できない。詳細は `host-quota-design.md`。この初期調査後、patchと8MiB搬送を次節の範囲で統合した。worker急死・cgroup等の未検証条件を、その成功から推定しない。

## 実AX統合（2026-10-08）

code image `sha256:8485abc6e29320c34a68e0bc79b3db21c01feecf10cc87b0d1ddbc3b27ef1642` と `host-quota-8m-v1` を固定したAX/Substrate経路で、CSV/XLSX集計、単一8MiB、4file合計8MiB、子の隔離境界を確認した。Runtime→code→RuntimeはPGの同じ実行枠を順番に使う。全ケースでTask/Actor停止・通信deny・worker未割当と、actor UID/worker UID/worker世代/image/profileが一致するserver-owned cleanupを読み戻した。

codeはcold-onlyとし、golden/restoreを使わない。信頼側host tmpfsを4領域に分け、入力8,404,992、出力8,400,896、一時8MiB、state256KiBの物理上限を与える。論理入出力合計8MiBとの差はファイル端数のページ分だけで、生成コードの予算を拡大するものではない。固定Task設定で制御RPCを登録し、Goが保存した一回の開始権でtrusted waitと子開始を進める。HTTPのreadinessを直接mTLSサービス到達の証拠に代えない。

実AXのrootfsは0700で、親が一時的にUID65532へ切り替えて絶対pathを辿る方法は失敗した。root modeやcapを増やさず、親が検証した `/sandbox` のdirfdを開いてからUIDを切り替え、相対openatと所有・mode・stat/hash照合を行う。FDは子へ渡さず確実に閉じる。root0700のRed→Green局所回帰、正式image内source一致、実Actor成功が対応する。

境界試験では子UID/GID、環境・FD・readonly、network/process/control操作の拒否と元入力不変を確認した。cap0/no-new-privilegesの保証は信頼bootstrapの検査に依存する。局所/direct runscの資源超過、symlink、親急死の試験は再利用し、実Actorでの全障害注入、worker急死、cgroup課金までは確認していない。結果不明時の再Start/再Resume、marker強制削除、証拠のないcleanup確定は認めない。詳細と版付き抜粋は `.space/tasks/ax-agent-workbench/evidence/actual-ax-fixtures.json` と `workbench-runtime-review.md`。

# Related Concepts
- [AX Task内の対話型ランタイムと外部の制御基盤](../decisions/systems/ax/agent-runtime.md): AX内Runtimeから未信頼コードを分離するための実測と統合前提
