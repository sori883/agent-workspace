# Workbench execution 独立レビュー

2026-10-07、担当 C。基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、`codex/agent-workbench` の `execution/` 未コミット差分（新規ファイルを含む）を対象とする。参照は [実装契約](runtime-integration-contract.md) と [B の検証記録](workbench-execution-verification.md)。

## 判定

**コードレビュー上の必須指摘は解消した。** 初回 E1 と、親から別途判明した code の trusted wait 起動不足の修正版を再確認した。現在のソースを次の実Actor結合検証へ渡せる。実環境の確認と gate 開放の判断は、このレビューには含めない。

## E1 — 停止済み code の復旧が guest への再取得で止まる（P1）

- 箇所: `execution/controller/workbench.go:95–104,145–147,211`（修正前）。
- 条件: code の成功 result を PG へ保存し、出力を封印して Actor を停止した後、cleanup 記録の ACK 喪失や finish 前の heartbeat 喪失によって held になる。運用者が停止・旧 controller の退役を確認して recovery を許可する。
- 問題: 保存済み result があるため、停止状態を観測する `WorkbenchResult == nil` の分岐を通らない。その後の `importOutputs` は recovery でも無条件に停止済み guest へ `OutputManifest` を要求する。guest 接続が失敗し、server-owned cleanup proof の取得と finish に進めず、全体の枠を解放できない。
- 最小修正: recovery では保存済み result の有無にかかわらず停止状態を確認する。既に停止している code は guest の出力を再取得せず、停止と host cleanup 証拠を記録して finish へ進む。封印済み成果物の保持と、未封印出力を成功扱いしない判定は PG が行う。Create/Resume/Start の再送はしない。
- 追加検証: 保存成功 result＋封印済み出力＋停止済み guest の回帰で、guest RPC なしの proof→finish を確認する。proof 不明なら hold、未封印出力は成功にせず、新しい Runtime は起動しない。
- 状態: 解消。B は修正前に `guest_stopped` の Red を確認し、実停止を result の有無より先に観測する修正を行った。保存成功 result＋封印済み出力＋停止済み guest の回帰は、guest 再取得なしで proof→finish に進む。C も修正コードと回帰を読み、`go test -race ./controller ./native` の成功を確認した（cache 使用）。

## 確認範囲

- v1/v2 の request、result、mailbox、claim を別型で検証し、v2 の固定 manifest/image/descriptor SHA を照合する。旧 output 上限 256 と v2 の 512 は分岐している。
- intent と claim 世代で開始を一回に制限する。モデルは reserve→count→送信直前の再認可→generate→settle の順序を保ち、既知 usage を提案成功と分離して記録する。生成・開始・精算の不明結果を新たな送信へ置き換えない。
- 8 MiB は 32 KiB chunk で搬送する。固定 alias、canonical base64、chunk 長、総 bytes/hash、出力 manifest を照合する。guest の固定コマンドと 64 KiB frame 上限を保つ。
- 次 Task の作成は Go の再受付ではなく PG finish に限定する。code は egress deny と実停止に加え host cleanup 証拠の記録が必要。proof 欠落時は finish しない。
- ActorStatus field 12 は全体 4 KiB/内部 1 KiB の上限、重複・型・field 数、Actor UID、固定 image digest/profile、UUID generation、cleaned=true を検査する。現在の Actor が SUSPENDED かつ worker 未割当であることも必要。固定上流 patch の code 再 Resume 拒否と併せ、古い停止証拠を再実行へ流用しない構成を確認した。
- workbench/model/Python gate の既定は閉。`inspect --code` は code atespace と host cleanup を観測し、Create/Resume/Start を行わない。

## 検証と限界

C は `go test -race ./native ./gateway ./settings ./cmd/...` を実行し成功（cache 使用）。`git diff --check -- execution` も成功した。B の全 93 race tests・vet/build、PG 合成 fixture と Go canonical/hash の一致は、B の報告とソースを照合した証拠であり、C が実 DB で再実行した結果ではない。

実 Actor、host quota 解除の伝播、実 8 MiB 往復、課金モデル、配備は未確認。Go 局所試験の成功を gate 開放や実環境の安全性の証明にはしない。

C は今回の Go 差分の実装には参加していないが、v8 PG と統合契約の作者である。同じモデルの別担当による Go 実装レビューであり、契約・PG の独立レビューではない。適用済み devlow/review、interrogate/reviewer-prompt と、親から継承した OKF の実行枠・不明時 hold・費用・本人/Workspace 境界を利用した。製品コード、サービス、DB、OKF は変更していない。

## 最終差分の再確認

B の最終 27 ファイル digest は `a32cd5f37fa621438419659d6b641e0f55a18d4f99053afd9a29ac744711a915`。C が照合した主要ファイルの SHA256 は次のとおり。

- `controller/workbench.go`: `8d7f72c60c8e6d40eceae47fe849510085f37463cc03e71419d08552c83ae34b`
- `native/workbench.go`: `c9fee1c9fbd1a1fdb08776696609a0444a34e60b2fa06a11ee4a05b9cee2d0af`
- `native/workbench_protocol.go`: `e766806fb802b6e98392a252f67c23764f8f8898b48376cbfa2776ed28848ac5`

Resume intent 内で Task の Running/Ready を観測した後、固定 `python3 /opt/ax-code/runner.py wait` を一度だけ起動する。ACK 不明・既決 Resume・recovery で再起動しない。StartProcess の ACK と ready.json 保存の間の競合も返し、code-status の bounded な読取り再試行だけで待つ修正を確認した。固定 env module `4468a200b170` の `guest/process/service.go:40` を読み、ProcessService が RPC context を tracker の寿命に使っていないことも照合した。

定義は agent 省略可・skills 最大 8、history 最大 17 かつ canonical JSON 16 KiB へ統一された。B の全 101 race tests・vet/build の成功は追加検証記録として受領。C 自身の修正版 controller/native race と diff check も成功し、新たな必須指摘はない。C の test は局所 fixture を使い、実 DB/Actor に接続していない。

## probe3後の準備判定・固定task-file再確認（2026-10-08）

**追加の必須指摘なし。** 対象は `controller/workbench.go` と同test、`native/workbench.go` と同test、`native/adapter_test.go`、`native/runtime_template.go` の6ファイル。repo rootからの各pathを付けたsorted SHA256行の連結digestを再計算し、Bの確定値 `9984c31c1abb6cd93e6925a1e9aa523bfdfe996febb766a24e242e296b422173` と一致した。

前節のTask Running/Ready条件は、この版ではcode区間だけ更新された。Task identityとRunningを確認した後、`ObserveCodeProcessService` が固定IDへのGetProcess成功又はNotFoundを要求する。既存の `guestClient` による実Actor RUNNING・worker割当・mTLS/SPIFFE検査とactor指定headerを保つ。Unimplemented・Unavailable・PermissionDeniedは準備完了とせず、上限時間内で読取りだけを再観測する。停止済みActorを起こす操作はない。

準備確認後の `PrepareCodeRunner` は既存Resume intent内で一度だけ固定waitを起動する。RPC ACK不明は未確定intentのままholdし、recovery・既決Resumeから再Startしない。wait準備後のcode-status再観測、Stage/code-startの別送信権、停止済み回復でguest outputを読み直さない既存補正も維持する。

`codeTemplateMatches` は `[/usr/local/bin/ax-task-runner,--task-file,/opt/ax-code/server-task.json]` の完全一致へ変更され、旧argv・書込可能な別path・任意env/cap/resourcesを拒否する。TaskSpecの `python3 /opt/ax-code/runner.py wait` と通常Runtime/v1は変更しない。固定JSONとAX/Substrate側との一致は [code側再確認](code-8m-review.md)へ記録した。

C自身がGo 1.27.1/darwin arm64で `go test -race ./controller ./native ./cmd/workbench-probe -count=1` を実行し、3package成功（controller 2.436秒、native 2.240秒、probe 3.068秒）。Bの確定時の集計は104トップレベルtest（53/39/12）。同packageの `go vet`、差分whitespace checkも成功した。BのRed/Greenとbuild報告は作者証拠として参照し、Cによる修正前再現とは扱わない。試験後に追加共有されたprobeのisolation-boundary scenarioは別レビュー対象とする。

この再確認は局所fixtureによるもので、実Actor・DB・モデル・配備には接続していない。固定server-task入りimageとAX/Substrate/controllerを揃えた実経路の再検証は親に残る。同一モデル別担当であり、Cが作者のv8 PGと契約自体の独立レビューではない。
