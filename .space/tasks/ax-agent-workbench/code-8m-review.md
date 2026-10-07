# 8 MiB code runtime・基盤 patch 独立レビュー

2026-10-07、担当 C。基準 `ede929e`、branch `codex/agent-workbench` の `ax-local/code_runtime/`、8 MiB/RPC 試験、`code-runtime-{ax,substrate}.patch` と対応する固定上流試験を確認した。製品コードの編集、稼働 AX/DB/ネットワーク操作、課金、commit/PR は行っていない。

## 判定

コード読取りで見つけた **C1/C2 は作者 A の修正を再確認し解消**。最終ソースと作者検証記録も照合し、追加の必須指摘はない。次の実 Actor 結合検証へ渡せる。実 Actor の隔離・quota lifecycle・field 12 の一連の伝播は、局所試験だけでは確認済みにしない。

## 指摘と修正

| ID | 重大度・到達条件・影響 | 修正と確認 |
| --- | --- | --- |
| C1 | P2。`runner.py:141–147` の旧検証が manifest の先頭を agent 固定としていた。単独 skill を選んだ root が Python 段へ進むと、正当な descriptor を拒否して hold する | agent 省略可、agent は先頭最大 1、skills 最大 8 へ統一。A が `invalid_request` の Red→Green を確認。C も対応コードと局所 ContractTests を確認した |
| C2 | P2。`runner.py:162` の旧上限が history 9 件だった。確定契約は本人の発言を含め 17 件なので、会話を継続した正当な code Task を拒否する | 17 件かつ canonical JSON 16 KiB、各本文 8 KiB へ統一。18 件・制御文字 escape 後の容量超過も拒否する回帰を確認。A の Red→Green と C の局所試験成功を区別して記録する |

Go 側も同じ skills/history 条件へ追従したことを、[execution レビュー](workbench-execution-review.md)で確認した。

## 境界の確認

- **搬送・封印**: descriptor の版・root/run・SHA・固定 profile、alias と file ID、件数 4・合計 8 MiB、source 4 KiB、宣言 output を検査する。chunk は 32 KiB、canonical base64、index 順、期待長・個別 SHA を検証し、既存 chunk は同内容だけ再生する。seal は全件の bytes/hash を確認して read-only にし、以後の入力追加を拒否する。
- **開始一回**: root 所有 state、flock、排他的 stage/start/attempted 記録を使う。Start は seal・生存中の trusted waiter・残時間を要求し、二度目の Start を拒否する。部分保存やプロセス喪失を安全な再実行へ置き換えない。固定コマンドの起動と ACK 不明時の扱いは Go の Resume intent と合わせて確認した。
- **信頼側回収**: 子の終了を wait してから、宣言名との完全一致、通常ファイル、UID、link 数 1、NOFOLLOW、inode/size、総量・SHA を照合する。出力順序を宣言へ戻し、immutable な manifest と read-only の出力を公開する。summary は限定長の未信頼ログであり、モデル usage は固定 0。最終停止証拠は guest result から作らない。
- **隔離**: 非 root UID/GID、補助 group なし、全 capability set 0、no_new_privs、chroot、固定環境、外部 FD 除去、seccomp allowlist、CPU/AS/FSIZE/FD/壁時計/ログの制限を維持する。8 MiB 対応で `security.py` を緩めていない。socket・プロセス増殖・親操作・mount 等の拒否は、以前の固定 runsc 試作の確認範囲を引き継ぐ。
- **host quota と端数**: 論理 input/output 上限は各 8 MiB。host input は 8 MiB＋16 KiB（4 入力のページ端数と source）、output は 8 MiB＋12 KiB（4 出力の端数）、tmp は 8 MiB、state は 256 KiB。inode/UID/GID/mode と実容量を host と guest で照合し、余白を論理ファイル上限へ加算しない。guest 側に nodev 表示がない点は host mount 検査で扱い、実効確認と表示を混同しない。
- **cold start・停止**: 固定 image/command/resources/caps、鍵・任意 env・追加 volume 禁止、golden/source tag/Restore/再 Resume 拒否を維持する。pending 記録を mount 前に保存し、runsc delete・list 空・残存 executable 不在・通常 unmount・mount 不在・durable done の順を完了条件にする。どこかの不明/失敗で pending と回復資料を残し、worker 再起動や未知世代による再利用を拒否する。
- **server-owned 証拠**: worker の durable completion から actor UID / worker UID / UUID generation / image digest / profile / cleaned を作り、ateom→atelet→control API が同一 actor と割当 worker を検証して ActorStatus field 12 に保存する。NotFound や SUSPENDED だけで証拠を代用しない。Go は current Actor UID、停止・未割当、digest/profile、bounded decode を照合する。

## 版・検証・限界

C が直接実行したのは `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=ax-local/tests python3 -m unittest test_code_runtime_rpc.ContractTests -v` の 5 件で、全件成功した。host mount、実 Actor、Docker/runsc の再実行はしていない。

[A の最終検証記録](code-8m-verification.md)の製品 11 ファイルについて、掲載 SHA256 と現在ファイルの一致を C が照合した。A の `/tmp/code-8m-runsc-final.log` は 4 件/54.326 秒、`rpc-reviewed.log` は 11 件/0.137 秒、`integrated-reviewed.log` は単独 skill＋history 17 の CSV/XLSX 1 件/0.952 秒で成功しており、本文の件数・結果と一致する。これらの Docker/runsc の実測者は A である。

最終ローカル image identifier は作者記録で `sha256:c31da8b762c16fef7085bb17c3593f428cc3de2d667db821ac170ff7f176cafb`。固定 runsc 4 件を実行した image は validator 修正前の版で、修正後は manifest/history 検証だけを変更し、最終 image の製品 SHA を作者が照合している。C は最終 image を起動していない。image identifier と配備用 manifest digest を混同せず、最終版の実 Actor 試験を残す記録は妥当である。差分の whitespace check も成功した。

親は最終 source SHA と image identifier を照合して registry へ push し、配備用参照を `localhost:5001/ax-code-runner@sha256:c31da8b762c16fef7085bb17c3593f428cc3de2d667db821ac170ff7f176cafb` と確定した旨を受領した。この registry 操作・readback の実施者は親であり、C の独立実測には数えない。以後の AX/Substrate/controller 設定はこの固定参照と整合させ、実 Actor 試験結果は別途記録する。

確認した主要 source SHA256:

- `runner.py`: `a0aa485c64e8068eedf89ad3b4829643063d44db09fde211fb44b1f9e51c218b`
- `launcher.py`: `e21f7e4b1962529d958a37b02ac0a286421485a8f894b035df9fda39b982804b`
- `security.py`: `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255`
- AX patch: `d11b279ca526e1615a13916277abe68e4b0da8cab0a3a0a5fc81e0c97b519ccc`
- Substrate patch: `b221906a87c15e14dcc9baa742a8ab64e30b72f896f884786f55d1f7c23cb473`

共通契約、[host quota 設計](host-quota-design.md)、[先行 host quota レビュー](host-quota-review.md)、[先行 Python レビュー](python-review.md)を再利用した。C は今回の code runtime/基盤 patch を実装していないが、v8 PG と統合契約の作者である。同じモデルの別担当による実装レビューであり、設計・PG まで完全に独立した評価ではない。固定 runsc の直接試験と実 AX の確認を分け、Python gate を開ける判断は親の結合検証へ委ねる。

## r3固定server-taskの限定レビュー（2026-10-08）

**追加の必須指摘なし。** 固定JSON、AXのtemplate生成、Substrateのtemplate/OCI validator、対応testとAの最終検証記録を読み、次のSHA256を現在ファイルと照合した。

- AX patch: `3c36bd4a8f72dcc10590357363b3cc43e5f66b191d14338fecdc7d6737a23ec2`
- Substrate patch: `be45d8366b57159140ffaab06fed8eb9d223adbbba560ca513befb8d21dff4f3`
- `server-task.json`: `383d1e70dfa457e6018a3c0c0f7be118121be95cb5915090a844e49a4c689ec8`
- `test_code_runtime_server.py`: `066cb7a47ff2ec98582deee4f82264fd1c72cceee61427be26fe1ac07d9a61d5`

固定上流の `cmd/ax-task-runner/main.go` は指定fileを読み、`internal/metadata/server.go` はTaskのdebug=trueでguest serviceを登録する。`runner/runner.go` はcommandが無ければ起動せず待機する。新JSONは固定metadataとdebug=trueだけで、command/env/workspaces/実runのidentityを持たない。Dockerfile既存COPYで固定imageへ含まれ、書込可能なworkspaceから設定を読む構成ではない。

AX生成、SubstrateのActorTemplate完全一致、workerのOCI argv完全一致、Goのtemplate完全一致は、全て `[/usr/local/bin/ax-task-runner,--task-file,/opt/ax-code/server-task.json]` に揃う。旧argv・別path・余分な引数を拒否する試験を確認した。TaskSpecのPython waitとその一回の起動権、空template env、固定5cap、snapshot/再Resume禁止、同世代cleanupの条件は維持する。JSONは起動設定であり、本人認可や実行記録の正本として使わない。

Aの `/tmp/code-server-offline-test-final.log` は2件/4.255秒/OK、`/tmp/code-server-patch-verify-final.log` は対象race・Linux tests・build完了を示し、検証記録と一致した。通常template不変、旧argv拒否、Begin/cleanup既存回帰を含むことをtest sourceで照合した。C自身はこのDocker/patch試験を再実行していない。Goの対応6ファイルは独立に読取り・race/vet確認し、[Goレビュー](workbench-execution-review.md)に記録した。

親から正式Dockerfileのimageでも2件成功・固定本文hash一致を受領したが、Cによる正式image起動の独立実測には数えない。Aの派生imageと親の正式imageを区別した記録は妥当。今回の局所結果を実Actorの起動・8 MiB入出力・停止/host cleanupまでの成功と扱わず、整合したcomponent/imageでの結合確認を親へ残す。製品コード・サービス・DB・OKFは変更していない。

## probe4後の0700祖先・dirfd修正の限定レビュー（2026-10-08）

親のprobe4報告は、`verify_layout`がeuidを65532へ変更した後、absolute pathのlistdirでEACCESとなったもの。固定Substrateの `internal/imagecache/bundle_linux.go:61–65` はrootfs/upper/workを0700で作る。root権限では読める固定sandboxにも、権限を落とした後の絶対パス探索では到達できない構成と整合する。親が観測したのはEACCESと停止回収であり、回収済みActorのroot modeは直接実測していない。原因の説明は固定ソースと下記再現に基づく。Cはliveを再調査していない。

修正案はroot chmodやcapability追加をせず、rootで固定sandboxのdirectory FDを開いてから、UID65532で固定tmp/outputを相対openする方法。実装の `owned_directory` と配置検査・collect・runner出力封印/chunk読取りの4経路を確認し、現時点で追加の必須指摘はない。

- 名前はtmp/outputだけ。親/対象ともDIRECTORY・NOFOLLOW・CLOEXECで開き、親はroot所有かつgroup/other書込み不可、対象はUID/GID65532・0700をfstatで検査する。利用者から任意parent pathやrelative nameを受けない。
- nested finallyでbody/open/fstat/closeの失敗でもUID復元と親FDのcloseを試みる。復元失敗も例外として返し、成功へ置換しない。helperのFDはlayout検査内で閉じ、子をforkする時点へ残さない。collect/seal/readは子の終了確認後に使う。
- 出力名・NOFOLLOW・通常file・所有者・link数・size・stat/fstat・総量/hashの既存条件を維持する。封印はabsolute chmodではなく、検査したFDへのfchmodで行う。chunk読取りも同じ固定output dirfdから開く。
- `security.py` は既存SHA `c96c70cee698548723e46807cd2554665ab9c1de042a7d66cec94b4931767255` と一致。cap/seccomp/chroot/子FD閉鎖・quotaの条件を緩めていない。

確認時の製品SHAはlauncher `5fae90bf68b106a30b88c4237db7c35294563550ecffec6f795b136e24aa4067`、runner `99e38b82413410577e70797bdde7918a96b35956eebb481505940cc4c278773f`。Cはdirfd mock8件・HostLayout4件・Contract5件の17件を独立に実行し成功した。Docker指定が必要な3件はskipであり、成功件数へ入れていない。whitespace checkも成功。

**最終判定:** ソースと局所再現の必要条件は満たし、追加の必須指摘はない。Aが保存した `/var/folders/9w/921pjkys39q28sk4xsc0hs000000gn/T/ax-code-dirfd-evidence-20261008-5vxkk7tc/` の証拠をCが照合した。

- `results.json`・`red.txt`・`green-root700.txt` はAの完了exec出力からの転記と明示されている。旧版は0700祖先下の配置検査1件が `launcher.py:110 os.listdir(path)` のEACCESで失敗（2.902秒）。修正版は同祖先で配置検査・CSV/XLSX RPC・4件非整列計8 MiBの3件が成功（16.570秒）。6 source SHAと現在ファイルが一致する。
- 通常imageの回帰はhelper8・profile7・隔離11・Linux RPC11・8 MiB4・0700祖先3の合計44件、skip0という作者結果と一致する。Cが独立に実行した17件とは分けて扱う。
- 正式image `localhost:5001/ax-code-runner@sha256:8485abc6e29320c34a68e0bc79b3db21c01feecf10cc87b0d1ddbc3b27ef1642` から同じ祖先fixtureを派生した追加3件も成功。`formal-root700.json` のreturncode0とraw stderrの3件/18.023秒/OK、stderr SHA256 `543b0a40872184b39fa6cd007ca84d7073bf77478a9ad4ed82651a02a1bc59c1` を照合した。正式imageのopt/trusted双方の製品hash一致はAが直接確認した結果として受領し、Cのimage実測とはしない。

Dockerの `/` chmodが実際に保持されなかった先行試行は再現条件不成立であり、Redに数えない。test専用の `/root700/sandbox` へのROOT変更と、既存fixtureのtmpfs→9p表示の置換を区別した記録は妥当。これは祖先探索権限のLinux局所再現で、実Actorのroot mode・gVisor/9p全経路・新imageのhost cleanupの証明ではない。整合したimageを使う新規Actorの結合検証は親へ残す。
