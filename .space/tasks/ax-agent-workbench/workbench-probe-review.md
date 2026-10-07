# Workbench probe 独立レビュー

対象は2026-10-07、`codex/agent-workbench` の未コミット差分にある `execution/cmd/workbench-probe/{main,probe,probe_test}.go` と `workbench-probe-contract.md`。`-idle` 追加後の版を確認した。担当CはこのCLIの実装に参加していない。共通PG v8と統合契約の作者ではあるため、PG自体の独立レビューや異なるモデルによるレビューとは扱わない。

## 判定

この限定probeのコードについて、追加の必須修正はない。専用schemaの単一root、他writer不在、通常controllerの退役を親が実行前に確認する条件で、無課金の実Actor結合確認へ渡せる。実Actorでの成功、全体slotの排他、専用roleの実権限、試験後の停止・復元をこのレビューで確認したことにはしない。

## 確認した境界

- `main.go:36–49`：fixture/schema/model gateを検査した後、`-idle` はsignal待機へ入り、native設定・接続、DB資格情報・接続・Claimへ到達しない。`settings.Load` は設定ファイルの読取だけ。idleはnative設定が実際に利用できることまでは検証しない。
- `probe.go:91–145`：public等のschema、開いたmodel gate、別root、課金mode、定義を含む依頼、入力ID・名前・サイズ・SHAや順序の変更を拒否する。CSV/XLSXとPython source・出力宣言は固定。revisionはRuntime→code→Runtimeのみで、recoveryや途中再実行を受けない。
- `main.go:84–88`：通常controllerを利用するがModelProviderを作らず、model実行フラグも有効化しない。モデル鍵の読取を追加していない。
- `probe.go:169–221`：模擬model返信も実backendのReserve→Settle→Reserve readbackを通す。保存済み返信は置き換えない。Reserve/Settle/readback不明時は即座に戻り、新しい送信権・Settleを自動再試行しない。toolの変更された提案はPGへ渡す前に拒否する。
- `main.go:101–114`：最大3件を順に処理し、失敗やjob欠落で終了する。既存controllerのfinish ACK readbackは維持し、AX Start/modelの再送は追加しない。
- 終了0は3件処理の通知だけとし、root成功・成果物内容・code host cleanup証拠・全Actor停止の証明と区別する。通常Dockerfileへの組込みや常駐実行管理の追加はない。

## Claim前の限定条件

`probe.go:157–164` は実backendのClaim後にrootを照合する。したがって専用schemaへ別root/jobが混在した場合、そのjobのclaim/slot更新は起こり得る。照合失敗後のAX操作はないが、DB更新までゼロになるガードではない。契約にもこの制限が明示されている。

今回のseedは新規schemaに1rootだけを作り、実行roleへ受付権限を与えない方式であるため、この限定運用ではコード変更を必須にしない。親には開始直前に「専用schemaのroot/job集合がfixtureの1rootのみ」「他writerなし」「通常controller退役・他の未解決実行なし」をreadbackで残すよう伝達した。CLIのschema名検査だけで専用role権限や全体slot1が保証されるとは扱わない。途中失敗後はこのCLIを再起動して復旧せず、既存の確認・停止手順へ返す。

## 検証と版

レビュー担当が `go test -race ./cmd/workbench-probe` を実行し成功した（Go cache使用、対象8 unit）。DB/nativeはfakeであり実接続・実Actor操作は実施していない。idleは読めない資格情報pathを持つ設定でも静的検査後に終了できる回帰、誤ったfixtureはidleでも拒否する回帰を確認した。作者のvet/build結果と実Actorの未確認区分は契約記録と一致する。

3 Goファイルをパス順のSHA256一覧にしたdigestは `fb035aa856c5b20c8e9499164257f2714898da5339d2efd38bf1f85e8d44deaf`。契約に記載された値と一致した。

| ファイル | SHA256 |
|---|---|
| main.go | b487bb15e6983aabfc28b2cb7e506b6e694eff0e846057ca9ff92152e53f0560 |
| probe.go | fc9558eb689de66f0985cc99af5d80b12ff54f84b8bebe270718387c0acf635f |
| probe_test.go | 291e58fc4f83183e54d276c748837081de187f8e7d9c608a67b7dd99ef6168a9 |
| workbench-probe-contract.md | 2f77016176191bc6d47fd5edf1a4ef2d3b356ae220bd627eff8023579c2f81a3 |

今回の対象は小さいCSV/XLSX scenario。1×8MiBや4件非整列合計8MiBの実AX往復、権限失効・停止途中の実環境回復、sidecar置換・標準設定への復元は別の検証が必要。製品全体の受入やPython gateの一般開放を代行しない。

## 8 MiB追加版の再レビュー（2026-10-08）

追加版の対象は `scenarios.go`、`scenarios_test.go` と既存3ファイル、契約の8 MiB節。5 Goファイルのパス順SHA256一覧digest `6b1cd80bd74e310c2acd0016b5ef3e911a57e3c9591a8dafc98fe78fcafc310f`、契約SHA256 `12cd3ca67f1aa953f5f9a5f112659dfe96327a96b805c9b2bcb7e9e05b2cd4db` を実ファイルと照合した。前節の `fb035a…` はCSV/XLSX・idle初版の記録として保持する。

追加の必須修正はない。以下を確認した。

- `copy-8m-1` は1件8,388,608 bytes。`copy-8m-4` は1,048,577 / 2,097,155 / 3,145,733 / 2,097,143 bytesの4件、合計8,388,608 bytesで全件32KiB非整列。入力alias/name/size/hashは固定値、UUIDだけfixture由来で重複を拒否する。
- 固定コピーsourceは32KiBずつ読み、入力のsize/hashと総量を検査する。出力の名前・上限は対応入力と一対一で、revision2のsource/入力順/出力宣言を照合する。revision3では各成果物のsizeとSHAが元入力に一致しなければ拒否する。NULを含むbinaryをCSVとして解析せず、転送境界試験として扱う契約と一致する。
- Runtimeへ戻るdescriptorは入力と成果物を合わせて2件/8件となる。既存のRuntime最大16参照と整合し、Pythonだけに適用する4件/合計8MiB制限を緩めていない。
- CSV/XLSXのsource・固定内容は維持され、scenario名を外部の任意sourceへ展開する経路はない。専用schema/root、preview、model gate拒否、model鍵を読まない構成、idle分岐、新規3claim限定、途中失敗で終了する境界は初版と同じ。
- stage診断は検査済みmodel/tool種別から作る固定stage名と、sentinel errorの固定分類、0〜3のrevisionのみ。raw errorの文字列化やpayload出力はない。失敗した実行を再開する機能も追加されていない。

レビュー担当が `go test -race ./cmd/workbench-probe -count=1` を実行し、12件成功（package 1.806秒）。hostの一時ディレクトリで固定Pythonを実行する2シナリオもこの試験に含まれ、全出力bytesを比較した。DB・AX・外部モデル・稼働設定へは接続していない。

ClaimがDB更新後にrootを照合する制限と、通常controller退役・専用schema単一root/他writer不在の実行前条件は引き続き必要。局所試験は512/518 chunkの実AX全往復、300秒内の完了、code host quota、実停止・host cleanupを証明しない。親から共有された別の実Actor試行の環境allowlist不整合・holdはこのprobe追加差分の合格で解消したとは扱わず、基盤担当の修正と実測へ返す。

## isolation-boundary追加版の限定レビュー（2026-10-08）

**追加の必須修正なし。** `boundary.go`/同testを加えた7 Goファイルのsnapshot `70a9669057aadf856cdf0e64c5bbd5ca1f24d1ee029c83eb8df670ce74e6c60d` を再計算し、B報告と一致した。固定sourceは2824bytes/SHA256 `5ca29be8002e69edb1194f465d71f2cc277de69b07584d301d841955bf388269`、固定出力は186bytes/SHA256 `6cd526de64285084849bb028668f3906f52a357d03c9f9c1d3d4640db8885d0c` で、契約と一致する。

- 入力は固定15bytesのsales.csv1件。source・instruction・purposeを外部値から組み立てず、code claimで完全一致を確認する。最後のRuntime claimでboundary.csvのsize/hashも固定値と一致させる。未知scenarioを任意コードの入口にしない。
- 固定sourceのsocket試験は作成だけで接続しない。親操作はsignal 0と空vectorのprocess_vm、非公開pathはopenだけで本文を読まない。fork/exec等が想定外に通ればassert失敗又は非0終了となり、成功成果物を書かない。試験は既存300秒・資源上限のcode Task内でのみ実施する。
- UID/GID、環境、FD、私有path、入力/ライブラリの書込み拒否、権限変更拒否を確認する構成。cap全set0/NNP1の実値はtrusted bootstrapの既存検査に依存し、このsourceが直接測定したとは主張しない。全assert成功のCSVも未信頼子の結果であり、実Actorの停止やhost cleanup証拠の代わりにしない。
- model gate閉・鍵を読まない経路、実Reserve→Settle→readback、専用rootの新規3claim、idle、失敗/ACK不明時の無再送は維持する。元CSV/XLSX・8 MiB scenarioを削除・一般化していない。Claim前の専用schema単一root/他writerなしの運用条件も維持する。

Cは `execution/` をcwdとして `go test -race ./cmd/workbench-probe -count=1` と同packageのvetを実行し成功（15件、package 2.871秒）。boundary sourceはunit内でAST/compileのみ検査し、hostで実行していない。初回のrepo rootからのgo呼出しはmodule未検出で試験前に停止し、cwdを訂正して上記を実行した。diff checkも成功した。DB/AX/モデルには接続しておらず、実隔離拒否・host停止・試験後復元は親の実Actor確認に残る。
