# 固定SDKの質問・保存・継続試作

2026-10-07。親の依頼による実装前の適合性試作。基準 `a682948be9daddc37555067fd98475eb3938b427`。製品・DB・Kubernetes・AX・設定・費用上限は変更していない。

**SDK 0.1.20は、完了した質問toolの履歴を別プロセスへ復元し、回答を受けて固定toolを実行できる。ただし、そのまま安全な製品継続機能になるわけではない。** 保存にSDK固有SQLite/protobufが必要で、予算到達後の再開にも追加送信が発生した。合成入力とloopback providerのみを使用し、外部モデル要求・課金は0件。

## 実行環境と方法

- 既存ローカルimage `localhost:5001/ax-task-runner:task-cli`。実行時ID `sha256:1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5`、Python 3.12、`google-antigravity==0.1.20`。
- Docker `--pull=never --network none`。providerは同コンテナ内 `127.0.0.1` のHTTP server。別のPython subprocessを順に起動し、SDK本体と同梱localharnessがproviderを呼ぶ。SDKを自前loopに置き換えていない。
- コンテナ環境は `env -i` でPATH/HOMEだけを渡し、モデル設定には偽の `offline-stub-only` を使用。秘密の読取り、ホストの既存stateやsocketのmountはしない。mount対象はこのspikeだけ。
- SDKの公開 `conversation_id`、`SessionContinuationMode.RESUME`、`save_dir`、`BudgetScope.LIFETIME` を使用。API/model-output retryは0。
- `ask_user`は質問とIDを返して**完了する固定tool**。応答待ちのtool coroutineを強制終了して継続した試験ではない。回答は次の `chat()` のユーザーメッセージとして渡す。
- `idle` subprocessはAgentを初期化し、chatせず終了。`question`を別processで実行・正常に閉じ、`answer`をさらに別processで実行する。

## 結果

小さい機械可読結果は [results.json](results.json)。`passed`はケースごとの目的に対する判定で、SDK/製品全体の合格ではない。

| ケース | 実測 | 判定 |
| --- | --- | --- |
| 起動のみ | 全ケースのidleでprovider 0要求、tool副作用なし | 起動だけでは処理しない経路を確認 |
| 通常継続 | 質問2＋回答2＝4模擬model要求、ask_user/write_output各1回、成果物14 bytes。両turn `UNSPECIFIED` | SDK継続は成立。**診断専用5 model/3 tool設定**であり、製品3/2への適合ではない |
| 保存先移動 | SDK saveディレクトリと会話ID/試験台帳だけを新ディレクトリへコピーし、app_data_dirも新規にして復元成功 | プロセスメモリ・旧app_data_dirに依存しない。同じimage/SDK版/コンテナでの試験 |
| 履歴復元 | 再開後provider入力に同一IDのask_user functionCall/functionResponse、質問、回答が存在。ask_user再実行なし | 確認済みtool結果の復元を確認。モデルが同じ操作を新しく要求した場合の重複防止保証ではない |
| usage復元 | question後240 tokens、answer開始前240、完了後480（模擬値） | SDK会話の累積usage復元を確認。実課金照合ではない |
| model上限2到達後RESUME | 前processで2要求、再開後さらに1要求とwrite_outputを実行し、再び上限停止 | **不合格**：予算超過前の送信禁止はSDK単体で満たせない。期待0要求のassertが実際に失敗 |
| tool上限1到達後RESUME | ask_user 1回で停止後、再開したchatが追加model 1要求。tool総数は1 | 使い切った実行を自動で新規送信ゼロにする境界には使えない |
| 製品と同じ3 model/2 tool | model合計3、tool合計2、成果物あり。ただし最終 `MAX_MODEL_CALLS_EXCEEDED` | **通常完了ではない**。成果物の存在だけで成功にしない |
| 存在しない会話をRESUME | 初期化拒否、追加provider 0要求、tool再実行なし | missing stateを新会話へfallbackしない設定は利用可能 |
| provider 503 | 1要求、toolなし、`AntigravityExecutionError`。再開しない | この設定で自動retryなし。未知結果の再送許可を意味しない |

## 公開hookとterminal toolの追加確認

`post_tool_call` hook内から公開 `conversation.cancel()` を呼ぶと、1要求で `AntigravityCancelledError` になった。実際の `tool-calls.jsonl` には `ask_user` 1回の実行・質問記録が残っている。一方、戻ったSDK historyにtoolのDONEを確認できなかったため、その状態からのresumeは試していない。**DONE未確認は副作用0という意味ではない。** これは安全な質問待機の確認には使えない。

公開 `response_schema` で組込み `finish` toolを定義し、`policy.allow('finish')`を与える方式も確認した。質問を構造化出力として1要求で止め、新processの回答後も1要求で構造化出力を返した。しかしfinishもtool予算に数えられ、累積2回目では `MAX_TOOL_CALLS_EXCEEDED` となる。解析可能な値が存在しても通常終了と同一視しない。

このterminal試験の固定ask_user/write_outputは、SDKの構造化結果を受けた**試験アプリ側のdispatch**で実行した。custom toolに「実行後正常停止」属性を付けたものではない。試作は上限停止後も値を観測するため成果物を作ったが、製品へその挙動を採用していない。3 model/2 tool内で質問toolと成果物toolの両方を通常完了させる契約は未確認のままである。

最初のterminal試験ではfinishへのallow不足でfail-closed拒否になった。原因を特定してその一つだけをallowし、新しい試験会話で確認した。既知成功ケースの反復や不明操作の再送はしていない。

## 保存形式と採用上の条件

SDKの `save_dir` は会話ごとのSQLite DBを保存し、`steps`等のtable内にprotobuf BLOBを含む。公開 `conversation.history` のJSONにはtool-call情報を取得できるが、tool-response全文を含めた**JSONだけの公開import経路は今回確認できていない**。モデルへ送られた復元済みfunctionResponseはloopback provider側で照合した。

試験は検査用JSON（question ID、SDK版、会話ID、公開history、usage、観測したfunction parts）とSDK保存ファイルを分けている。JSONはinspection evidenceであり、単独のSDK再開形式とは呼ばない。SDK内部DBをアプリの唯一の正本にせず、製品では質問・回答・operation台帳・予算を外側へ保存し、SDK stateは版固定・hash付きのadapter状態として扱う判断が必要。

Gateway/継続受付は累積残予算を送信前に確認し、SDKのLIFETIMEだけへ任せない。90秒の合算時間、別会話・子agentを含むroot予算、保存応答喪失、途中toolやinflight modelの強制終了、改ざん/破損state、実providerのusage、SDK版変更、AX Task停止/新Task/同Task resumeは未検証。今回の成功をAX実経路の証拠にしない。

## 再現と一時成果物

リポジトリルートで実行する。外部pull・認証情報・稼働サービスは不要。指定の既存imageがなければ取得せず止める。結果先には新しい名前を使う。

```sh
docker run --rm --pull=never --network none --pids-limit 128 --memory 2g --cpus 2 \
  -v "$PWD/.space/tasks/ax-agent-runtime/spike:/spike" \
  --entrypoint /usr/bin/env \
  sha256:1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5 \
  -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/sdk-spike \
  python3 /spike/sdk_continuation.py --root /spike/evidence-reproduction
```

`--cases model_limit`等で未確認境界だけを選択できる。harnessは観測結果を保存し、`budget_boundary_passed:false`等を失敗として別記する。harnessの終了コード0や`harness_assertions_passed`は、全受け入れ条件の合格を意味しない。

`evidence-*/`のSDK DB、cache、詳細history/provider要求、stderrは合成入力を使うローカル試作の一時成果物で、spike内の `.gitignore` により除外する。削除・再生成可能であり将来PRへ無差別に追加しない。引渡し対象はこのREADME、probeコード、小さい `results.json`。SDK内部ファイルを必要に応じて調べる場合も今回の試作ディレクトリだけを対象とする。

初期probeの上限境界で期待assertが失敗した後、未実行ケースを個別に進めた。providerエラー/cancelが通常Exception系でない場面の報告処理を補正し、結果記録の不足を解消した。最終ソースは構文確認済み。親の指示に従い、既に成功した全ケースの再実行はしていない。

報告後、hook_stopの早期returnでtool記録を集計せず結果を空配列にしていた点を訂正した。実記録のask_user 1回をresults.jsonへ反映し、将来のprobeもSDK完了確認と実tool記録を分けて保存する。再試験は行っていない。
