---
type: decision
title: AX Task内の対話型ランタイムと外部の制御基盤
description: AX内Runtimeと外部制御、登録スキルのファイル原本・認可・停止の実装、後続Deep Agents移行の境界
status: draft
governance: context
code_refs: 
  - web/api/
  - execution/
  - ax-local/task_runtime/
  - ax-local/runner/Dockerfile
  - web/data/schema-v5.sql
  - web/app/routes/agent.tsx
  - web/data/schema-v7.sql
  - web/data/schema-v8.sql
  - ax-local/code_runtime/
  - web/app/routes/workbench.tsx
  - web/app/routes/library.tsx
  - web/data/schema-v9.sql
  - web/app/components/skill-composer.tsx
  - web/data/schema-v10.sql
  - web/data/schema-v11.sql
  - web/data/skill-storage.ts
  - web/shared/skill-storage-contracts.ts
  - ax-local/object-storage/
sources: 
  - resource: docs/agent-runtime-design.md
  - resource: .space/tasks/ax-agent-runtime/task.md
  - resource: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
  - resource: https://www.rfc-editor.org/rfc/rfc8693.html
  - resource: https://mise.jdx.dev/dev-tools/
  - resource: https://mise.jdx.dev/security.html
  - resource: .space/tasks/ax-agent-runtime/reviews/external-2026-10-07.txt
  - resource: .space/tasks/ax-agent-runtime/spike/README.md
  - resource: .space/tasks/ax-agent-runtime/implementation.md
  - resource: .space/tasks/ax-agent-runtime/verification.md
  - resource: .space/tasks/ax-agent-model/contract.md
  - resource: .space/tasks/ax-agent-model/verification.md
  - resource: .space/tasks/ax-agent-model/integration-review.md
  - resource: .space/tasks/ax-agent-workbench/task.md
  - resource: .space/tasks/ax-agent-workbench/evidence/paid-trial4.json
  - resource: .space/tasks/ax-agent-workbench/general-agent-ui.md
  - resource: .space/tasks/ax-agent-workbench/automatic-skills-contract.md
  - resource: .space/tasks/ax-agent-workbench/automatic-skills.md
  - resource: .space/tasks/ax-deep-agents/task.md
  - resource: .space/tasks/ax-deep-agents/plan.md
  - resource: https://docs.langchain.com/oss/python/deepagents/skills
  - resource: https://docs.langchain.com/oss/python/langgraph/checkpointers
  - resource: https://docs.langchain.com/oss/python/langgraph/interrupts
  - resource: .space/tasks/ax-deep-agents/skill-storage-design.md
  - resource: .space/tasks/ax-deep-agents/verification.md
  - resource: .space/tasks/ax-deep-agents/evidence/storage-local.json
generated: 
  by: agent:codex
  at: 2026-10-08T14:22:23.415Z
---
# AX Task内の対話型ランタイムと外部の制御基盤

## Deep Agentsへの移行方針（2026-10-08、採用済み・未実装）

利用者は複数社のモデルを使える基盤の選定を求め、Python版Deep Agentsの採用と、その後に提示した管理・保存・AX実行の構成を了承した。続けてタスク分解を依頼した。現行実装はAntigravity SDKと自作の区間制御のままであり、計画作成を新runtimeの実装・配備済みとは扱わない。基点は `498abb96d7405c78985a35a32f15262e75f15ba8`。

Deep Agents案とPydanticAI案を独立に具体化し、第三の担当も比較した。スキル概要・本文・補助資料の段階読込、文脈管理、複数段階の作業を既存機能から再利用しやすいことを理由にDeep Agentsを選んだ。PydanticAIは短命Taskとの引継ぎが明示的だが、今回の要件では資源取得等の組立範囲が増える。厳密な「Taskごとにモデル1回」は新設計の目的ではなく、Task内で能動的な処理を進め、待機前に保存・終了する構成へ移す。費用・回数・時間・権限の上限を広げる承認ではない。

- 共通APIはTypeScript/Honoを継続し、ホストにPythonを要求しない。AXの実行管理と費用GatewayはGo、唯一の推論・道具選択ループはAX Task内のPython/Deep Agentsへ集める。サブエージェントは有効にしない。
- 会話→依頼→Taskを区別する。一依頼のcheckpoint threadとpending writes、操作要求・結果・実行世代をapp PostgreSQLへ保存し、同じ依頼の新Taskで復元する。利用者向け会話・権限・費用の正本とSDKの復元状態は役割を分ける。TaskにDB資格情報を渡さず、依頼限定の内部窓口で読み書きする。
- 回答待ち・隔離コードの作業待ちでは、状態と作業要求の関係を保存してから推論Taskを終了する。旧Taskの実停止と古い世代の拒否を確認して再開する。結果の先着・重複通知・障害による再実行を扱い、結果不明のモデル／外部操作を自動再送しない。
- 生成Pythonは別の隔離Taskへ渡す。要約等を含む全モデル要求はGo Gatewayを通し、APIキー・外部資格情報は管理側に保持する。現在のGemini専用接続は複数providerとtool call/usageを扱う契約へ変更する必要がある。
- 組み込みskillと標準promptはGit管理したimage内ファイルを継続する。画面登録をPostgreSQL本文から適応する当初案は、後段の追加設計により、ファイル原本とPGの管理情報へ分離する方針へ見直した。認可済みの不変版だけを読める形へ適応し、実行のruntime/framework/prompt/skill版を固定する。再開可能期間は対応版を保持する。共有定義と本人限定の会話・入力・結果を分離する。
- PostgreSQLはKubernetes内外の配置を選べる。登録スキルのファイル保存は追加設計として移行範囲へ含め、大きな入力・成果物のobject storage移行、MCP・社内API・RAG・GitHub、定期実行は後続機能。外部連携の最終認可は接続先でも行い、秘密情報をprompt/checkpoint/成果物へ入れない。

計画は `.space/tasks/ax-deep-agents/task.md` と `plan.md`。移行の7単位、依存、所有範囲、完了条件、旧Runを途中変換しない移行方針を記録した。実装前にDA-01で固定SDKと実AXを使った無課金の保存・再開試作を受け入れる。状態保存・再開・モデル送信の接続可能性と副作用の重複防止はまだ未検証である。第二のモデル提供元・有料検証枠、定期実行の入力/skill版選択等は対象の着手・有効化前に人間確認する。計画承認から外部書込み・有料scheduleの有効化を推定しない。

## 登録スキルのファイル原本（2026-10-08、ローカル実装済み）

利用者が保存設計を承認して実装を依頼したため、Deep Agents本体への移行に先行して現行Antigravity Runtimeへファイル経路を接続した。新規・編集保存のSKILL.mdと補助テキストはkind外の専用Docker RustFS 1.0.1、非公開bucket app-skills、named volume ax-app-objects-dataへ保存する。AX snapshot用ストレージとは別である。組み込みskillとpromptは引き続きimage内ファイルとし、入力・成果物はPGに残す。

PGは本人・Workspace・共有範囲・不変版・manifest/hash・使用中参照の正本。原本はrevisionごとの不変キーへ条件付きPUTし、全file/manifestのbytesを検査してからPGの参照を確定する。要求ID・期待revision・writer世代・容量予約で再送と部分失敗を扱う。共有スキルの読取りと下書きの編集権限は本文取得後にも再確認する。個人用もWorkspaceごとに分かれる。

Hono APIはfetch/WebCryptoベースのS3 transportを使い、Nodeとworkerdの両経路を検証した。workerdはRequest redirect=errorを受け付けないためmanualを指定し、3xxを拒否して追従しない。APIはGET/HEAD/PUT、GoはGET/HEADだけの資格を保持し、HTTPSを原則とする。ローカルHTTPは明示例外に限定し、TaskへDB/S3資格や署名付きURLを渡さない。

新規Runはcontext v2で認可済み公開版の参照を固定する。Goが取得前後の認可・manifest・SHA-256を検査し、実際にロードしたファイルだけをTaskへ搬送する。Task内ファイルは0444、ディレクトリは0700。読込時に通常ファイル・hardlinkなし・symlink非追跡・サイズ/hashを確認してpromptだけを復元する。ディレクトリ0555はcapabilitiesなしのateletが終了時に削除できなかったため不採用。同UID所有者に対するmode単独を隔離保証にしない。登録scriptは実行せず、生成コードは別Taskに隔離する。復元後40KiBを超える入力はSDK起動前にskill_context_too_large・0使用量で終了する。既存の実行証拠にはモデルへ渡した本文が残る。

旧公開JSON・版ID・descriptorは書き換えない。旧下書きは次の保存で原本へ移し、編集せず公開する場合は旧方式を保持する。既存rootは旧contextと固定imageのAdapterで継続する。ローカル移行はroot20・segment33・run52・公開版9・定義5の119行の内容hashを照合した。全20rootの互換フラグはfalse。旧実行へ新しいファイル形式を途中で混ぜない。

本文16KiB、補助text16件/各32KiB、payload128KiB、版100件、論理128MiBを維持する。PGの物理予約256MiBは未完了・過去revisionも含む。bucket hard quota1GiBは補助制限で、volume総容量やバックアップ容量の保証ではない。自動GCはない。PG dumpと原本は一組で保全し、専用schemaの43表37行・10objectを削除復元して一致を確認した。同一PC内の復旧確認であり、別媒体への保全は未設定。

実ブラウザで本人用合成スキルの登録・公開・無料preview・原本のSDK入力・正常停止・利用終了を確認し、独立inspectでAX/Actor停止・worker解放・egress拒否を照合した。初回の0555による停止失敗は、他Actorの割当なしを照合して対象worker Podを退役し、workersync→RevertActor→SuspendTaskの正式APIで回収した。保存済結果を保持し、開始・モデル送信を再実行していない。修正版は正常終了し、未解決run0・受付open・AI接続有効。外部モデル呼出しは今回0件。

設計・検証・復旧の根拠は `.space/tasks/ax-deep-agents/skill-storage-design.md`、`verification.md`、`evidence/storage-local.json`。SS-01〜04は保存経路の先行実装であり、Deep Agents本体・checkpoint接続・複数provider対応・大きい入出力の移行を完了とはしない。本番提供元・地域・保持期間・遠隔backupと復旧目標は本番利用前に確認する。

## AX配置の判断（2026-10-07）

利用者提供の独立レビューをコードと照合し、**A：Agent RuntimeをAX Task内で、作業が進む区間だけ動かす構成**へ推奨を変更した。会話・認可・秘密・費用の正本はAX外に置く。Bの常駐Runtimeは起動遅延等の実測で必要性が示された場合の再検討案とする。これは設計判断であり、詳細全項目の人間承認や稼働保証ではない。

利用者はランタイム充実の方向性を了承して実装を依頼した後、AX外配置に疑問を示し、別担当のレビュー結果を提供した。実装依頼は取り消されていない。Aを採用し、初期の無課金対話プレビューを実装した。実Keycloak・実Webから実AX Taskを2区間動かし、質問→再読込→回答→本人の成果物、別ユーザーの拒否、PG使用量と独立した実停止観測を確認した。模擬providerによる固定の質問・回答転記であり、実モデルによる推論とは表示しない。

## 実モデル接続（2026-10-07）

その後、利用者の実装依頼によりGemini 3.1 Flash-Liteを接続した。受付時にpreview/modelと固定の料金profileを保存し、modelは明示同意を必須にする。旧履歴はpreviewのまま入力bytes・hashを維持し、追加schema-v5で移行した。

モデル鍵は外側のGo Gatewayだけが保持する。TaskのSDK要求を固定の本文生成payloadへ変換し、PG予約→count→生成直前の本人・失効・停止・残予算再確認→一回の生成→外部台帳へのusage精算を行う。SDK・HTTPとも再試行しない。形式不正などの失敗でも既知usageと費用は保存し、usage不明なら予約と全体holdを維持する。旧有料adapterも含む0.01 USD停止ガードを共有する。

入力6000は事前計数と128トークンの余裕で制限し、実usage超過は記録して停止する。入力・請求額の絶対上限保証ではない。出力は思考込み累積512、各区間256以下、合計3要求・2固定tool・実作業90秒を維持する。countTokensの無料を前提にせず、料金表示は公開生成単価の概算とする。

実Keycloak・Web・PG・AXで日時の質問→回答→会議案内生成が2区間で成功した。生成2回・count2回、input2005/output90、18,239ms、今回概算0.00063625 USD。別ユーザーの拒否、保存と独立した実停止も確認した。試験後は有料Gatewayを無効化し鍵mountを外し、無料previewの成功と全体概算0.00422600 USD不変を確認した。固定スキル/固定toolの範囲であり、生成コード・subagent・外部接続は後続である。

## v2のファイル作業と登録（2026-10-08）

利用者はCSV/Excel集計・結果ファイル、複数段階、Web登録と定期実行を次の対象にした。製品サブエージェントは不要と明示された。v2は一依頼からRuntime→隔離Python→Runtimeを逐次作り、各区間の状態・操作・費用・版と入出力はapp PostgreSQLに残す。前区間の実停止が確認できるまで次を始めない。旧v1の会話・単発実行と同じ実行枠を共有し、別の制御基盤を増やさない。

製品同梱の基本指示・skillは開発時にGit管理して固定imageへ入れる。実行中にGitへ接続しない。Web登録した指示・skill本文・agent設定は `ax_definitions` と不変の公開 `ax_definition_versions` に保存し、開始時に版とhashを固定する。本人用・共有用ともWorkspaceごとに分ける。共有定義は全メンバーが登録し、作成者と現在のadminが編集できる。共有は設定の利用範囲であり、会話・入力・実行結果は本人限定のまま。

codeは固定Python標準機能とopenpyxlによるCSV/XLSX処理に限定する。追加言語・動的package導入・任意ネットワーク・社内API/MCP/RAGは、この権限に含めない。定義の登録でも権限は増えない。単一/4file合計8MiB、集計、隔離境界、3区間の停止とserver-owned cleanupを実AXの合成モデルfixtureで確認した。生成モデルの適切な選択は別の少数試験で評価する。詳細は[ファイル保存](work-files.md)と[コード隔離の知識](../../../knowledge/ax-python-isolation-probe.md)。

v2は承認された限定profileとして1root6モデル/8tool（Python3）・300秒・概算0.01 USD、今回検証全体0.05 USDで停止する。旧v1の3モデル/90秒等は変更しない。費用・再送・外部通信閉鎖の条件は[費用ルール](../../../rules/ax-model-spending.md)を優先する。定期実行は未実装で、本人権限でログアウト後も動き、結果は本人だけ、所属や権限喪失で停止する方針までが確定している。Webログインtokenの現在のRunGrantを、そのまま無人実行の委任へ流用しない。

## 汎用の標準エージェントと利用画面（2026-10-08）

利用者はファイル集計専用に見える標準エージェントを汎用化し、組み込みスキル一覧と登録後の利用導線を求めた。v2の標準指示に相談・文章作成・要約・計画・計算を追加し、添付やPythonを不要な依頼へ要求しない。実際の道具と出力形式、予算・再送・隔離条件は広げない。

`builtin_catalog.json`をRuntimeとWeb表示の共通原本にする。当初は`general-v1`を常時、`tabular-v1`をCSV/XLSXや既存の結果ファイルを参照する区間に適用した。v9の新規依頼は後述の段階的な読込へ変更した。Runtimeは固定pathと本文SHA256を検証し、実際に適用したID/hashをモデル入力へ記す。配備する固定image内catalogとWeb原本の一致は別途照合する。共有ソースだけでは異なる配備版の一致を保証しない。

主入口は「新しい依頼」。ファイルと追加スキルは任意で開き、登録設定の公開後には「この版で依頼する」から固定公開版を選択する。GETで実行せず、送信時に再認可する。旧チャット・旧エージェント対話・実行記録は補助導線と既存URLに保持する。v2は一依頼の有限rootを維持し、完了後の新しい依頼へ文脈を自動継承しない。会話とrootの新しい関連表やThread保存は今回追加しない。詳細な比較と検証範囲は `.space/tasks/ax-agent-workbench/general-agent-ui.md`。

## 標準エージェントへの統一と段階的なスキル読込（2026-10-08）

利用者はエージェント設定と事前のスキル選択を通常利用に要求しないよう求めた。v9では新規依頼を標準エージェントへ統一し、本人が現在のWorkspaceで使える公開スキルのID・名前・説明を候補として固定する。Runtimeは内容を判断して `read_skills`、必要なら `read_skill_file` を提案し、読み込んだ指示を使って続行する。`/`で明示した版の本文は最初から渡す。登録した全本文を最初からモデルへ送らず、下書きも候補にしない。

PGは `ax_agent_roots.skill_catalog` と追記専用の `ax_workbench_skill_loads` を正本とし、各Runtime区間の不変descriptorへ概要・読込済み本文・ファイル目録・取得済み資料だけを写す。補助資料はスキル本文を読んだ後、宣言済みpath単位で読む。Python区間にはskill_contextを渡さない。候補と読込済み版を開始・送信・効果の前に再認可し、候補にあっても未利用の定義が廃止された場合は安全側に停止する。

同じTask内で複数のモデル・読込操作を行う案と比較し、既存の「モデル1回と提案1回を精算・実停止して次Taskへ進む」方式を採用した。既存の費用台帳とsequence契約を維持できる一方、読込ごとにTaskとモデルの往復が増え、遅延と呼出数を使う。既存rootのdescriptor/hashと旧chunk搬送は保持し、新規方式へ途中移行しない。旧agent指定は新規受付で拒否し、受付済み再送・回答継続は維持する。

自動候補は最大32件かつUTF-8 JSON8KiB、明示指定と動的読込は最大8スキル（常時のgeneralを除く）、descriptorは40KiB。超過候補の件数は画面とモデルへ示し、候補外は`/`のページ送りから明示できる。入力6000トークンと128余裕の事前計数も維持し、本文・資料が多すぎる場合は短縮案内付きで停止する。権限・道具・既存root予算は増やさない。

組み込みは `general-v1` を常時適用し、`tabular-v1` は新規方式では自動読込または明示指定で使う。画面はスキル登録・一覧へ絞り、旧エージェント定義は閲覧用に保持する。公開版の内容確認と送信は同じ不変版を参照する。初期実装ではslashの内容確認が現在下書きを開く不一致を独立レビューで検出し、版指定の閲覧へ修正した。

合成した本人用スキル1件の実モデル試験では、概要→主本文→補助CSV→隔離Python→成果物取得の5区間を一度の送信で確認した。4モデル/1Python、実作業122.804秒。固定8KiB/40KiBの上限と既存予算を緩めず、5区間すべての実停止と通信拒否も独立観測した。詳細は `automatic-skills-paid.json` を参照する。

根拠は `codex/automatic-skills` のv9変更、`.space/tasks/ax-agent-workbench/automatic-skills-contract.md` と同作業の検証記録。モデルが常に最適なスキルを選ぶことや任意の依頼への追従は保証しない。既存のモデル性能評価は利用者の希望で今回追加しない。

## 変更した理由と事実の訂正

Bを当初推奨した理由は、平常時のTask停止・復元を減らせることだった。Bでも外部保存と障害復旧が必要であり、AXに外部Runtimeを必須とする制約は確認できない。AX中心という利用者の目的と既存Task内SDKを踏まえ、Aを基準に進める。

現在は上流ax-task-runnerがPID1として独自Python commandを起動する構成で、標準runner全体を置き換えてはいない。現在のTask作成にはAX Workspace bindingがない。固定AXのsetupSkillsはディレクトリ作成にとどまり、確認した起動経路でMCP設定の実体化は未確認。goal bootstrapは鍵不足や失敗でも後続commandを起動し得て、アプリの費用制御を通らないため、そのまま採用しない。

AXはatespace Secretまたはサーバー環境からモデル鍵をActorTemplateへ自動注入する。Task要求のenvから省くことだけでは秘密を除去できない。初期Runtimeはax-runtime atespaceへの注入とdefault template fallbackを固定patchで禁止し、env/volume等の実体を照合する。Taskは区間ごとに新規作成し、旧snapshotを復元しない。この初期版の生成code経路は未実装だったが、後述のv2で別のcode Taskへ接続した。

固定版はAX `ac2332829f22360ff97b0ba34d94dd0dd782f17e`。根拠は設計書の固定版リンク、`ax-local/runner/Dockerfile`、`execution/native/adapter.go` とタスク記録。静的照合を実Actor隔離の証拠にはしない。

## 責務と継続

- Hono/TypeScript共通APIは本人・所属・会話ownerを確認し、受付・回答・停止をapp PostgreSQLへ保存する。APIにPython実行を戻さず、DB配置をKubernetes内に固定しない。
- RuntimeはAX Task内で依頼理解・質問・登録済みスキル・信頼済み固定toolを実行する。DB資格情報を持たず、限定されたGateway操作で状態を保存する。
- Execution Gatewayは現在の権限・秘密・送信intent・予算予約・使用量とcheckpointを管理する。会話owner、操作ID、費用などアプリ固有の責務をAXへ押し込まない。
- 既存Go controllerが有限の実行区間をAXへ送り、回収・通信遮断・実停止と全体枠を管理する。AX/SubstrateのTask・Actor・volumeの仕組みを再実装しない。
- v2の生成Pythonは別のcode Taskで実行する。生成コードには鍵・DB資格情報・親の制御RPC・Gateway capabilityを持たせず、固定環境と入出力だけを与える。

Runtime配置とTask再利用は別の判断。初期の小さい状態は確認済み会話と操作台帳から新Taskの入力を再構成し、大きい作業ファイルを扱う段階で同一Taskのsuspend/resumeと比較する。どちらも外部保存が必要で、生メモリ保持を前提にしない。恒久的なTask使い捨てを要件にしない。

会話上のroot依頼と有限の実行区間を分ける。質問時はcheckpointと全送信結果・usageを確定し、通信遮断・実停止を確認して初めて安全な待機と全体枠解放へ進む。本人の回答を一度受理し、回答と次区間の受付を同じtransactionで結ぶ。開始許可なしに起動時のモデル送信をしない。

新旧writerは同じ全体枠1と費用guardを使う。未知usage・未停止Taskは全体holdを維持し、現行recoverの回収・遮断・停止だけという意味は変えない。旧経路の90秒adapter timeoutに対し、新経路はroot実作業合算90秒と人待ち24時間を別に管理する。区間ごとに予算や操作回数をリセットしない。

## 本人・接続・将来の拡張

社内システム自身が認証の受け口と最終業務認可を持つ。Gatewayは契約どおり本人性を引き継ぐ側であり、社内の認証・権限DBを代替しない。Workspace adminから業務権限を自動生成しない。Webの生tokenをモデルやTaskへ渡さず、限定capabilityから本人・Workspace・RunGrantを解決する。子は権限を縮小し、root予算を共有する。

毎回の送信・保護データ再利用とcontroller開始intent時に失効を確認する。再加入や再認証で既送信操作と消費済み予算を復活させない。取消後の照合・回収・停止は限定service権限で続ける。RAGはtenant/文書ACLを検索・返却・派生物再利用で確認し、応答不明の外部更新を無条件再送しない。

利用者は言語数の網羅より、依頼に必要な道具を判断し、不足は質問し、実行できなければ理由と代案を返すことを求めた。初期は固定環境、必要時の環境導入は後続とする。miseは候補で未採用。GitHubの取得・編集・push/PR、子エージェント、社内API/MCP/RAG、登録・定期実行UIを一括で初期実装しない。

将来のエージェント定義とスキルは版付きで登録・有効化し、利用範囲を区別する。対話で作ったスキルの共有と本人限定のチャットを分け、スキル追加で権限を増やさない。無人実行の主体・委任・失効・重複・失敗照合は後続で設計する。

## 最初の実装単位と証明する範囲

「依頼→一問→安全な待機→回答→登録済みスキルと信頼済み固定tool→本人の小さい成果物/未対応の理由・代案」を最初の経路にする。まず実SDK＋模擬providerで保存・別プロセス継続・予算を調べ、その後にAX Taskの停止と継続、無課金Web経路を順に確認する。

固定SDK 0.1.20の試作で、SQLite内protobufを含むSDK保存データから別Pythonプロセスへ会話・tool-call ID・結果を復元し、質問toolを再実行せず回答後へ進めた。検査用JSONだけからの復元は未確認である。SDK依存の復元データと、本人・質問・操作・費用のアプリ正本は分けて扱う。

累積usageは復元されたが、SDKのLIFETIME上限到達後でもRESUMEが追加のモデル要求を送るケースを確認した。Gatewayが送信前に残予算を判定・予約する必要がある。このSQLite継続案では現行3モデル要求・2toolでの通常終了に至らなかった。診断で上限を広げた正常終了や、上限終了前のファイル生成を製品の成功に読み替えない。

その後、各区間にSDKを1回だけ呼び、tools空・retryなし・response_schemaなしの通常JSON提案を検証する方式を採用した。SDK内部SQLiteの移植は使わず、PGの確認済み会話から各区間の入力を再構成する。固定スキルbrief-v1と固定toolだけを許可し、Taskのloopback proxyとmailboxをGoが回収してPGで送信前予約する。root3モデル/2tool、input6000/output512、実作業90秒を上限とし、実AXの質問・回答は合計2モデル/2toolで通常終了した。

ログインtokenの期限とfingerprintをAPIで検証し、生tokenはTaskやDBに保存しない。現在所属と本人を毎操作で確認し、所属削除・ユーザー無効化は既存rootを恒久停止する。ログアウトは既存rootを取消し、同じtokenで競合する新受付も拒否する。新しい認証セッションへ予算や旧依頼を復活させない。将来のrefresh tokenや任意token交換の連動は未実装で、全発行tokenへの即時失効を保証しない。

初期のworkerは既存ax-demoの信頼済みpoolを共有する。Substrateのatespaceはworker namespaceと別で、専用pool追加だけでは配置を限定しないことを実経路で確認した。pool labelと全template selectorの移行案と比較し、固定tool previewでは共有poolを選んだ。正確なworker証明書、Actor宛先、Actor/gVisor、固定mailbox、PG単一slotを境界とし、pool別の隔離は保証しない。専用poolは割当0件で退役し、論理ax-runtimeと履歴を残した。

初回にSubstrateが補うreadiness timeout30秒との厳密比較不一致、次にworker namespaceの誤った仮定を実接続で検出した。開始・モデル送信を再送せず、旧controller退役と実停止を証明してcleanupだけで失敗を終結した。修正後は両区間の成果物・usage・deny・Actor停止・worker未割当と他人の拒否を確認した。局所模擬試験と実環境の証拠は検証記録で区別している。

模擬providerの結果だけを、本人認可・実AX停止・敵対的な全通信隔離の証拠には代えない。3モデル要求・2tool等と2,000円の費用条件を暗黙に緩めない。詳細は `docs/agent-runtime-design.md`、レビュー原文と試作の範囲・証拠は `.space/tasks/ax-agent-runtime/`。

設計・試作だけのPRを増やさず、利用経路が通る実装・文書・検証のまとまりで提出する。

[現在の構成](../../../knowledge/ax-web-foundation.md)と[利用者の方向性](../../../knowledge/ax-agent-platform-direction.md)、[既存API/実行分離](portable-api-postgres.md)、[組織所属](workspace-access.md)、[費用ルール](../../../rules/ax-model-spending.md)を引き継ぐ。

## Workbench実モデルの指示・応答契約（2026-10-08）

v2 Runtimeは公開SDKのCustomSystemInstructionsで専用systemを指定する。SDK0.1.20へ文字列を渡すと既定agent指示への追記になり、Markdown回答・作業場所・利用者不在などの指示が混ざる。固定SDKの実mailbox全文一致テストで、専用本文とSystem区切り以外が入らないことを確認する。v1の指示はこの変更に含めない。

Go GatewayのJSON応答schemaは全候補をkind先頭へ固定する。Go mapの辞書順ではPython枝だけinput_aliasesが先頭になり、操作選択より先に枝固有の形を選ぶことになる。schemaのキー順に従うprovider仕様と整合させ、固定順structで出力する。parse後のschemaは修正前と完全等価で、質問/完了/未対応/Pythonの選択肢、必須項目、上限を維持する。countと生成のpayloadと保存SHAも一致させる。モデル内部の枝選択を直接観測したわけではないが、順序修正後の限定試験で初めてPython実行から成果物取得まで成功した。

実モデルによるCSV合計300、Runtime→隔離code→Runtime、画面のダウンロード・再表示・同じWorkspaceの別人の拒否を確認した。2モデル/1Python/実作業72.281秒。Excel・8MiB・隔離境界は固定提案の実AX試験で確認したもので、任意の依頼の成功保証ではない。すべてのTask停止、通信拒否、worker解放と同一世代cleanup、費用精算を別途照合した。このCSV試験の終了時には有料gate/鍵mount/専用Secretを閉じた。その後、利用者は通常利用のAI接続を維持する方針へ変更した。現在は既存の料金上限を維持し、各試験の終了だけを理由にサービス全体を無効化しない。定期実行は定義・入力の版選択が人間回答待ちで未実装。

根拠は `.space/tasks/ax-agent-workbench/evidence/paid-trial4.json`、`runtime-custom-system.json`、`gateway-schema-order.json` と独立レビュー。providerの順序仕様は [Google公式資料](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en)を参照する。

