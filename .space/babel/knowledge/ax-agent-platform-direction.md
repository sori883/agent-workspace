---
type: knowledge
title: AXエージェント実行基盤の構想と検討事項
description: 組織基盤の実装済み構成と、言語数より依頼に応じた環境準備・対話を優先するエージェントの方向性
status: draft
tags: 
  - ax
  - vision
  - observability
  - egress
generated: 
  by: agent:codex
  at: 2026-10-07T10:06:07.420Z
sources: 
  - resource: .space/tasks/ax-task-cli/task.md
  - resource: ax-local/task-cli.md
  - resource: .space/tasks/ax-web-architecture/design.md
  - resource: .space/tasks/ax-web-architecture/estimate.md
  - resource: docs/web-architecture.md
  - resource: docs/web-mvp-estimate.md
  - resource: https://github.com/sori883/agent-workspace/pull/3
  - resource: web/README.md
  - resource: .space/tasks/ax-web-foundation/task.md
  - resource: .space/tasks/ax-web-runs/design.md
  - resource: .space/tasks/ax-web-runs/verification.md
  - resource: ax-local/postgres/README.md
  - resource: docs/auth-foundation.md
  - resource: .space/tasks/ax-auth/verification.md
  - resource: ax-local/keycloak/README.md
  - resource: .space/tasks/ax-portable-api/design.md
  - resource: .space/tasks/ax-workspace-access/task.md
  - resource: .space/tasks/ax-workspace-access/ownership.md
  - resource: docs/agent-runtime-design.md
  - resource: .space/tasks/ax-agent-runtime/task.md
  - resource: .space/tasks/ax-agent-runtime/reviews/external-2026-10-07.txt
  - resource: .space/tasks/ax-agent-runtime/spike/README.md
  - resource: .space/tasks/ax-agent-runtime/implementation.md
  - resource: .space/tasks/ax-agent-runtime/verification.md
  - resource: .space/tasks/ax-agent-model/contract.md
  - resource: .space/tasks/ax-agent-model/verification.md
  - resource: .space/tasks/ax-agent-model/integration-review.md
---
# AXを中心とするエージェント実行基盤の構想

## 現在の方針：AX内の対話型ランタイム（2026-10-07）

利用者提供の独立レビューをコードと照合し、Agent RuntimeをAX Task内で作業中の区間だけ動かすA案へ推奨を変更した。会話・認可・秘密・費用の正本はAX外に置く。当初のAX外常駐案は平常時の切替を減らす利点から選んだものだったが、AXの必須制約ではなく、常駐案にも保存・復旧が必要である。

利用者はランタイム充実の方向を了承し実装を依頼した後、AX外配置に疑問を示してレビューを求めた。実装依頼は維持されている。初期の無課金対話プレビューを実装し、実Keycloak・実Web・実AXで質問→回答→本人の成果物と停止を確認した。その後、固定モデルGemini 3.1 Flash-Liteによる質問→回答→本文生成も実装・実機確認した。受付時に実モデル/無課金previewを固定し、有料利用の同意・外部Gatewayの鍵と認可・PG費用台帳を持つ。生成コード、subagent、接続先への委任はまだ後続である。実モデル試験は生成2回で概算0.00063625 USD、停止と本人限定を確認済み。費用方針に従い試験後は有料送信を閉じ、無課金previewを維持した。新しい契約と検証は `.space/tasks/ax-agent-model/contract.md` と `.space/tasks/ax-agent-model/verification.md`。詳細は[ランタイムの決定](../decisions/systems/ax/agent-runtime.md)、`docs/agent-runtime-design.md` と `.space/tasks/ax-agent-runtime/task.md`。

現在は上流runnerが独自Python commandを起動する構成である。固定上流のスキル準備はディレクトリ作成にとどまり、MCP設定の実体化は確認した起動経路では未確認。goal bootstrapの失敗時続行やAXのモデル鍵自動注入も移行条件とする。これらを標準機能として利用済み・隔離保証済みとはしない。

初期は「依頼→一問→安全な待機→回答→登録済みスキルと信頼済み固定tool→本人の小成果物/代案」。人待ちは外部保存・全送信とusageの確定・通信遮断と実停止後に全体枠を解放する。会話上のroot依頼と有限の実行区間を分け、旧recoverを再開始へ転用せず、未知usageと未停止のholdを維持する。初期小状態は確認済み会話と台帳から入力を再構成し、区間ごとに新Taskを作る。Taskは鍵を持たず、実SDKの型付き提案を外側のGo GatewayがPG予約して処理する。固定スキルbrief-v1と固定toolだけを公開し、合計3モデル/2toolの範囲で実AXの2区間が通常終了した。workerは既存ax-demoの信頼済poolを共有し、論理atespace ax-runtimeとworker namespaceを混同しない。

## 合意した将来の方向（2026-10-07）

将来、指示・スキル版・接続先・権限・起動条件を持つエージェント定義を画面で登録・有効化し、定期的に依頼を作る方向を想定する。人数や登録数に比例した常駐Runtimeを作る仕様ではない。無人実行の主体・期限・失効・重複・失敗照合は後続で設計する。

標準スキル、画面登録スキル、対話で作成したスキルを、依頼やエージェント定義から指定する利用も将来の方向性に含む。本人・Group・Workspaceの利用範囲、下書きと公開、版を分ける。スキル追加で外部権限を増やさず、本人のチャットを自動共有しない。最初は登録済みスキル、管理画面・作成・公開は後続とする。

## 直近の方針：依頼に応じた環境準備と対話（2026-10-07）

利用者はランタイムの充実を優先する。言語対応を網羅するより、ユーザーの要求を理解して必要な道具と作業環境を判断し、不足情報を会話で補い、準備・実行し、できない場合は理由と代案を伝える機能を求めた。会話、スキル、サブエージェント、コード実行はこの流れを支える。言語数や全環境への対応は初期の完了条件にしない。

社内システムの認証受け口と最終的な業務認可は社内システム側が持つ。エージェント側は合意した方法で本人性を引き継ぐ。将来のGitHub clone・ソース編集・push/PRと、社内API/MCP/RAG接続は想定するが、最初の実装単位へ一括で含めない。固定環境で「依頼→質問→作業→結果/代案」を成立させ、その後に必要な道具を追加準備できるようにする案を設計書へ反映した。mise等の具体的な導入方式は未実装・未実証の候補である。

## 設計の再開：対話型エージェントと社内連携（2026-10-07）

利用者は、Webからスキル・サブエージェント・Python等を使うエージェントの設計を依頼した。社内API・MCP・RAGへの接続を将来実施する要件とし、依頼者の本人性と接続先の権限に応じて閲覧・更新を制限することを求めた。以前保留したWebからのエージェント操作は今回設計を再開する。定期実行の仕様は引き続き未確定。この設計開始時点では実装・接続の実行を含まず、その後の実装依頼と配置の訂正は冒頭の現在方針へ反映した。

当初はAX外の常駐Agent Runtime、Execution Gateway、任意コード用AX Taskを分ける案を整理した。その後、[設計案](../decisions/systems/ax/agent-runtime.md)は冒頭のAX内Runtimeへ変更した。当初は未実装だった。現在の初期プレビューは冒頭の範囲まで実装し、将来の生成コード・サブエージェント・動的環境準備・外部連携と区別する。詳細は `docs/agent-runtime-design.md`。設計だけのPRは作成していない。

## 実装済み：ワークスペース・グループ・業務ロール（2026-10-07）

利用者は会社を最上位のWorkspace、部署やプロジェクト等をGroupとし、Userの複数Workspace・複数Group所属を整理した後、「それで作って」と実装を依頼した。既存共通APIとapp PostgreSQLを正本とする案を採用した。管理権限admin/memberと業務ロールgeneral/developerは各Workspace所属に持ち、別々に判定する。

2026-10-07の追加指定で、初期の累計作成3個を現在所有50個へ変更した。招待参加数には上限を設けない。各Workspaceは一人の所有者を持ち、参加メンバーの承諾で譲渡すると旧所有者の枠が空く。所有者は譲渡するまで退出・削除・降格できない。作成者は履歴として固定し、Workspace削除は未実装。所属0件を許して、明示的な作成かメール宛先を確認する招待参加を選ぶ。既定の業務ロールはgeneral、作成者はadmin、招待参加はmember。Groupは平坦な集まりで、解除後の再参加時に旧権限やGroupを復元しない。

画面・API・DBと実行管理へこの境界を実装した。会話はWorkspace所属と本人ownerの両方を要求し、管理者も他人の会話を読めない。旧履歴は本人限定のNULL Workspaceのまま参照・復旧だけを許し、自動割当しない。詳細な理由・制約は[所属の決定](../decisions/systems/ax/workspace-access.md)、実装契約と結果は `.space/tasks/ax-workspace-access/` に残す。

将来のスキル管理、社内システム、RAGの土台であり、それらへの接続、公開自己登録・確認メール配送、Entra/Cognito同期まで実装したものではない。この実装時点ではWebからのエージェント操作・定期実行の製品拡張を保留していた。その後、上記の依頼で対話型エージェントの設計を再開した。PRは設計の補足ごとに増やさず、実装・文書・検証のまとまりで作成する。

## 共通APIとPostgreSQLへ移行した時点（2026-10-06）

利用者の依頼により、ホストPythonが持っていた受付・所有者確認・会話管理をHono/TypeScript共通APIへ移した。会話・受付・実行記録・小さな成果物は既存app PostgreSQLを正本とする。独立したGo実行管理がAXを操作し、PythonはTask内部で続ける。AX RedisはAX内部状態のために使う。

Cloudflare Workersは移植性の確認基準で、配置先として選定していない。Nodeと実workerdのAPI契約を実PostgreSQLで確認し、ローカルでは15件の移行と実AX offline、実Keycloakからの全経路を確認した。本番のAPI・DB配置、BFFの移植、全基盤復元は未実施。実装と運用の正本は[Web構成](ax-web-foundation.md)と[移行の決定](../decisions/systems/ax/portable-api-postgres.md)。

利用者は設計の途中や会話の補足ごとにPRを増やさず、今回の構成変更をソース・文書・検証を含む一つの単位へまとめるよう指示した。この移行時点では製品機能としてのエージェント操作・定期実行の拡張を保留していた。その後の対話プレビューは冒頭に記した範囲で再開した。

## 経緯：チャットへ認証基盤を接続（2026-10-06）

会話履歴を踏まえるチャットをPR #8で実装し、利用者は動作を確認した。その後、Webからのエージェント操作や定期実行の製品拡張は、用途を決め切れていないため一旦保留するよう指示した。既存のチャットを土台に認証基盤を整えた。製品拡張の用途は引き続き保留する。

利用者はログイン・ログアウト、未ログイン時のチャット利用拒否、自分の会話だけを扱う3点を了承した。初期のログイン方式はメールアドレス＋パスワードとパスキー。将来はMicrosoft Entra IDやAmazon Cognitoの利用も想定する。

今回の構成調整ではKeycloak＋PostgreSQLを初期の設計とし、認証用DBとアプリ用DBの権限を分離する。同日、利用者はPostgreSQLの採用を了承した一方で、EKS/Kubernetes内にDBを置く前提にしないよう明示した。本番DBの配置先・運用サービスは未選定で、AWSのマネージドDBや別のPostgreSQLホスティング、自己管理も候補に残す。アプリの配置先とは別の判断とし、ローカル開発構成を本番の前提にしない。アプリの内部利用者IDで会話の所有者を表し、会話本文・費用・実行状態は既存receiptに維持する。詳細は[認証基盤の設計](../decisions/systems/ax/auth-foundation.md)と `docs/auth-foundation.md`。当初の設計時点では認証は未実装だった。同日、利用者の承認でローカルDockerにPostgreSQLを作成し、実行基盤の既存データを移行、認証用・アプリ用DBと別loginを準備した。全件照合・TLS/権限・offline実行・コンテナ再作成後の保持を確認し、旧DBは停止してPVCとbackupを残した。モデル呼び出しは追加していない。続けて認証実装の依頼を受け、このDBを使うKeycloakのメール・パスキー認証をWebへ接続した。BFFのログアウト、APIのJWT検証、Pythonの内部owner照合により本人の記録だけを公開する。実Keycloak、2利用者の実AX offline、旧記録保持、DB隔離復元と再起動後のsessionを確認した。有料モデル送信は0件。物理認証器のパスキー、本番公開、メール送信・自己登録、Entra/Cognito接続は未確認・未実装である。具体的な運用はax-local/postgres/README.mdとax-local/keycloak/README.md、今回の確認は .space/tasks/ax-auth/verification.md を参照する。以下は当時の経緯として読む。

## ローカルWebから実AXへ接続（2026-10-06）

W1の接続確認後、利用者はAX接続・操作画面・検証を1本のPRへまとめるよう依頼した。W2〜W4を実装し、指示と入力の永続受付、実行一覧・詳細、成果物の表示と取得、使用量・停止確認、再開始しない復旧をWebから利用できる。既存PythonをAPI内部から再利用する方式を採用し、Web専用の別台帳や常駐ジョブキューは追加していない。

既定の動作テストは実AXのoffline処理。モデルを使う場合は明示選択と外部送信・料金への同意が必要で、既存Antigravity/Geminiの上限を引き継ぐ。実AX offline2件、同一キー再送、完了後のWeb/API再起動と結果保持を確認した。今回は有料モデル送信0件で、Webからの有料モデル全経路と実行途中の実AX/API停止は未検証。自動検証はPython85件、Node12件、ブラウザ12件、型/buildが成功した。

現在の契約と理由は[ローカルWeb](ax-web-foundation.md)、利用手順は `web/README.md`、証拠は `.space/tasks/ax-web-runs/verification.md`。共通認証・公開配置・複数利用者・RAG・新しいモデルサービスは後続候補であり、実装済みとはしない。以下の各日付の節は当時の経緯として読む。

## Webの土台W1を実装（2026-10-06）

利用者が「次の作業を確認して進める」と指示したため、前回checkpointと概算の最初の単位W1を再開した。`web/` にReact Router 8のSSR/BFFとHonoの共通APIを追加し、別プロセス・別loopbackポートの実HTTPで模擬メッセージを往復できる。起動、Host/Origin・session/CSRF・API資格情報・入力境界、API停止時の表示、狭い画面とJavaScriptなしの操作を確認した。

今回のAX操作・モデルAPI送信・クラウド作成は0件。W1は接続確認であり、AX Taskの開始や成果物の取得にはまだ接続しない。次の単位はW2（既存Pythonを共通API内部から呼び出す非同期受付・状態照会・永続記録・費用/排他制御）。詳細は[Web土台の契約と理由](ax-web-foundation.md)、`web/README.md` と `.space/tasks/ax-web-foundation/task.md` に記録する。

以下のWeb選定・配置図の節はW1着手前の経緯であり、当時の未実装・次回候補の記述を現在の状態と混同しない。

## Web入口の選定と配置図（2026-10-06）

設計と見積もりの公開版を `docs/web-architecture.md` と `docs/web-mvp-estimate.md` に整理し、利用者の依頼でPR #3（https://github.com/sori883/agent-workspace/pull/3）をマージした。マージコミットは `9bef7183fdff215cc687d5bb37042f2fd7c63da6`。文書のみの変更で、Webの実装・クラウド作成・モデルAPI送信はしていない。公開版を今後の設計・見積もりの参照先とし、ローカルの作業資料は当時の記録として保持する。

利用者は次の実装を翌日以降に行う意向であり、今日はPRのマージと再開準備までで区切った。最初の候補はW1（React Router SSR/BFFとHono共通APIのローカル疎通、AXは模擬応答）。再開手順は `.space/checkpoint/ax-web-architecture-resume.md` に保存する。ローカルWeb版の概算は4〜8人日、共通認証を含める場合は6〜12人日で、AIの経過時間の約束ではない。

同日、利用者の意向により、責務・連携・技術構成と仮配置を整理する概略設計フェーズを完了として区切った。次はローカルWeb版の概算見積もりまでを依頼され、`.space/tasks/ax-web-architecture/estimate.md` に前提と範囲を整理した。詳細設計・実装・クラウド配置の完了や、新しい実装着手の承認を意味しない。

利用者は本会話でReact RouterのFramework ModeをWeb側に使う方針を選んだ。画面はSSRに対応させ、同じWebサーバーがBFFを担い、ブラウザから共通バックエンドへ直接接続しない構成を検討する。AXを操作する処理は共通バックエンドに含め、AX内のエージェントは既存のPython実装を活用する方向で整理する。独立したPythonワーカーサービスを必須にする方針ではない。

2026-10-06、利用者は提示した技術構成と仮配置の枠組みを、将来の見直しを前提とする当面の設計方針として了承した。共通バックエンドのHono／TypeScript、共通認証のKeycloak、RAGの実装・保存先は仮置きを含み、製品・配置の最終確定ではない。認証基盤はKeycloakに固定せず、将来のAmazon Cognitoの利用やMicrosoft Entra IDとの連携を選択肢として残す。具体的な連携・移行方法は必要になった時点で検討する。既存PythonのAX操作を内部で再利用するか、TypeScriptへ移植するかも未選定。費用台帳・二重開始防止・使用量不明時の停止・通信遮断とTask停止を維持する条件は変わらない。

利用者の依頼に基づくAWSへの仮配置と認証・RAG連携図を `.space/tasks/ax-web-architecture/design.md` に保存した。Web・API・認証・将来RAGをECS Fargate、AX・SubstrateをEKSのEC2ノード領域へ置く例であり、配置先の採用やクラウド導入の承認ではない。認証基盤は本人確認・トークン発行、共通APIはタスクの認可、RAGは利用者とTaskの許可範囲に基づく文書ACLの判定を担う案として示した。

この概略設計の時点で動作していたのはローカルkind上のAXと単発CLIであり、Web・共通API・Keycloak・RAGは未実装だった。EKS適合・本番運用・費用は未検証である。

## 利用者が示した方向性

出所は2026-10-04の本会話での利用者の発言。AXでエージェント実行基盤を作り、RAG、記憶システム、社内外のツールを接続し、WebやAIツールからエージェントを動かしたい。当時は構想段階で、具体的な製品・接続方式・責務分担は未確定だった。2026-10-05、利用者は最初のゴールを「まずAXを普通に動かし、エージェント実行基盤として使うところまで」と明確にした。

非機能面では、モニタリングとアウトバウンド通信の制御を重視する。監視対象、保管期間、許可先、制御方式などの詳細な要件は未確定。人間が理解しながら一段ずつ進める。

## モデル・接続サービスを差し替える方針（2026-10-05）

出所は同日の本会話での利用者の発言。将来はOpenAI、Gemini、Claude、Amazon Bedrock、Azure OpenAIなどに柔軟に対応できるよう、共通のコアと、接続先に応じたプラグイン／アダプターを分けて管理したい。現行のAntigravity SDK＋Geminiは最初の動作確認用の構成として位置づけ、将来の接続先を固定するものとはしない。

これは利用者が示した構想であり、コアとアダプターの具体的な責務、共通インターフェース、採用SDK、対応順序は未確定。エージェントの実行方式とモデル接続先をどの単位で差し替えるかも、今後の設計で整理する。今回の更新は方針の記録までで、各サービスへの接続実装・検証は含まない。

接続先を増やす場合も、既存の費用上限・無駄な送信の禁止、モニタリングと外向き通信制御を重視する方針を引き継ぐ。

## 基盤導入時の到達点（2026-10-05）

[ローカル検証環境](ax-local-kind-environment.md)にkind・レジストリ・Substrate・AXを導入済み。AXのARM64 Taskで出力と正常終了、削除・再作成、停止・再開のファイル保持、HTTP/HTTPSの許可・拒否を確認した。Geminiを使うエージェントのファイル作成・正常終了・使用量まで確認し、最初のマイルストーンを達成した。試験後の外部通信は閉じている。利用者が指定した[2,000円の上限と無駄な送信を禁じるルール](../rules/ax-model-spending.md)を守る。詳細は`.space/tasks/ax-first-agent/verification.md`。

## 最初のマイルストーン：AXでエージェントを実行する

既存のMac・Docker・kind環境で、AXからエージェントを1件起動し、小さな指示を処理させ、出力とログを確認できる状態を目指す。起動手順と使用する版を記録し、同じ操作を再現できるようにする。2026-10-05に基盤導入とモデルを使わないTaskの動作を確認した。同日10:27 UTC、修正版ax-model-smoke-v2でモデルによるファイル操作・正常終了も確認し、このマイルストーンを完了した。

利用者はRAG・記憶・社内外のツール・WebやAIツールからの利用を、後から足すプラグイン的な機能と捉えている。この整理では「後から接続する拡張」と扱い、共通の公式プラグイン規格で全て実現できるとは断定しない。外部ツールにはMCP/API等、利用入口にはAX APIを利用するアプリ等の接続があり得るが、方式は未選定。

### 今回の範囲

- kind、イメージの置き場、Substrate、AXのCLIとサーバー、標準runnerを中心とする実行用イメージ。
- 実際にAIの指示処理を試すための、最小のエージェント実行設定とモデル接続・認証情報。
- 状態とログの参照、結果の取り出し、実行終了・不要なTaskの削除。
- 基本的な監視と外向き通信の確認。高度なダッシュボードや本番運用全体の完成は後続で扱う。

RAG、長期記憶、社内外ツールの追加接続、独自Web UI、外部AIツール向けの接続機能は後続マイルストーンに分ける。Substrateやモデル接続は、今回の実行確認を成立させる依存要素として含める。

### 完了を判断するための確認

1. AX CLIから試験Taskを作成し、実行環境の準備完了を確認できる。
2. モデルを使う小さなエージェント処理を1件実行し、期待した出力・成果物と処理の終了結果を直接確認できる。
3. 状態とログを見て、起動失敗と処理失敗を区別できる。
4. 試験Taskを終了・削除し、使用した版と手順に従って再度実行できる。
5. 試験で必要な外部接続先と通信経路を明示し、導入する版の対応範囲で許可・拒否の通信テストを行う。未確認の経路を制御済みと扱わない。

2026-10-05時点で基盤Task・ライフサイクル・基本的な観測とHTTP/HTTPS経路を確認した。入金前の402、入金後のツール未実行を経て、API送信なしの原因調査で試験設定のツール無効化と許可不足を確認した。修正後は実要求2件でファイル作成・終了0・verifiedと正常終了ログを確認。概算0.0006905 USD、試験後は外部通信を閉じた。再送防止markerを保持している。AXのTaskがRunning/Readyであることだけをエージェント処理の成功としない。公式runnerは子コマンド終了後も動き続け、現状ではコントロールプレーンが子コマンドの終了コードを取得しないため、ログと成果物まで確認する。

### ゴールまでの中間確認

1. ローカルレジストリをDocker上に接続し、ARM64の小さなサンプルをkindで動かして、イメージ取得とログを確認する。
2. Substrateの起動とサンプルActorを確認する。実際のActorからの通信とログ参照を確認し、一般のPodの確認と区別する。
3. AXサーバー・CLI・実行用イメージを導入する。
4. AX経由で最小のエージェント処理を実行し、上記の完了条件を確認する。

レジストリやサンプルはAXのゴールへ進むための中間確認であり、それぞれを別の最終目標にはしない。人間が理解しながら進める方針に従い、各段階で何が動くようになったかを説明する。

### 解消した前提と維持する条件

- ARM64の標準runnerと同梱Python/Antigravityはローカル用Dockerfileでビルドし、実TaskとSDKのTLS接続を確認した。モデルがツールでファイルを作る処理まで確認済み。公式Makefileのamd64固定は変更せず、外側の手順で対応した。
- Gemini Developer APIのキーをSecretへ登録し、3.1 Flash-LiteとSDKの費用制限を設定した。2.5 Flash-Liteは生成要求で404となったため使用しない。利用者は利用上限と前払いを各2,000円にしたと申告した。利用者の追加承認に基づき、送信なしの調査と回数制限付き試験を経て最初の実行を確認した。成功後は追加送信を止めている。秘密値は会話やログへ記録しない。課金上限の引上げや自動入金は行わない。
- AXとSubstrateはversions.jsonに固定し、モデルを使わない実動作を確認済み。ストレージ参照と実行イメージはローカルへ置き換えた。HTTPSのホスト名制御は公式の実験的機能を使用している。

この段階分けは[小さな単位で確認する原則](../principles/sequence-verifiable-units.md)に、出力まで確認する完了条件は[実動作を確かめる原則](../principles/prove-it-works.md)に対応する。

## 調査の根拠と限界

- [kindのローカルレジストリ手順](https://kind.sigs.k8s.io/docs/user/local-registry/)は、Dockerレジストリとkindを接続し、登録したイメージをクラスタで動かす流れを示す。
- [Substrateの監視ガイド](https://github.com/agent-substrate/substrate/blob/main/docs/observability.md)はActorのログ・メトリクス・トレースを説明する。稼働中のActorのログ参照と、停止・移動をまたぐ過去ログの集中保管は区別される。
- [Substrateの外向き通信資料](https://github.com/agent-substrate/substrate/blob/main/docs/egress-traffic.md)はゲートウェイ経由の通信制御を説明するが、冒頭にGA向け仕様と記載される。導入する版での実動作は別途確認する。Actor自身の監視データ送信にもegressルールが必要とされている。
- [AXのロードマップ](https://github.com/google/ax/blob/main/docs/roadmap.md)には、最小権限の方針やrunnerでのテレメトリ・実行履歴の自動収集が記載される。これらを導入済み機能とみなさない。

公式資料の確認日は2026-10-04。製品機能の記載とローカルでの実証を区別する。

2026-10-05のゴール整理で追加確認した資料：

- [AX README](https://github.com/google/ax/blob/main/README.md)：Substrate、イメージ置き場、CLIとサーバーの導入。
- [AX runner仕様](https://github.com/google/ax/blob/main/docs/runner.md)：標準runnerとコマンド実行、終了コードの扱い。
- [AXの概念](https://github.com/google/ax/blob/main/docs/concepts.md)：Task、Workspace、Model。
- [AX Makefile](https://github.com/google/ax/blob/main/Makefile)と[runner Dockerfile](https://github.com/google/ax/blob/main/Dockerfile.task-runner)：amd64固定のビルド設定。

## 指示と入力を変えるCLIの追加（2026-10-05）

利用者がWebより先にタスク実行の入口を整える方針を承認したため、指示と少量UTF-8入力を受け取るCLIを追加した。1実行1Task、成果物1件、成功・失敗・使用量・通信遮断と停止を記録し、実モデルの正常終了まで確認した。これにより次の指示を1件ずつ実行できる。

初期の責務分離として、CLI・実行契約・開始と回収の制御を共通処理に、SDKとGeminiの使用量確認・固定出力ツールをアダプターに置いた。構想時に未定だった責務の一部を実装したもので、OpenAI・Claude・Bedrock・AzureやWebの接続はまだない。[採用した設計](../decisions/systems/ax/single-task-cli.md)と[実環境の記録](ax-local-kind-environment.md)に根拠と制約を残す。
