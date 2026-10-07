# 実モデルGateway契約

基準 `13eb7f1`。2026-10-07、親・Gateway担当A・PG担当Bの合意。実モデル送信と配備は親のみ。実装と局所検証は実料金確認・実経路確認の代わりにしない。

## 固定する実行条件

- rootのmodeは `preview|model`。旧rootはpreview。受付で固定し回答時に変更しない。
- profileはmodel時 `gemini-3.1-flash-lite-standard-2026-10-07-v1`、preview時 `preview-v1`。Taskのrequest schema 1/6 fieldsは維持し、claimの `agent:{mode,profile_id}` をGatewayへ渡す。SDKには実鍵を渡さない。
- 生成はGemini Developer APIの固定HTTPSホスト、`/v1beta/models/gemini-3.1-flash-lite:generateContent`、標準料金、textのみ、1 candidate、thinkingLevel=minimal、includeThoughts=false。tools、files、URL、cache、課金拡張、任意endpointを許さない。
- JSON SchemaはGatewayのgenerationConfigに固定する。SDKのresponse_schema/finish/custom toolは追加しない。提案はkind/textのみ、requestはquestion/output/unsupported、answerはoutput/unsupported。UTF-8 text最大2048 bytes、空白のみ拒否。
- root合算で生成3回、固定操作2回、入力6000、思考込み出力512、active 90000ms。1生成の出力はmin(256,残output)。countは別途各区間1回だけ、生成回数へ加算せずactive時間へ加算する。
- 入力は最終generateContentRequest全体をcountTokensへ渡し、count<=remainingInput-128で生成を許す。公式の実usageとの完全一致保証は未確認であり、128は安全余裕であって絶対上限保証ではない。実usage超過は保存後に失敗・追加送信停止。

## PGとGoの受け渡し

1. `ax_agent_reserve(run,gen,controller,seq,request_bytes)` は現行認可、stop、root予算、既存未知usageを確認し、残input全額とmin256残outputによるadmission見積を予約する。`{send,response,input_limit,output_limit,profile_id}` を返す。send=falseなら保存済みreply以外を送らない。
2. Goはclaimとprofileを検査し、SDK mailboxをstrictに検査して固定設定へ正規化する。最終payload SHA256は `mailbox SHA256` と別物として保存する。
3. Reserve成功後だけcountTokensを一度送信する。計数失敗/過長/設定欠落で生成未試行が確定していればno_sendで精算する。
4. `ax_agent_authorize_generation(run,gen,controller,seq,payload_sha256,counted_input_tokens)` が現在の認可・stop・期限・count+128<=input_limitを再検査し、同operationのgeneration_startedを一度だけ記録、`{send:true}` を返す。ACK不明、二度目取得は生成せずhold。
5. Goはcontext期限を再確認してgenerateContentを一度だけ送信する。HTTP/client/SDKの再試行0、redirect禁止、環境proxy禁止、固定ホストとTLS検証。countと生成は各25秒以内かつroot残時間以内、レスポンスは本文込み最大64KiB。HTTPエラー本文・資格情報をerror/logへ含めない。
6. `ax_agent_settle(run,gen,controller,seq,response,usage,elapsed_ms,evidence)` は既知usageを失わず記録する。grant取消後も有効claimによる精算・cleanupは可能。evidenceは下記固定shape。ACK不明は再生成しない。
7. Settle後は同mailboxをReserveで再読取りし、send=falseのDB確定replyだけguestへ投入する。SQLが予算超過や提案不正を検出してdeniedへ変換した場合も元の成功replyを送らない。reply ACK不明は保存済みreplyの再投入のみ許しprovider再送はしない。toolは既存Reserve→Settleのまま、Authorize不要。

```text
usage = {prompt_token_count,candidates_token_count,thoughts_token_count,total_token_count,model_call_count}
evidence = {outcome:'ok'|'failed'|'no_send',code:string,
  payload_sha256:string|null,counted_input_tokens:integer|null,count_attempt:0|1,
  http_status:integer|null,finish_reason:string|null,response_sha256:string|null}
```

outcome=no_sendはDBでもgeneration_started=false、usage5項目すべて0必須。known failureはusageを先に検証してからproposal/STOPを評価する。MAX_TOKENS、JSON不正、範囲超過も実usage/実費を記録し、ROLLBACKや追加モデル修正に逃げない。usage欠落、本文不完全、timeout、生成HTTP失敗で有効usage無しは未知として予約を保持しholdする。HTTPエラーを自動的に無課金0と扱わない。

料金はSQLがprofileから再計算する。テキスト入力 $0.25/100万token、出力+思考 $1.50/100万token。implicit cache割引は見込まず保守的に全promptを計上。rawキーやrawerrorは保存しない。成功replyは検査済みtext/usageだけのGemini shapeへ正規化し、TaskのSDKへ1 SSEイベントとして返す。GeminiのthoughtSignatureは会話再構成へ持ち越さず、モデル応答のSHAで受信証拠を残す。reply bodyに `billing:{profile_id,estimated_usd}` を追加し、Pythonはprofileとusageから照合してreceiptへ反映する。旧previewのbilling省略は0として互換維持する。

## 公式根拠と残条件

- [モデル](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite): stable IDとJSON Schema対応。
- [料金](https://ai.google.dev/gemini-api/docs/pricing): 標準テキスト入力0.25、思考を含む出力1.50 USD/100万token。
- [Generate Content](https://ai.google.dev/api/generate-content?hl=en): usageのprompt/candidates/thoughts/total。total=prompt+thoughts+candidates。
- [CountTokens](https://ai.google.dev/api/tokens?hl=en): generateContentRequest全体を受けsystem instructions等も計数する。生成usageとの差の完全保証はない。
- [Thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens): max_output_tokensは思考を含むhard cutoff。minimalは思考0を保証しないのでthinkingBudget:0に依存しない。
- countTokens直接REST自体の料金0の公式明示は未確認。親は生成2回＋事前count各1回の最小実経路確認を既存承認範囲として担当し、失敗時は止めると確定した。0.01 USDは公式生成単価・実usageによる概算停止ガードであり全請求保証ではない。Google側2,000円上限は据え置く。無料とは表現しない。

局所検証: fake HTTPで固定wire/厳密JSON/usage既知失敗/未知/本文上限/redirect/no retry、fake Storeでcount中失効/Authorize ACK不明/Settle ACK不明/期限/保存済みreply再投入、固定SDK image network noneで正規化応答・billing receipt・質問→回答の既存互換を確認する。実AXと実課金は親の別証拠へ引き継ぐ。
