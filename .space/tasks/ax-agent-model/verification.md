# 実モデル接続の検証

対象はmain `13eb7f1`からの`codex/ax-real-model`差分。実モデル呼出を伴う確認は、局所試験と独立レビュー後に別途行う。

## 親の局所確認

- Web型検査・製品build成功。
- 対話のブラウザ試験6件成功。無料previewの質問→回答→成果物、他人への非公開、320px表示とaxe対象違反0、受付応答喪失、停止・ログアウト、hydration前入力、CSRF失敗時の保持を確認。追加のmodel同意・料金表示・root中のmode固定、JavaScript無効時のmodel未同意拒否とpreviewの開始も確認した。
- ブラウザのmodelはfixtureであり、料金を発生させる外部送信や実AXの成功証拠ではない。
- UI独立レビューで、JS無効時に無料previewにも有料同意checkboxのHTML検証が効くP2を指摘された。条件付きrequiredを除き、BFFによるmodel時同意検証を正本として修正し、上記のJS無効試験で確認した。
- 配備/実操作helperの単独型検査は、最初のNodeNext指定では既存拡張子なしimportの設定不一致で失敗。プロジェクトと同じbundler解決へそろえた検査は成功。
- 追加の有料受付ACK喪失ブラウザ試験1件も成功。fixtureで受付後503を返し、再読込後もroot・本人メッセージ1件・料金1区間分を保持し、modeの変更UIがないことを確認した。合計7件。

## 稼働環境の準備

親が受付を閉じ、未解決/invalid 0件、実行枠が空であることを確認した。v5適用前のapp DBをGit対象外の `ax-local/.state/model-backup-20261007/app-before-v5.dump` にmode600で保存した（251,928 bytes）。稼働DBの移行、モデル呼出はこの時点では未実施。

この時点ではモデル通信の稼働確認、最終レビュー、納品は未完了だった。以降に実施結果を追記する。

## 保存・API担当の局所確認

担当Bの最終Node全114件、型検査、差分検査が成功。専用DBの一意schemaを使い、通常のapp DBには変更しなかった。PG/APIのagent 42件には、同意・mode不変、生成直前の取消・失効、生成権一回、既知usage超過/不正提案でも費用を保存、unknown保留、旧有料費用の合算、旧v4のrequest bytes保持・同key再送・pending claim、限定API/controllerロールの実COMMITと旧helperへの直接アクセス拒否を含む。

Node全体の初回は112/114件で、追加試験ハーネスの接続passwordコピーとSET ROLE権限経路の不足2件を検出。専用DB内の既存admin→限定ロール経路へ修正後に全114件が成功した。CIも試験用ax_execution NOLOGINを準備する。

v5の検証済みSHA256は `a1c37fb0787727acef8f1325dc5e14e4b1e623fb953744a23a1342f3cf6b82e2`。親がdigestとv1〜v4無変更を照合した。元ログは `/tmp/ax-agent-model-node-tests.log`。

## 稼働DBの移行

保存・API側の独立レビューで必須指摘なしを確認後、受付閉鎖・未解決0・backup済みのapp DBへv5を適用し、限定runtimeロールを再設定した。保存されたv5 digestと上記の最終候補が一致。旧rootはすべてpreview、受付は閉じたまま。モデル呼出はまだ行っていない。

## Gateway・SDKと独立レビュー

担当AがGo全packageのrace・vet・build、Python host138件（実SDK無し6件skip）、固定SDK image `sha256:1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5` のnetwork noneで対話24件を確認した。

初回SDK試験はbillingを加えたreply bodyが既存の厳格検査で拒否され1件失敗。固定shapeの任意billingを検証するよう修正後、24件すべて成功した。生成HTTP終了後のusage未知でActorが残るケース、Reserveのresponse:nullを誤拒否するケースもRedを確認してから修正し、同じ条件が成功した。未知の費用予約は解放せず、開始確認済み・有効claimの対話Taskだけを停止する。

[統合レビュー](integration-review.md)で追加の必須指摘なし。独立担当もgateway/controller/native/settingsのraceと差分を確認した。

## 実モデルの往復

2026-10-07 09:54〜09:55 UTC。実Keycloak・ブラウザ・app PG・AXで初回成功。root `866df523-bb3c-4e10-989f-37e8be7d158a`。実モデルはGemini 3.1 Flash-Lite、model生成2回・count各1回・API再試行0。runner digest `d91ff58c268fd2dde8138027a37317b708dbf9a8bbf4aa00565bedfeaabbc4bd`、execution digest `cf5775c1bc8720cce9376fdd2acc0d9c5628505e70d4c5c2cefb15dddd65cc49`。

| 確認 | 実測 |
| --- | --- |
| 対話と成果物 | 会議案内の依頼→日時の質問→10月8日15時・30分の開発定例という回答→日時と会議名を含む200 bytesの案内文。入力の単純転記ではない |
| 区間 | 質問 `ax-run-1db76cbf049931bd`、回答 `ax-run-5ad020523b9346e9` の新Task2件 |
| 質問区間usage | input958、output26、thought0。count958と一致、概算0.00027850 USD |
| 回答区間usage | input1047、output64、thought0。count1047と一致、概算0.00035775 USD |
| 合算 | input2005、output90、model2/tool2、実作業18,239ms。今回概算0.00063625 USD、過去分込み0.00422600 USD |
| 成功と停止 | 2件ともPG resolved・cleanup一致。独立inspectもTask Suspended・Actor stopped・worker未割当・egress denyの全項目true |
| 鍵の配置 | Pod読戻しでGateway鍵はexecutionのみmount、AX側mountなし。対話Taskは鍵なし専用templateを開始前にGoとAXで照合する経路を通過。課金鍵をTaskへ渡す旧adapterへ切り替えていない |
| 本人限定 | Bobには会話非表示・成果物404。ブラウザerror0・未想定送信0。再読込後の質問保持と成果物download一致 |
| 成果物hash | `ef04ba4921815b6f327d418d337a99ecca2b487fd26b2e6b2d9032a233af4a37` |

私有証拠はGit対象外 `ax-local/.state/verification/interactive-2026-10-07T09-54-41-574Z-00709e15/` のresult.json・ledger.json・stopped.jsonl・reply.txt・completed.png。スクリーンショットを目視し、会話・料金・完了とdownloadが読めることを確認した。sidebarは意図的にマスクしている。DADSのタイポグラフィ・ラジオ・チェックボックス資料を参照したが、完全適合の保証とはしない。

試験後は受付を一時閉鎖し、未解決0で`model_gateway.enabled=false`へ再配置。旧有効Pod不存在、新Pod `ax-server-f7b846fbb-bb5fj` Ready、Gateway鍵のmountなしを読み戻した（closed.json）。無料preview等の受付は再開し、有料の対話Gatewayは閉じたまま。料金は公開生成単価からの概算であり、countTokens固有の無料や円建て請求額を検証したとはしない。

## 有料送信を閉じた後のpreview回帰

実Keycloak・Web・AXの無料previewで質問→再読込→回答→成果物を再確認し、成功した。root `9e5b2951-d82e-41cf-ab0b-ed19af9c50cd`、2区間とも費用0・PG resolved・cleanup正常。独立inspectでも全停止項目true、別ユーザーの成果物取得404、ブラウザerror0。私有証拠は `ax-local/.state/verification/interactive-2026-10-07T09-58-53-313Z-9c963ce6/`。全体の概算は0.00422600 USDのまま増えておらず、未解決0を確認した。
