# 実モデル接続の統合レビュー

2026-10-07。担当 `w1_design_review`。基点 `13eb7f118c4bf8af7cdd4d6ae84d27d37f2c42aa`、branch `codex/ax-real-model` の未commit差分を確認した。終了地点は実装・局所証拠の独立レビュー。配備、実AX、モデル送信、請求確認は親が別に担当する。

今回の実モデル追加は担当A/Bと親による実装で、本担当は製品コードを編集していない。同じモデルの別担当によるレビューであり、異なるモデルによる相互検証ではない。以前に本担当が実装したpreview基盤自体を新たな独立レビュー済みとは扱わない。

## 判定

対象差分に追加の必須指摘はない。先行UIレビューのP2は修正とブラウザ回帰により解消した（[ui-review.md](ui-review.md)）。設計レビューの必須条件は今回の契約と実装へ反映されている。

API/PG最終版とGoの確認済み版について、コード上の配備阻止事項は見つからなかった。担当A/Bの最終局所検証も受領し、確認したソースのhashが一致したため、配備前レビューの成果を引き渡せる。実環境の移行・鍵の非注入・最小モデル試験は未確認であり、この判定を実経路合格へ読み替えない。

## 確認した境界

- **受付と所有権。** modeとprofileはrootへ固定され、model開始は明示同意を必要とする。回答APIにmodeを受け入れず、旧previewの省略入力・同key再送を保つ。本人・Workspace・token失効・除籍後の旧grant非復活は既存v4経路を引き継ぐ。新しいmodeを旧有料runの迂回経路として受け入れていない。
- **一回の生成権。** `schema-v5.sql:183` のAuthorizeはcount後に現認可・停止・期限・予算を再検査し、generation_startedを原子的に記録する。Reserveの未精算再取得、Authorizeの二度目・ACK不明で新たな生成を許さない。GoはSettle後にDB確定replyを再読し、replyのACK喪失には保存済みreplyだけを再投入する。
- **既知費用の保持。** `gateway/model.go:227` は有効usageを先に読み、MAX_TOKENS・提案不正・上限超過をusage付きの既知失敗として返す。`schema-v5.sql:209` のSettleはSQL側単価で再計算し、実入力・出力・予約額・試用ガード超過を記録して失敗へ変える。費用のUPDATE後に上限超過例外を投げてROLLBACKする構造ではない。元の成功replyをguestへ送らない。
- **未知の保持と停止。** GenerateのHTTP処理が戻った後のusage不明だけを専用sentinelへ変換する。`controller.go:110` のcleanupはinteractive execute、確定済みstart、同Actor、有効な作業contextに限定される。create/resume/RPC不明やlease失効まで停止権を広げない。PG Finishは未精算operationを最初にholdし、deny・実停止の証拠だけで予約・費用未知を消さない。generation_started後のno_send精算も拒否する。
- **費用の正本と全体枠。** 旧antigravityの記録費用（ownerなしを含む）と新model operationの実費・未精算予約を同じglobal slot下で合算する。新run結果とoperationを二重計上しない。精算済み失敗は確認が済むまで再課金を止め、未知は従来どおり全体枠を保持する。
- **送信・秘密。** 固定provider/profile、textだけの固定wire、candidate数・思考込み出力制限をGatewayが決める。環境proxy、redirect、HTTP自動再試行、SDKの追加生成を許さない。本文は64KiB、通信時間はroot残時間と25秒の短い方。キーはGatewayが専用ファイルから読み、エラーへ値やHTTP本文を載せない。Pythonへは検査済みtext・usage・billingだけを渡す。配備helperのgate既定閉鎖、executionだけへのkey mount、Task鍵非注入の既存patch維持は先行レビューで確認した。
- **互換性と権限。** v1〜v4 SQLに差分なし。v5は旧previewのrun bytes、settled operation、key replay、pending claimを保持する。runtimeへ公開する関数はallowlistで、新規Authorizeをexecutionだけへ追加し、旧v4 helperの直接EXECUTEと表アクセスを閉じる。CIの試験用ax_execution NOLOGIN追加は既存のDB準備ステップ内にあり、秘密や本番権限を追加しない。

## 証拠と対象版

本担当が独立に実行した `mise exec go@1.27.1 -- go test -race ./gateway ./controller ./native ./settings` は成功した。fake HTTP・fake Storeを使う試験であり、実provider・実AX・DBには送信していない。`git diff --check` も成功した。

担当Aの最終報告では、`go test -race ./...` 全package、`go vet ./...`、`go build ./cmd/...` が成功した。固定SDK imageでnetwork noneのinteractive 24件が成功し、hostのPython全138件は成功（うち6件skip）だった。本担当はSDK/Python試験を再実行していない。最後の修正であるReserveの `response:null` 受け入れ、外部Googleのoptional metadata nullを有効usageの破棄にしない読取り、cancel後のcleanup禁止をコード・回帰試験で確認し、上記4packageのraceをこの版で再実行した。内部のDecodeStrictを緩めず、外部DecodeJSONでも重複キー・不正文字列・深さの検査を維持している。

担当BのNode全114件成功、agent PG/API 42件成功、型検査成功を報告と `/tmp/ax-agent-model-node-tests.log` の最終集計で照合した。新しい限定role試験のコードも読み、ax_api/ax_executionの別権限で受付、claim、intent/evidence、Reserve、Authorize、既知失敗／no_send／unknownの精算と終了をCOMMITまで試し、旧helperとAPI/controller越境を拒否する内容を確認した。本担当はPG試験を再実行していない。記録は [verification.md](verification.md)。

| 対象 | SHA256 |
| --- | --- |
| web/data/schema-v5.sql | `a1c37fb0787727acef8f1325dc5e14e4b1e623fb953744a23a1342f3cf6b82e2` |
| execution/gateway/model.go | `c9d6652459bee27911a3803f07b5e2405f06b37be4838daab6a1cad5b61a3091` |
| execution/controller/interactive.go | `3acb73a71ee1f05617978a23cae9b9c72f687908ecc6db156d5013c2238d1210` |
| execution/controller/controller.go | `689568d7ff3a758870ff2d6a1d61bc6a548274519163c27af58fa16508dc6dfc` |
| execution/controller/postgres.go | `ca32cb557c347f86a118f74bb647a6f00d55f906fff6e0afa15ca660e8450ca4` |
| execution/native/protocol.go | `1d736e5c7240bce7f7b561a19362c77f74f8730deca417f7780a18a3263f8f41` |
| ax-local/task_runtime/adapters/interactive.py | `5fba7521d3734a290a5aa935557bf8b0cc33046f3bb8ec74eeadf732e2c9f7bd` |

## 限界と引き継ぎ

countTokensと生成の実usageが完全に一致する保証はない。128tokenの余裕は入場時の見積であり、入力6000や0.01 USDを全請求の絶対上限とする証拠ではない。countTokens自体の無料根拠も未確認である。親はこれを無料と扱わず、既存2,000円上限・既知費用0.00358975 USD・概算停止ガードを維持して、承認済みの最小試験（生成2回と各count1回）を行うと決定済み。[contract.md](contract.md) の確定した限界を引き継ぎ、承認待ちとしては扱わない。

本担当は実モデル、秘密値、稼働DB、Kubernetesを操作していない。実際のprovider互換性、請求側観測、Taskからの鍵非到達、移行後の質問→回答の2区間と停止は親の統合検証の残件。OKFの更新と全体受け入れも親へ引き継ぐ。この報告の保存だけを行った。

## 実モデル証拠の独立照合

親が実施した2026-10-07 09:54〜09:55 UTCの初回試験について、Git対象外の `ax-local/.state/verification/interactive-2026-10-07T09-54-41-574Z-00709e15/` にあるresult.json、ledger.json、stopped.jsonl、closed.jsonと、reply.txtのbytes・hash・必要語句を読み取りで照合した。会話本文・秘密値・原証拠は公開記録へコピーしていない。対象5ファイルは `git check-ignore` でも除外対象だった。

- rootはmodel・succeeded、runは別IDの2件。ブラウザ記録はstart 1回、answer 1回、質問のreload保持、他人の非表示と成果物404、ブラウザerror 0、未想定送信0。
- 台帳のmodel operationは2件ともgeneration_started・settled ok、HTTP 200／STOP、各count_attempt 1。inputは958＋1047＝2005、outputは26＋64＝90、thoughtは0、toolは2、activeは18,239ms。各runのreceipt usageとoperation usageも一致した。
- 公開生成単価をDecimalで再計算し、0.00027850＋0.00035775＝**0.00063625 USD**がoperationの記録費用・run結果の概算と一致した。既に報告されていた過去分0.00358975 USDを加えると**0.00422600 USD**。過去の全台帳は今回再取得していない。
- 2件ともPG resolved、suspended／egress_denied true。別inspect記録のTask Suspended、Actor停止、worker未割当、通信遮断、各観測済みの項目がすべてtrueで、run IDも一致した。
- 成果物は200 bytes、SHA256 `ef04ba4921815b6f327d418d337a99ecca2b487fd26b2e6b2d9032a233af4a37`。保存bytesから独立に再計算して一致した。依頼の日時・会議名を含み、回答入力の単純転記ではないことも本文を転記せず確認した。
- closed.jsonはmodel_send_enabled=false、gateway_key_mounted=false、Ready=true、old_enabled_pod_absent=true。試験後の有料Gateway閉鎖に関する親の記録と一致した。

result.jsonのserver_paid_usage_verified=falseはブラウザ単独では課金・停止を証明しないというhelperの意図と一致し、今回の別ledger／inspectがその範囲を補完する。artifact_matches_answer=falseはpreviewの単純転記確認の項目で、model用artifact_matches_request_and_answer=trueと矛盾しない。

追加の必須指摘はない。上段で未確認とした実モデル往復・記録費用・停止について、保存証拠との独立照合まで完了した。実際の課金明細、provider側の総リクエスト数、countTokens自体の料金、実Task内の秘密探索、試験後previewの新規実行はこの照合の対象外。再試行0は送信実装と台帳・ブラウザ記録の範囲であり、providerの請求画面を独立確認した意味ではない。稼働状態を本担当が再取得・変更したわけではなく、親の保存した観測証拠を確認した判定である。
