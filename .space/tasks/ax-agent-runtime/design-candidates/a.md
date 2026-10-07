# 候補A：Task内のagent loopと、信頼された連携broker

2026-10-07。対象main `a682948be9daddc37555067fd98475eb3938b427`。D1–D5は親の `../task.md` を共通条件として引き継ぐ。独立候補であり、未採用・未実装。他候補は参照していない。コード・DB・環境・モデルへの操作は行っていない。

## 1. 利用例と設計の中心

利用者がWorkspaceを選び「自分が見られる社内資料から月次売上を整理し、Pythonで集計、担当者向けの更新案を作って」と依頼する。画面には調査中・集計中・確認待ち・終了と成果物を表示する。資料の対象期間を尋ねられたら回答し、外部更新は対象・差分を見て承認する。ブラウザを閉じても受付と状態は残る。

判断とtool選択を繰り返すagent loopは、実行ごとのTask内Pythonに置く。本人性・接続先権限・秘密・モデル費用・外部操作の送信権はTaskの外に置く。任意コードはagent loopとも別のTaskで動かす。既存の共通APIをPythonやKubernetesへ再結合しない。

## 2. 現状との違いと根拠

- 現SDK設定は `write_output` のみ、subagents無効、builtin tools空、3 model / 2 tool calls。`Agent.chat`を一度呼び、usageとreceiptを同guest内で作る（`ax-local/task_runtime/adapters/antigravity.py:64–130`）。SDK 0.1.20固定（`ax-local/versions.json:11`）。汎用agent製品が完成している状態ではない。
- runnerはstage/startの排他marker、90秒制限、子process終了後の成果物・usage検査を持つが、途中質問・承認・checkpointの契約はない（`ax-local/task_runtime/runner.py:20,75–112,166–217`）。入力合計4096 bytes、成果物1件64KiB（`ax-local/task_runtime/protocol.py:8–20`）。
- TaskはAXの実行リソースであり通常Podと同義ではない。現配置はgVisor、AX/controllerは同一Pod、guest接続はcontrollerからの直接mTLS（`ax-local/README.md:3`、`execution/README.md:9–11`）。AXの公開RPCはTaskのcreate/get/watch/resume/suspend等で、業務認可やagent loopは持たない（`ax-local/.sources/ax/pkg/apis/v1alpha1/ax.proto:24–49`）。
- suspend/resumeはプロセス継続ではなく、保存volumeを新しいprocess treeへ復元する（`ax-local/.sources/ax/docs/runner.md:26–45`）。既存recoverは再開始せず、unknownや不明intentを保留する（`execution/README.md:67–88`）。
- モデル鍵がActorTemplate envに残り、確認済egressはHTTP/HTTPSだけ。任意コードを同guestへ置けば鍵・meter・receiptの信頼を保てない（`ax-local/README.md:57–61`）。この変更はtoolsの有効化だけでは成立しない。
- 現在の開始側DB関数は利用者・Workspace所属を再確認し、cleanupを妨げない（`web/data/schema-v2.sql:232–252`）。これを全broker呼出しと継続受付へ広げる。

## 3. 責務とデータの正本

| 要素 | 所有する責務・保存 | 持たせない権限 |
| --- | --- | --- |
| BFF / 共通API | 認証、現在の所属と本人owner確認、依頼・回答・承認・停止の受付、状態取得 | SDK、AX操作、外部資格情報 |
| app PostgreSQL | agent job、各runとの関係、順序付きevent、checkpoint、grant、approval、外部operation台帳、成果物参照 | 秘密の平文、実処理なしの成功宣言 |
| Go controller | jobの排他取得、各Taskの一度だけの開始、回収、通信遮断・Actor実停止の証拠 | 業務ツールの選択、利用者権限の拡張 |
| Task内agent runtime | 会話・スキルを入力に計画、model/tool呼出し、質問、構造化checkpoint・成果物の提案 | DB管理、接続先token、usage/認可の自己申告による確定 |
| 信頼されたbroker | runに結び付く認可、model gatewayと費用台帳、社内API/MCP/RAGの実呼出し、照合・監査 | モデルの指示による接続先や権限の自動追加 |
| code Task | 明示入力に対するPython等の計算、制限付き作業領域と出力 | broker capability、モデル鍵、社内接続、DB/cluster token |

brokerは一つの製品責務として始めるが、model gateway・connector処理・認可を内部モジュールに分ける。stdio MCPが必要なら、選定済みconnector専用workerで起動し、APIプロセスやagent Taskで任意サーバーを起動しない。

## 4. 小さな契約の骨組み

```text
POST /v1/agent-jobs {key, workspace_id, conversation_id?, text, skill_version_ids, connection_ids}
GET  /v1/agent-jobs/:id/events?after=<sequence>  -> {events,next,state}
POST /v1/agent-jobs/:id/responses {key, question_id, revision, answer}
POST /v1/agent-jobs/:id/approvals {key, approval_id, arguments_hash, decision}
POST /v1/agent-jobs/:id/stop {key}
POST /v1/agent-jobs/:id/continue {key, checkpoint_id, revision}
broker.invoke(capability, {operation_id, tool_version, arguments}) -> confirmed | denied | unknown
model.generate(capability, {call_id, model_profile, messages, tool_schemas, limit}) -> output + usage
```

`agent_jobs(id,owner_user_id,workspace_id,state,revision,budget)`が利用者の依頼を表し、`agent_segments(job_id,run_id,kind,checkpoint_id)`が各実行を結ぶ。既存runは1実行1Taskを保つ。状態・event・受付keyはPGで原子的に保存し、同key異内容は拒否する。ACK喪失後は同じoperationの記録取得を行い、再送権は返さない。

checkpointはSDK objectやpickleではなく、version・入力/スキルdigest・会話/tool結果への参照・次の処理・既存operation ID・残予算を持つ検査可能なデータ。スクリプトやモデル出力は信頼しない。成果物はcontrollerがbyte上限/hashを検証して保存し、guestが書いたusageや`resolved=true`では費用・成功を確定しない。

## 5. スキル、subagent、Python、モデル交換

- スキルは不変versionとdigestを持つinstruction・宣言tool・依存物のbundle。公開範囲と利用権を分け、選択可能なスキルでも接続先権限は増えない。実行中の自動更新、未確認install script、任意MCP URLの追加はしない。DBには選択versionを保存する。
- subagentはまず同Task内の逐次呼出しとし、役割・限定context・回数を分ける。これはOS隔離ではなく同じ信頼領域内の協力単位である。親予算を共有し、spawnで回数/費用上限が復活しない。より強い権限を持つsubagentや実並列は初期範囲に含めない。
- 任意Pythonは別のcode Taskへ渡す。親loopはcheckpointを保存して通信遮断・停止を確定し、code Taskを直列実行する。コード終了・回収・停止を確認して、新run/Taskのloopに結果を戻す。全体同時実行枠1を維持するため、親Taskを動かしたまま子Taskを増やさない。
- code Taskには必要な入力bytesだけを渡す。信頼済image、資源・時間・process数・出力上限、制御系mountなし、外部通信禁止を要求する。gVisorという名称だけで保証せず、DNS/TCP/UDP/metadata/cluster宛を含む拒否を試験する。現egress機構で満たせなければ任意コードの工程を公開しない。
- model adapterは中立なmessage/tool schema、usage、finish reason、error分類の変換に限定する。各providerの課金結果・再送・cancel差は残す。モデル秘密と費用予約/実測をbrokerへ移し、全segment/subagentで残予算を共有する。未知usageは既存どおり全体holdとする。
- 3 model / 2 tool / 90秒では本利用例は一般に収まらない。既存値と2,000円条件を初期上限として保持し、不足は「予算/処理上限で停止」と返す。長期化や上限変更は別判断とし、segment分割で制限を迂回しない。

## 6. 本人性・委任・失効と連携

本人は内部user UUID、所属はWorkspace/Group、業務roleとadmin/memberは別属性、接続先のsubject/scopes/ACLも別管理にする。実効許可は「有効なuser・現在のWorkspace所属・明示したアプリpolicy・今回grant・接続先本人権限」の共通部分。業務roleやWorkspace ownerというだけでは他人の履歴や社内データを読ませない。

受付時に固定するのは依頼者と最大委任範囲で、現在権限のsnapshotを永久の許可にしない。brokerは毎回user/所属/Group条件/grant状態/期限/approvalを再確認する。接続先は利用者本人のOAuth grant、または本人別ACLを正確に強制できる専用connectorを使用する。広い共有service accountへ黙ってfallbackしない。

Taskにはcontrollerが発行する短命・audience限定・run/generation限定capabilityだけを渡し、brokerはその識別子からownerとWorkspaceを引く。Task自己申告のuser IDやroleは使わない。外部refresh token等はbroker限定の暗号化secret storeに置き、Webセッションの生token・モデル鍵をTask/ActorTemplateへ配らない。旧snapshotに残った鍵を新runtimeへ再利用しない移行・失効手順が必要。

Group除籍・利用者停止・接続解除・明示停止でgrantを無効にし、次のmodel/tool送信とcontinuationを拒否する。復帰・再加入でも旧grantを復活させない。ブラウザ切断は取消としない。ログアウト時のrun委任も取消す案を既定とし、セッション失効との製品方針は確定が必要。処理中に既に送った外部更新の取消完了までは保証しない。deny/suspend/照合・回収はサービス権限で続行する。

MCPはbrokerが承認済serverのclientになる。HTTP MCPの宛先ごとのtoken検証とtoken passthrough禁止は[公式2025-11-25認可仕様](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)に従う。MCP対応だけで本人ACLや冪等性が揃うとは扱わない。tool一覧/descriptionも未信頼データとして扱い、既知versionのschema・対象・許可操作に限定する。任意URL、redirect、DNS経由の内部宛接続もbrokerで制限する。

RAGはconnectorがsource ACL・tenant・document/version・削除情報を索引へ保持し、検索時の候補絞込みと返却前の現在ACL確認を行う。権限不明・索引同期不明は返さない。引用・checkpoint・派生物にsource参照を付け、継続時の再利用前にも確認する。応答を受け取った後の権限剥奪で既に見た情報を回収できるとは主張しない。

## 7. 途中質問、停止、再開、外部副作用

| 状態・操作 | 保存と進行条件 |
| --- | --- |
| queued / running | 受付とeventをPGへ保存。Webはcursor付き再取得、必要ならSSEを補助にする。接続の寿命をjobの寿命にしない |
| pausing → awaiting_input / awaiting_approval | 質問または更新案・引数hash・checkpointを保存し、model/tool inflightがなくusage既知、egress deny・Actor実停止が揃ってから待機を確定。停止まで全体枠を保持する |
| 回答・承認 | 本人ownerと現在所属、question/approvalのrevisionを検証し一度だけ受理。対象や引数が変われば承認無効。新segmentが新run/Taskとして残予算から継続する |
| stop_requested → stopped | 新たな送信をbrokerで遮断しcontrollerが停止。操作返却時は「停止受付」で、停止証拠未取得を「停止済み」にしない |
| succeeded / failed | usage、成果物検査、通信遮断と実停止、外部operationの結果を合わせて判定。出力が生成されたことと社内更新が成功したことを別表示する |
| needs_recovery / unknown_external_effect | 期限切れで自動takeoverしない。既存recoverは照合とcleanupだけを行い、開始・未確定更新を再送しない。根拠が揃うまで全体holdとする |

安全な待機状態は実行slotを解放できるが、jobの累積予算・承認・未完了状態はPGに残す。回答後の継続は通常の新規受付として現在権限・残予算・全体枠を再確認する。checkpoint未保存・未知usage・送信中のまま落ちた場合は安全な待機とみなさない。

brokerは外部更新の前に `(job_id, operation_id, normalized_arguments_hash, principal, grant, approval)` を台帳へ確定し、送信権を一度だけ得る。外部のidempotency keyと照会APIがあれば保存済IDで照合する。応答だけ失われた場合はunknownにし、対応機能がない接続先へ自動再送しない。書込み後の補償も別の明示operationであり、rollback済みと推測しない。

監査は依頼者、実行主体、Workspace、tool/skill version、認可判断、承認、対象ID、入力hash、送信・結果・照合の時刻を記録する。秘密・raw token・内部思考全文は記録しない。監査閲覧権をチャットの所有権と混同せず、本文を管理者へ自動公開しない。

## 8. 利点・負担と合理的な代替

Task内loopなら既存Python SDKとスキルの実行環境を活かし、モデルproviderをAPIから切り離せる。brokerに秘密と判定を集約すると、prompt injectionやTask侵害がそのまま無制限の社内権限にならない。

負担はbrokerの高信頼化、SDK非依存checkpoint、code Taskへの切替回数と起動時間、provider別計測、ACL同期である。これは既存adapterの小改修ではなく新runtimeと新操作契約の追加である。

同一guestの制限付きsubprocessは速いが、secret・計測・broker capabilityからの隔離根拠が現版にはないため初期案から外す。信頼側サービスにloopを置きTaskをコード実行だけにする代替はcheckpoint/連携を単純化し得る一方、SDKと会話状態が常駐サービスへ移る。候補AではTask環境の再利用を選ぶが、この構造差を親の比較対象に残す。

## 9. 段階実装と判定ゲート

1. v2 runtime/DB契約：既存chat/runを保持し、新agent job、event、checkpoint、途中質問、停止受付、直列segmentをoffline adapterで実装。切断・二重回答・再起動・checkpoint喪失・旧ownerなし非公開を検証する。
2. broker：模擬modelと社内read API一つでgrant、呼出し毎の失効、別Workspace/Group・adminによる越権拒否、usage改ざん/応答喪失・二重送信拒否を検証。新Taskへ長期秘密が渡らないことを確認する。
3. skills/subagent/code Task：固定skillを選択し、逐次subagentとPython計算を追加。累積予算・全体枠1・停止境界・資源制限・全通信拒否が合格してから任意コードを公開する。既存guest内meterを費用の正本に残さない。
4. 社内更新/MCP/RAG：承認対象の改変、更新成功後の応答喪失、取消との競合、ACL剥奪・削除・索引遅延・別tenantの混入、悪意あるtool結果を試験する。実接続は接続先仕様と権限を確定してから行う。
5. provider追加/長時間化は別unit。paid試験は今回0、後続も既存費用条件内で最小件数。既存v1に影響しない段階導入とし、未知の新jobを旧runtimeへfallbackしない。

未確定：最初の社内接続先とOAuth/ACL/冪等性対応、スキル登録の信頼・公開範囲、実用的な累積上限、ログアウト失効方針、gVisor/ネットワークによるcode Task完全遮断、SDK checkpoint互換、外部ACLの失効遅延と既取得派生物の閲覧方針。前半のoffline設計実装は進められるが、任意コード・外部更新の公開は各ゲートを満たすまで進めない。

照合結果：D1は2/3/5節、D2は4/7節、D3は6節、D4は5/6/7節、D5の候補・段階案は8/9節で扱った。根拠は静的読取と公式仕様であり実動作未検証。rule/principleと既存OKFは親の確認を再利用し、追加でruntime/controllerのパス検索を実施した。比較・統合・独立レビューとOKF更新は親へ渡す。
