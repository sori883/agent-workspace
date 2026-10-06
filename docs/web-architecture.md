# AXのWeb入口とAWSへの仮配置

2026-10-06時点の概略設計。ローカルのkind上で動くAXと[タスクCLI](../ax-local/task-cli.md)に加え、[ローカルWebワークスペース](../web/README.md)を実装した。続くW2〜W4では既存Pythonのreceipt台帳を使った非同期受付、AX内での実行、一覧・結果・成果物・使用量と復旧を接続した。チャットでは各往復を有限AX実行に対応させ、receiptの会話ID・親実行・順序から保存済みの発言と検証済み返答を復元する。次のモデル呼び出しへ成功ペアの履歴を渡し、前の発言を踏まえた会話を続ける。履歴JSONは4096バイト、会話の受付は32回までで、超過時は新規会話を案内する。共通認証としてKeycloakとPostgreSQLを接続し、ログインした本人の会話・実行だけを表示・操作する。[ローカルWeb版の概算](web-mvp-estimate.md)に残る作業をまとめる。

WebはReact RouterのFramework ModeでSSR（サーバー側での画面生成）とBFF（ブラウザ向けのサーバー処理）を提供する。共通バックエンドにAX操作をまとめ、AX内のエージェントはPythonを使う。別のPython操作サービスは必須とせず、既存Python処理を共通バックエンドから再利用する方式を採用している。受付・実行・費用の正本をPythonに置き、Honoは短命のJSONコマンドで呼び出す。workerはAPIとは別のプロセスとして動き、Web/API再起動でも受け付け済みの処理を追跡する。

共通バックエンドはW1でHono/TypeScriptを採用した。認証基盤はKeycloak＋PostgreSQLを使い、初期のメールアドレス＋パスワード・パスキーと、将来のAmazon Cognito・Microsoft Entra ID連携を整理した。認証とアプリ用のDBを分離し、既存の会話本文・実行状態はreceiptに保持する。構成と保存先の詳細は[チャットの認証基盤](auth-foundation.md)を参照する。ローカル版の認証と所有者分離は実装済み。本番公開は未実施である。

Webからのエージェント操作・定期実行の製品拡張は、利用者が用途を整理するまで保留する。既存のチャットと認証を土台に、次の用途を整理する。PostgreSQLの採用とDBの配置先は別の判断であり、AWSのマネージドDB、外部のPostgreSQLホスティング、Kubernetes内などでの自己管理から配置・運用サービスを選ぶ。アプリがEKSやKubernetes上でも、DBのクラスタ内配置を前提にしない。AWS各サービス、RAGの製品と配置先は引き続き候補。以下はAWSを使う場合の配置例で、図のRDSも選択肢の一つである。AWSへの配置・動作確認・費用見積もりは行っていない。

## 仮配置

Webと通常のAPIはECS Fargate、AX・Substrateの実行基盤はEKSのEC2ノード領域に配置する例。各ECSサービスは独立したコンテナとして配置できる。ECSとEKSは別のコンテナ実行基盤で、ECS側はEKSの外にある。

```mermaid
flowchart TB
  Browser["利用者のブラウザ"]
  Model["モデルAPI・外部サービス"]

  subgraph AWS["AWSへの仮配置"]
    subgraph VPC["VPC：アプリ用ネットワーク"]
      Ingress["HTTPSの公開入口：ALB<br/>Web・ログインを公開"]
      subgraph ECS["ECS Fargate：通常のアプリ群"]
        Web["Web＋BFF<br/>React Router・SSR"]
        API["共通バックエンド<br/>認可・タスク管理・AX操作"]
        IdP["共通認証：Keycloak<br/>ローカル導入済み・本番配置は候補"]
        RAG["RAGサービス：将来<br/>文書の検索・アクセス判定"]
      end
      subgraph EKS["EKS＋EC2ノード：AX実行基盤・適合は未検証"]
        AX["AX＋Substrate"]
        Agent["隔離された実行環境<br/>Pythonエージェント"]
        Egress["外向き通信の制御"]
      end
      DB[("RDS PostgreSQL候補<br/>認証・タスク・文書ACL／検索<br/>用途ごとにDBと権限を分離")]
    end
    Storage[("S3候補<br/>文書・成果物を用途別に保存")]
    Observe["共通監視の候補<br/>OpenTelemetry＋CloudWatch"]
  end

  Browser -->|"画面・操作・ログイン"| Ingress
  Ingress --> Web
  Ingress -->|"ログイン用の入口"| IdP
  Web -->|"API向けトークン"| API
  Web -.->|"OIDCでログインを連携"| IdP
  IdP -.->|"検証用の公開鍵"| API
  IdP -.->|"検証用の公開鍵"| RAG
  API -->|"Taskを作成・管理"| AX
  AX -->|"実行環境を準備"| Agent
  Agent -->|"Task限定の権限でツール利用"| API
  API -->|"RAG向け資格情報＋利用者の権限文脈"| RAG
  IdP -->|"認証データ"| DB
  API -->|"タスク・実行状態"| DB
  RAG -->|"閲覧可能な文書に限定して検索"| DB
  RAG -->|"文書参照"| Storage
  API -->|"成果物"| Storage
  Agent --> Egress --> Model
```

実線は操作・データの経路、点線は認証連携・署名鍵への信頼を表す。公開鍵は取得・キャッシュして検証するもので、全API要求がKeycloakへの問い合わせを経由するという意味ではない。監視への矢印は省略し、Web・API・認証・RAG・AXを横断してログ・メトリクス・トレースを収集する候補を示している。ネットワークの許可先や収集項目は未設計であり、図示だけで制御済みとは扱わない。

公開するのはWebとKeycloakのブラウザ向けログイン・OIDC入口。Keycloakの管理入口、共通バックエンド、RAG、AXの操作面は直接公開しない。ALBから各サービスへの通信経路と管理入口の制限を別途設定する。S3はVPC内のサーバーではなくAWSのストレージサービスで、図ではVPC枠の外に置く。VPCエンドポイント等の詳細は省略している。

## 認証とRAGのアクセス権

1. ブラウザをKeycloakへリダイレクトしてログインする。認可コードはブラウザ経由でWeb/BFFのコールバックへ戻り、BFFがトークンと交換する。ブラウザはWebのセッションCookieを使う。トークンの保持やCookie・CSRF対策はBFF側で扱う。
2. BFFはAPI向けのアクセストークンで共通バックエンドを呼ぶ。APIが発行元・署名・宛先・期限を検証し、その利用者がタスクを実行・閲覧してよいか判断する。ログインできることと、全タスクを操作できることは別である。
3. AX内のエージェントには、利用者のCookieや無制限な本人トークンを渡さない。Taskを特定する期限・用途を限定した資格情報を渡し、共通バックエンドが保存済みTaskの利用者・所属・許可範囲と照合する。モデルが引数に指定したユーザーIDだけで権限を決めない。
4. APIからRAGへは、RAG向け資格情報と検証可能な利用者・Taskの委任文脈を渡す。API用トークンを無条件に転送する設計にはしない。RAGが利用者の文書閲覧権限とTaskの許可範囲を照合し、その範囲に検索対象を限定する。共通認証を導入しただけで文書ACLが自動的に適用されるわけではない。

Keycloakは本人確認・トークン発行を担い、タスクの権限は共通API、文書のアクセス判定はRAGが担う。RAGには文書の取り込み時に元システムのACLを取り込み、権限変更・削除を反映する仕組みも必要。保存先はRDS PostgreSQL＋pgvectorとS3を例にしており、製品選定・取り込み方式・埋め込みモデルは未決定。

モデルAPIのキー、AWSサービスへ接続するIAM権限、利用者の認証トークンは別の資格情報として管理する。将来の記憶システム・社内外ツールも同じ入口と権限確認に接続する構想だが、外部製品ごとの認証方式までは決めていない。

## 配置の条件と未確認事項

- React RouterはNode.jsコンテナでSSR/BFFを提供できる。WebをCloudflare Workers等へ移す場合も責務分担は保てるが、実行環境の互換性と、非公開APIへ到達する経路を別途確認する。
- 共通API内のAX操作は、既存Python処理の内部呼び出しと、TypeScriptへの移植を比較済み。前者は既存の費用保護を再利用できるがNode・Python・永続ファイルを扱える実行環境が必要。後者はAPI接続と費用・再送・復旧処理の同等性確認が必要。統合する方針と実装方式は区別する。
- 図のRDSによる実行状態保存は将来案。現行CLIはローカルのファイル台帳とロックを使うため、そのままECSの一時ファイル領域に置かない。ファイル台帳を維持するなら永続領域と単一実行管理を用意する。DB化するなら既存台帳の移行と二重開始防止を検証する。
- AX・Substrateの現行固定版はDaemonSet・hostPort・hostPathを使うため、EKS Fargateへそのまま配置できない。EKSのEC2ノードは配置候補であり、ノードOS・Kubernetes機能・サンドボックス権限への適合は未検証。gVisor方式ではKVMは必須ではなく、microVM方式を選ぶ場合に仮想化対応を確認する。CPUアーキテクチャはノード・イメージ・ランタイムを合わせて選ぶ。
- ECS側の通常アプリ群をEKSの独立したアプリ用ノードへまとめる代替案も成立する。この仮配置では、Web/APIの運用とAX用ノードの要件を分けて理解しやすくするためECSとEKSを分けた。費用や運用負担の比較はまだ行っていない。
- RAG・監視・クラウド配置は後続の構想であり、今すぐ全サービスを作る計画ではない。有料APIの実行やAWSリソースの作成は行っていない。

## 根拠

- [React Routerの配置先とNode.jsコンテナ](https://reactrouter.com/start/framework/deploying)
- [React RouterのBFF構成](https://reactrouter.com/explanation/backend-for-frontend)
- [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [EKS Fargateの制約](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html)
- [Keycloakのコンテナ運用](https://www.keycloak.org/server/containers)
- [KeycloakのOIDC接続](https://www.keycloak.org/securing-apps/oidc-layers)
- [OAuthのトークン権限制限](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.3)
- [AWSのベクトルデータベース案内](https://docs.aws.amazon.com/vector-databases/)
- [CloudWatchのOpenTelemetry取り込み](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)
- [固定版Substrateのatelet配置](https://github.com/agent-substrate/substrate/blob/944abe3278b895ccbf5d45555a49dd0f2f6ceae7/manifests/ate-install/atelet.yaml)と[APIガイド](https://github.com/agent-substrate/substrate/blob/944abe3278b895ccbf5d45555a49dd0f2f6ceae7/docs/api-guide.md)。対象の版は[versions.json](../ax-local/versions.json)に記録している。
