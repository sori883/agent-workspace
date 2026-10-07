# 最初の対話経路の実装契約

2026-10-07、利用者がレビュー後の実装を依頼した。設計Aを再利用し、SDK保存継続と一段ずつの型付き提案を比較した。実SDKの無課金probeで、tools空・response_schemaなし・retryなしの通常JSON返答を2プロセスで各1モデル要求・正常終了できたため、初期は後者を採る。SDK内部DBの移植は初期に不要。確認済み会話と操作の正本から毎区間の入力を再構成する。

## 初期の範囲

新しい対話経路は明示した無課金preview。外側providerは固定の模擬応答を返す。既存の通常チャットと旧履歴を維持し、previewを実モデルの推論として表示しない。新SDK経路に有料providerを接続するのは、この経路の確認後の作業とする。

依頼→質問1件→通信遮断・実停止→本人の回答1回→固定スキルと固定toolの小さい本文成果物。直接成果物/未対応の説明も許す。初期は最大2区間。root全体3モデル要求・2固定tool、入力6000/output512 tokens、実作業90秒、待機期限と現在所属を別に検査する。SDKは操作を提案するだけで、独自SDK toolを実行しない。各区間にSDKモデル要求1回、固定tool1回まで。SDK再作成でroot予算はリセットしない。

## 所有と依存

- w1_design_a：ax-local/task_runtime、固定スキル、対応Pythonテスト。SDK/loopback/mailbox/固定tool。
- w1_design_b：web/data・server/data-migrate・shared・api・必要なserver認証/DBテスト。root/区間/operationとAPI契約。既存台帳・本人限定・費用guardを維持。
- w1_design_review：executionとAX注入禁止patch（ax-local/patches）。mailbox仲介、外部gateway、Go検証。今回の実装作成者なので、この差分の独立レビューは他担当へ渡す。
- 親：画面/BFF、配置・実環境検証、統合契約と文書、最終受け入れ。共有DB/稼働環境を変更するのは親だけ。

同じcheckoutを使い、他担当の変更を戻さない。共通契約の変更は親へ先に連絡。納品は利用経路が通る一つの変更単位へまとめる。

## runner protocol

既存schema_version=1の6fieldsは維持し、新adapter名を `interactive` とする。output_nameはreply.txt。inputsはconversation.json（確認済み会話JSON）とruntime.json（下記JSON文字列）。instructionは現在の依頼/回答本文。

```json
{"version":1,"root_id":"uuid","phase":"request","question_id":null,"skill_id":"brief-v1","remaining_ms":90000}
```

answer区間ではphase=answer、question_id=root_id。root_idはDBが決め、ユーザー入力やモデル提案で本人/所属を変えない。skill_idは初期一種類、image内SKILL.mdの固定版。モデルへの指示に取り込み、選択版を台帳へ保存する。

モデル提案は厳密な `{kind: question|output|unsupported, text: string}`。textは空白のみ不可、UTF-8最大2048bytes。answerで再質問は拒否する。reply.txtはtextだけとし、checkpoint/control JSONをチャットへ出さない。最終返信を初期の小成果物と兼用する。

## mailboxとGateway

Taskのegressはdenyのまま。SDKのloopback proxyがmodel要求をmailboxへ保存し、controllerが既存mTLS固定runner RPCで受信する。GatewayはGo内のモジュールとし、公開HTTPサービスを増やさない。Taskへ鍵・DB資格情報を渡さない。

`mailbox <run_id>` は未応答要求を読む。要求なしはnull。要求は `{version:1,run_id,sequence:1|2,kind:model|tool,body:object}`。model=1、tool=2。model bodyはSDKのGemini JSON本文、tool bodyは検証済み提案。wire全体はUTF-8 64KiB以下、JSONの重複キーを拒否する。

`reply <base64-json>` は `{version:1,run_id,sequence,request_sha256,status:ok|denied,body:object}` を受け取る。同要求・同応答だけ再投入可能。異なるhash/本文は拒否。request_sha256はmailboxに保存した元JSON bytesのSHA256とし、取得時は元bytesもbase64で返す（`{request_base64,sha256}`）。応答は64KiB以下。ACKが不明でもモデルを再送せず、DBに確定済みの同じ応答だけを照合する。

model成功bodyは `{response: <Gemini response JSON>}`。loopback proxyがSSE1件へ変換する。provider/宛先/モデルは外側で固定し、任意URL/headerを受け付けない。tool成功bodyは `{accepted:true}`。toolの許可・予約と成果物確定は別であり、書込み前のクラッシュを成功にしない。

PGはrun/claim世代からroot・本人・所属を解決する。各model/tool前に原子的な予算予約と送信権を取得し、応答/usageを保存してからguestへ投入する。model/toolの同ID異本文、使用量不明、古いclaim、失効、停止要求を拒否する。SDK receiptはGatewayの保存済みusageと照合する。

## 保存と開始・終了

既存ax_runsは有限の区間として再利用。ax_agent_rootsと区間/operation台帳を追加し、旧会話には依頼→質問と回答→結果を通常の2turnとして保存する。回答待ちrootは未解決旧runとして残さない。停止・usage・成果物とtool提案の一致が確定した時だけrootをwaiting_input/succeededへ移し、全体枠を解放する。旧recoverは開始再送へ転用しない。

新しい論理atespaceはax-runtime。初期の実行先は既存ax-demoの信頼済みWorkerPoolを共有する。固定Substrateはatespaceからworker namespaceを制約しないため、専用poolを追加する方式は実経路で成立しなかった。pool labelと全旧templateのselector移行を加える案と比較し、固定tool previewでは共有poolを採用した。guest証明書は実workerのax-demo identityを厳密に照合し、Actor宛先はax-runtime/run_idへ束縛する。pool別の隔離を保証する設計ではない。管理者設定でこのatespaceのAXモデル鍵注入とdefault template fallbackを禁止する固定patchを用意する。旧ax-demoとその履歴・Secretは維持する。各新segmentは新Task、旧snapshotを復元しない。create/resumeの前提とtemplate実体を確認する。

本人/Workspaceの回答、question_id、expected_revision、冪等keyをDBで束縛する。同キー同本文は同じ結果、内容違い・別キー二重回答・古いrevisionは競合。旧chat submitから新rootを迂回して続けることは拒否する。明示停止は新しい送信を止め、cleanupを妨げない。

## 確認する順序

1. SDK提案契約、Python mailboxと固定tool、PG同時受付と予算/失効/不明、Go仲介と再送禁止を局所検証。
2. 実PostgreSQLと実SDKの無課金経路を統合し、保存ACK喪失・二重回答・上限・途中停止を確認。
3. 実AXで鍵なしTask、起動前0要求、質問→実停止→新Task回答、usage/成果物照合、global1、停止/回収時間を確認。
4. 実画面で本人限定の履歴・回答待ち・二重送信・再接続・小成果物を確認し、旧チャット/旧履歴も回帰確認。
5. 作成者以外のレビュー、必要修正、知識更新の後、同じまとまりでPRにする。

実装と局所検証は揃い、実環境の確認・補正を継続している。条件別の結果は [verification.md](verification.md) を参照する。
