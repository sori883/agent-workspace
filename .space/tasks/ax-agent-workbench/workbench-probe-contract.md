# 無課金 Workbench 結合 probe

`execution/cmd/workbench-probe` は専用schemaの合成データで Runtime → code Task → Runtime を確認する検証入口。製品の `RespondWorkbench`、通常Dockerfile、DB関数は変更しない。Runtime/SDK、code実行、PG受付/送信権/settle/chunk/seal/停止証拠/finishは製品経路を使い、モデル応答のみ固定JSONへ置き換える。外部モデルを呼ばず、模擬usageは各Runtimeで100/20/0/120/1、費用0。

## 親が準備するもの

- 独立schema `ax_workbench_probe_[a-z0-9_]+`（全長63文字以下）にauth/data v1–v8と限定実行roleを設定。通常appの `public` は対象にしない。
- 通常controllerを停止し、全体の同時実行1を保つ。独立schemaは独立slotを持つため、このprobe自体では通常appのslotと調停しない。
- 1つの合成owner/workspace、現在所属、期限付きgrant、preview rootだけを用意する。workbench/python gateは専用schemaで開き、model gateは閉じる。必要なruntime/code imageは固定digestにし、`ax_workbench_control.code_profile='host-quota-8m-v1'` をroot作成前に設定する。rootへ固定された同値も開始前に読み戻す。profile未設定はPython予約で確定拒否となる。
- `initial_text` は `AX workbench isolated tabular probe v1`、定義/skillなし。ready入力2件を次の順でstartする。

| alias | 公開名 | bytes | SHA256 |
|---|---|---:|---|
| input_1 | sales.csv | 15 | ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b |
| input_2 | sample.xlsx | 4995 | 57fc8b3217b18140278226478ecb3ee1ebef5b27c8ad5f15cbb7a6aa15b8a8d6 |

CSVは `amount\n100\n200\n`。XLSXは `web/tests/fixtures/workbench-input.xlsx` をsample.xlsxとして保存し、active sheetのA1=amount/A2=10/A3=20。

通常execution設定のコピーを作り、database.schemaだけでなくrole権限も専用schemaへ限定する。`workbench.enabled=true`, `python_enabled=true`, `model_enabled=false`, `model_gateway.enabled=false` とする。probeはModelProviderを構築せず、API keyを読まない。TLS/mTLS等のnative設定は通常経路と同じ検証を通る。

## fixture と実行

fixtureは上限64KiBのstrict JSON。

```json
{
  "version": 1,
  "schema": "ax_workbench_probe_unique",
  "root_id": "<seed済みroot UUID>",
  "scenario": "csv-xlsx",
  "inputs": [
    {"alias":"input_1","file_id":"<CSV file UUID>","name":"sales.csv","size_bytes":15,"sha256":"ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b"},
    {"alias":"input_2","file_id":"<XLSX file UUID>","name":"sample.xlsx","size_bytes":4995,"sha256":"57fc8b3217b18140278226478ecb3ee1ebef5b27c8ad5f15cbb7a6aa15b8a8d6"}
  ]
}
```

親が別imageへ組み込み、`workbench-probe -config <専用設定> -fixture <fixture>` を一度実行する。通常Dockerfileには含めない。CLIはschema・model gateをcredential取得/接続前に確認し、Claimでもroot/preview/policy/入力ID・名前・bytes・hash/段階を検査する。不一致ではAX副作用へ進まない（DB claim自体は取得済みになり得るため親が専用schemaを確認する）。

一時sidecarのPID1には末尾 `-idle` を付けられる。このモードはfixture/schema/model gateの静的検査後に `probe_idle_no_claim` を出し、SIGTERM/SIGINTまで待つ。DB接続・claim・native接続・credential読取は行わない。親が通常controllerを退役させ、probe containerだけのhealth probesを一時的に外し、`exec`で同binaryを `-idle` なしで一度起動する。通常AX serverのhealthは維持し、検証後は標準controller image/config/probesへ戻す。

1. revision1 Runtime: 実Reserve(send=true) → 固定Python提案を実Settle → 実Reserve(readback)。通常controllerには保存済み返信だけを返す。未送信の未知結果を自動再試行しない。
2. revision2 code: 固定sourceと入力/出力の一致をClaimで再確認。PythonはCSV/XLSXの値をassertして合算し、2本の成果物を作る。出力は各16KiB上限、PG sealとhost cleanup証拠は通常経路。
3. revision3 Runtime: PGに保存済みの `python_result` と成果物metadataを確認し、固定output提案を同じreserve/settle経路で返す。新しいcode提案は作らない。

tool提案も固定Python/固定最終outputと一致する場合だけ通常PGへ渡す。変更されたsourceは受理しない。各Claimは新規executeかつeffectsなしの1→2→3だけ。recoveryや途中からの再実行には使わない。

## 親が判定する結果

- root succeeded、Runtime/code/Runtimeの3区間、全run resolved、操作未確定なし、slot解放、費用0、モデル送信なし。
- code入出力のchunk/hash照合、2本のready成果物、egress deny、全Actor実停止・worker未割当、codeのserver-owned host cleanup証拠。
- `summary.csv` はUTF-8の `source,total\nsales.csv,300\nsample.xlsx,30\n`。
- `summary.xlsx` のactive sheetは `[source,total]`, `[sales.csv,300]`, `[sample.xlsx,30]`。ZIP生成日時でbytesは変わり得るため内容を読む。保存bytesの整合性はPGのSHA256で別途確認する。
- 最終返答は `CSV total=300; Excel total=30; probe complete`。

終了0のevent `probe_three_jobs_processed_check_database` は3件処理したことだけを示し、上記DB/Actor/成果物確認を代行しない。1は受付/実行/結果不明、2は設定/fixture不備。失敗・ACK不明・job欠落で直ちに終了し、再Startや次の自動試行をしない。親が停止/回収/専用schema後片付けを確認する。秘密・raw errorは出力しない。

## 局所証拠と未確認

対象は2026-10-07の未コミット差分。probeの3 Goファイルをパス順のSHA256一覧にしたdigestは `fb035aa856c5b20c8e9499164257f2714898da5339d2efd38bf1f85e8d44deaf`。`go test -race ./cmd/workbench-probe`、同packageのvet/build、diff checkに成功。固定Python source 869bytesの構文も確認した。通常Dockerfileへの追加はない。

8件の無課金fixture unitはrace付きで成功。public/課金gate/誤ったmetadataの起動拒否、Claimのroot・段階束縛、実backend相当へのreserve→settle→readback順序、保存済み返信再利用、unknownで再試行なし、固定tool以外の拒否、idle時の静的検査と依存接続なしを確認した。DB/nativeはunit内のfakeであり実AX成功の証拠ではない。実Actor結合は親が担当する。

上記 `fb035a…` 初版はCSV/XLSX scenarioのみ。次節は後続の追加版であり、実AXへ配置済みとみなさない。

## 8 MiBコピーscenario追加（2026-10-08）

fixtureの形、専用schema・単一root/他writerなし、preview/gate、3区間、一度実行、idle、失敗時無再送は共通。CSV/XLSXは変更せず、次のscenarioを追加する。scenarioごとに別schema/rootを準備する。

| scenario | initial_text | 固定最終返答 |
|---|---|---|
| copy-8m-1 | AX workbench isolated 8MiB single-copy probe v1 | 8 MiB byte copy (1 file) complete |
| copy-8m-4 | AX workbench isolated 8MiB four-copy probe v1 | 8 MiB byte copy (4 files) complete |

入力aliasは `input_1` から番号順、nameは `copy-input-1.csv` 等。出力は対応する `copy-output-1.csv` 等で、出力上限は元のsizeと同じ。各入力も出力も合計8,388,608 bytes。CSV拡張子は転送経路のためであり、中身はNULを含む固定binaryである。CSV解析はせずbyte-copyだけを行う。

| scenario | i | bytes | SHA256（出力も同じ） |
|---|---:|---:|---|
| copy-8m-1 | 1 | 8388608 | 3480e36fd09a0e1fb7fc22645b44a0332ee0c2fd9cd6f62ef44fd76522b708fe |
| copy-8m-4 | 1 | 1048577 | e3888e3f3a005c89dfc8b9ace9330602fc2ddc0b7ea37f777b1c3a58d3c7bd57 |
| copy-8m-4 | 2 | 2097155 | 9dccddd4b541c44b1a02bb92152155d0cc64435925bb1e126b2d70495f655edb |
| copy-8m-4 | 3 | 3145733 | c2f3640378220cf9790b5ca0ad29ba5dcf36e3e246b80f9b298654be3f8c1542 |
| copy-8m-4 | 4 | 2097143 | 55e281daef11c8c13845a4f8825613a8eaf8eab5eaf680443a20109feb585c06 |

fixture作成ではiを1始まりとし、次の256byte blockを必要なsizeまで反復する。

```python
block = bytes((j + 17 * i) % 256 for j in range(256))
content = (block * ((size + 255) // 256))[:size]
```

このbytesをFileRepositoryでbegin/chunk/sealし、返ったfile UUIDだけをfixtureへ補う。本文/hash/size/name/aliasはGo内の固定値と一致しなければ起動・Claimを拒否する。コピー後のRuntime Claimでも、成果物のsize/hashが対応入力と完全一致することを確認する。

単一fileは256chunk、4fileは33+65+97+64=259chunkで、入出力合計はそれぞれ512/518chunk。4fileはすべて32KiB非整列で最終chunkを通る。Aの固定profileはページ端数分をmount側へ確保し、論理8MiB上限を別途検査する。実Actorでは転送件数/全bytes hash/経過時間/host cleanup/全停止を確認し、成功を局所試験から推測しない。

追加版はprobe stage診断を出す。`claim`, `model_reserve`, `model_settle`, `model_readback`, `tool_reserve` と、`ok/gateway_denied/authorization_revoked/held/cancelled/deadline/unconfirmed` の固定分類、revisionだけを出す。指令本文、file内容、token、raw DB/native errorは出さない。例えばprofile不足の既知拒否は `tool_reserve/gateway_denied` まで区別できる。

追加版の5 Goファイルdigestは `6b1cd80bd74e310c2acd0016b5ef3e911a57e3c9591a8dafc98fe78fcafc310f`。`go test -race ./cmd/workbench-probe -count=1` 全12件と `go vet ./cmd/workbench-probe`、diff check成功。固定Pythonをhostの一時ディレクトリで実行し、1×8MiB/4×非整列計8MiBの全出力をbyte比較した。外部ライブラリ・通信は使っていない。CSV f-string部分もASTから評価し、literal backslashではなく改行になることを確認した。旧CSV/XLSX/idle、未知時無再送、model gate拒否の回帰は維持。

この追加で実DB/AX操作、image build/配備、有料送信は行っていない。実Actor検証は親が担当する。

## 隔離境界scenario追加（2026-10-08）

`scenario=isolation-boundary` は `initial_text=AX workbench isolated boundary probe v1` とし、入力は `input_1` の `sales.csv` だけを使う。本文は既存の15bytes、SHA256は `ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b`。専用schema、単一root、preview、モデルgate閉、Runtime→code→Runtimeの3区間、未知結果を再送しない条件は共通である。

固定Pythonは2824bytes、SHA256は `5ca29be8002e69edb1194f465d71f2cc277de69b07584d301d841955bf388269`。UID/GID65532、IPv4/IPv6/Unix socket作成の拒否、fork/thread/execの拒否、親へのsignal/ptrace/process_vm操作の拒否、制御パス非公開、入力・固定ライブラリへの書込み拒否、昇格操作の拒否、余分なfdなし、入力内容を確認する。各操作は一度だけで、socketは接続せず、process_vmには空のvectorを渡し、非公開パスはopenの成否だけを確認する。秘密値や親の内容は読まない。全assertに成功した場合だけ `boundary.csv` を排他的作成する。

`capget` と `prctl(GET_NO_NEW_PRIVS)` は既存seccompで拒否されるため、この未信頼sourceからcapability=0/NNP=1を直接測定したとは扱わない。実値はfilter設定前のtrusted bootstrapによる検査に依存し、probeではsetuid/capset/NNP解除の拒否を確認する。`/tmp` と `/output` は意図した書込み先であり、閉鎖対象に含めない。

成果物は `output_2_1` / `boundary.csv`、186bytes、SHA256 `6cd526de64285084849bb028668f3906f52a357d03c9f9c1d3d4640db8885d0c`。内容は次のUTF-8、末尾LFを含む。revision3のClaimでもsize/hashの完全一致を要求する。

```csv
check,result
identity,pass
network,denied
fork_exec,denied
parent_control,denied
private_paths,hidden
readonly_paths,denied
privilege_changes,denied
inherited_fds,closed
input,unchanged
```

最終返答は `Isolation boundary checks complete`。上記は未信頼子のassert結果なので、親の実Actor検証では既存のDB費用0・全操作確定・slot解放に加え、server-owned cleanup証拠と各Actor実停止も確認する。

追加後の7 Goファイルdigestは `70a9669057aadf856cdf0e64c5bbd5ca1f24d1ee029c83eb8df670ce74e6c60d`。`go test -race ./cmd/workbench-probe -count=1` 全15件、同packageのvet、diff checkが成功。固定sourceの構文と成果物bytes literalはAST/compileで確認し、hostではこのsourceを実行していない。source改変・出力hash/size違いの拒否、settle ACK喪失時の無再送、旧scenarioの回帰も確認した。実DB・実Actor・image build/配備・モデル送信は未実施で、実Actor検証は親、独立レビューはCへ渡す。

親seed `web/scripts/workbench-probe.ts` のSHA256 `57637eedbf4c643469fbaeccd46a21f50b94b09b2930c99e2ef80a6e7c098f68` を読み取り照合した。追加3行のscenario、instruction、単一sales.csv本文はGo固定値と一致する。seed実行は行っていない。
