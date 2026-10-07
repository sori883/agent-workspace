# SDKの単発JSON提案

2026-10-07。P1契約を具体化するための限定試作。製品コード、DB、AX、実モデル通信は変更していない。

固定 `google-antigravity==0.1.20` の実SDKを別Python subprocessで2回起動し、模擬providerから通常テキストJSONを受け取った。SDKの状態は再利用せず、2回目にはアプリ側の合成された確認済み質問・操作ID・回答を入力した。実結果は [results.json](results.json)。

- SDK設定は3 model/2 tool、input 6000/output 512/total 6512、toolsなし、deny_all、subagent/builtin tool無効、API/model-output retryとも0。response_schema/finishを使わない。
- 各processの模擬model要求は1回、両方 `UNSPECIFIED`、SDK tool呼出し0。合計2 model要求、合成usage 240 tokens。
- 提案は `ask_user/question` と `write_output/content` という試作上の形。製品契約候補の `question|output|unsupported` / `text` の厳密検証はこの試作の範囲外。
- 2回目のprovider入力に確認済み操作IDとユーザー回答があることを照合した。SDKのfunctionCall/functionResponseの復元ではない。
- `planned_runtime_tool_count:2` は予定する固定操作数であり、実測されたSDK tool数ではない。Runtimeの固定操作は実行していない。成果物は提案文字列のサイズ/hashだけを計算した。
- 外側PG台帳・Gateway予算予約・履歴の真正性・技能のhash検証・strict JSON validation・失敗時再送防止・AX停止証明は未実装/未検証。新SDK sessionによる見かけ上の予算リセットを、この成功で正当化しない。
- 初回は試作のtool記録取得で、非同期generatorを関数として呼んだため失敗した。失敗のstderr記録と取得方法を直し、上記2processの試作を完了した。SDK自体の通常応答後の記録処理エラーであり、SDK予算不合格の結果ではない。

既存ローカルimageのみを使い、ネットワークはDockerの `none`、providerは同コンテナ内loopback。秘密・既存state・Docker socketはmountしていない。SDK一時DBはコンテナ内TemporaryDirectoryにだけ保存して終了時削除する。

```sh
docker run --rm --pull=never --network none --pids-limit 128 --memory 2g --cpus 2 \
  -v "$PWD/.space/tasks/ax-agent-runtime/spike/contract-probe:/probe" \
  --entrypoint /usr/bin/env \
  sha256:1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5 \
  -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/sdk-proposal \
  python3 /probe/probe.py --out /probe/results.json
```

同じ成功ケースの追加反復は不要。次の検証は製品側の外部予算・mailbox・固定操作の失敗境界を対象にする。
