# 指示と入力を渡してAXのタスクを実行する

`ax-local/task` は、実行ごとに新しいAX Taskを作り、成果物・終了結果・使用量をMacへ保存する。既存の [ローカル基盤](README.md) と、[CLI用イメージ](rebuild.md#タスクcli用イメージ) が必要。

[Webワークスペース](../web/README.md)からも同じ台帳・排他・費用制御を使って実行できる。Web受付は`accepted`として永続化し、有限workerが後続処理を行う。既存の同期CLIコマンドは引き続き利用できる。

## 使う

リポジトリのルートで実行する。まず入力と実行設定だけを確認する。

```bash
bash ax-local/task run \
  --instruction-file ax-local/examples/request.txt \
  --input ax-local/examples/input.txt \
  --output answer.txt \
  --dry-run
```

`--dry-run` は入力・設定をローカルに保存するが、AXやモデルAPIへ送信しない。実行する場合は同じコマンドから `--dry-run` を外す。モデルAPIの利用は課金を伴うので、目的と出力を確認して1件ずつ実行する。サンプルは入力に書かれた合言葉を `answer.txt` へ書き出す。

`--input` は複数指定できる。初期版は少量のUTF-8テキストと成果物1ファイルを扱う。

| 項目 | 制限 |
| --- | --- |
| 指示 | UTF-8で最大2048バイト、空白だけは不可 |
| 入力 | 最大4ファイル、本文の合計4096バイト |
| ファイル名 | 英数字で始まり、英数字・`_`・`.`・`-`の最大64文字 |
| 成果物 | 1ファイル、最大64KiB |
| パス | 通常ファイルを使用し、シンボリックリンク・特殊ファイルを拒否 |

入力はSDKへの文脈として渡す。エージェントには本文だけを受け取る `write_output` ツールを渡し、指定した出力ファイルを1回だけ作成できるようにしている。出力先のパスは実行側で固定する。シェル実行や自由なファイル読み取りは許可していない。用途に合わせたツールの追加は後続の変更で扱う。

## 結果を見る

実行すると `ax-run-` から始まる `run_id` と結果のJSONを返す。TaskのRunning/Readyと、処理の成功は別に判定する。成功には通常終了、成果物、既知の使用量、通信遮断とTask停止の確認が必要。

```bash
run_id='実行時に表示されたID'
bash ax-local/task inspect "$run_id"
```

保存先は `ax-local/.state/runs/<run_id>/`。

| ファイル | 内容 |
| --- | --- |
| `request.json` | 渡した指示と入力 |
| `manifest.json` | 固定digestを指定したAX Task |
| `receipt.json` | CLIの進行、通信遮断・停止の結果、エラー、費用概算 |
| `result.json` | エージェント処理の終了状態・使用量・成果物情報 |
| `artifacts/<出力名>` | サイズとSHA256を照合した成果物 |

入力や成果物はGit対象外のローカル記録に残る。`inspect` は既存記録を読む操作で、モデルAPIへの送信は行わない。処理の成否はJSONの `outcome` と `result.status` で確認する。

## 失敗・中断した場合

CLIは同時実行を拒否し、開始合図を再送しない。失敗や中断でも通信遮断とTask停止を試みる。強制終了や通信断などで未確認の実行が残る場合は、次の実行を止める。

```bash
bash ax-local/task recover "$run_id"
```

`recover` は通信を閉じ、稼働中の既存Actorに結果があれば回収して停止する。新しいTaskの作成、開始合図の送信、停止中Taskの再開は行わない。停止中で結果を未回収の場合は未解決のまま残し、個別の調査が必要になる。使用量不明や通信遮断の失敗を成功に置き換えない。

Webの受付後、外部操作を一度も試みていない`accepted`は、同じロックの下で開始前終了（`not_started`）にできる。この場合はモデル呼び出しなし、通信遮断・Task停止は対象外として保存する。既に解決済みの記録に対する復旧は副作用なしで返る。

有料実行が失敗した場合、通信遮断と使用量を確認できても、原因を調べるまでは次の有料実行を止める。原因と修正の根拠を確認した後、次の操作で記録できる。

```bash
bash ax-local/task acknowledge-failure "$run_id" --note '確認した原因と修正内容'
```

この操作はローカルに調査記録を残すだけで再実行しない。使用量不明や後片付け未完了は解除できず、同じ入力・指示・イメージでの失敗の再送も引き続き拒否する。

## 費用と接続先

初期アダプターはAntigravity SDK 0.1.20とGemini 3.1 Flash-Lite。モデル呼び出し3回、ツール2回、入力6000・出力512・合計6512トークン、API再試行0、出力形式の再処理1、実行90秒の制限を使う。接続先は `generativelanguage.googleapis.com` に限定する。

各API応答の使用量をアダプター内で確認する。途中のAPIエラー、応答の欠損、使用量の欠落があれば費用を不明として記録し、その実行内の後続送信と次の有料実行を止める。

このCLIが観測した概算の累計が0.01 USDに達すると、追加の有料実行を止める。これは少数の試用を想定した停止閾値であり、過去の別ツールでの利用やプロバイダーの請求総額を表さない。概算単価には確認日があり、SDKのトークン予算とこの閾値で課金額の厳密な上限を保証するものではない。

共通のCLI・実行記録・開始制御は `task_cli.py` と `task_runtime/runner.py`、SDK依存部分は `task_runtime/adapters/antigravity.py` に分けている。他のモデルサービスのアダプターはまだ実装していない。

## モデルを使わずに確認する

`run` に `--offline` を付けると、AXの実行環境内で入力本文を結合して成果物に保存する。モデルの判断を含まない経路確認で、通信許可は空、使用量は人工値の0として記録する。

```bash
bash ax-local/task run \
  --instruction-file ax-local/examples/request.txt \
  --input ax-local/examples/input.txt \
  --output answer.txt --offline

python3 -m unittest discover -s ax-local/tests -p 'test_*.py' -v
```

実SDKを使う通信なしの検証は [再ビルド手順](rebuild.md#タスクcli用イメージ) を参照する。
