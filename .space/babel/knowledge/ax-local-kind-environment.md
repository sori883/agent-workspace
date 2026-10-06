---
governance: context
status: stable
tags: 
  - ax
  - kind
  - local
  - arm64
code_refs: 
  - ax-local/
type: knowledge
title: AXローカル実行基盤の構成と確認方法
description: Kubernetes外のDocker上PostgreSQLへ移行したAXローカル基盤の構成・費用制御・保存と復旧の検証結果
generated: 
  by: agent:codex
  at: 2026-10-06T09:26:05.936Z
sources: 
  - title: 検証対象AXソース
    resource: https://github.com/google/ax/tree/ac2332829f22360ff97b0ba34d94dd0dd782f17e
  - title: 検証対象Substrateソース
    resource: https://github.com/agent-substrate/substrate/tree/944abe3278b895ccbf5d45555a49dd0f2f6ceae7
  - resource: .space/tasks/ax-first-agent/verification.md
    title: ローカル実行の検証結果
  - resource: https://github.com/sori883/agent-workspace/pull/2
  - resource: ax-local/verification.md
  - resource: ax-local/postgres/README.md
  - resource: .space/tasks/ax-auth/verification.md
---
# AXのローカル実行基盤

2026-10-03にkindを構築し、2026-10-05に既存クラスタを再作成せずローカルレジストリ・Substrate・AXを追加した。AXからARM64のgVisor Taskを起動して出力と正常終了、削除・再作成、停止・再開時のファイル保持を確認済み。Geminiを使ったエージェントのファイル作成・正常終了・使用量を確認し、最初のマイルストーンを達成した。2,000円の費用ルールを維持し、試験後の外部通信は閉じている。

## PostgreSQLをKubernetesの外へ移行（2026-10-06）

利用者の承認で、ローカルDockerのPostgreSQL 18.4へSubstrateの既存atepgを移した。旧Podと同一image digestをComposeに固定し、専用Docker volume ax-local-postgres-dataの/var/lib/postgresql/18/dockerへ保存する。ホストは127.0.0.1:55432、kindのPodはhost.docker.internal:55432を使う。接続先はローカル環境の設定であり、本番のDB配置・提供元は未選定。

substrate/ax_substrate、keycloak/ax_keycloak、app/ax_appの3組に分離した。用途別loginは非superuserで他DB接続を拒否し、TLSのCA・ホスト名をverify-fullで確認する。このDB移行時点ではKeycloakとアプリ用DBは空だった。同日の認証実装でKeycloak 26.8.0とBFF/APIを接続し、両DBに認証情報・内部ID対応・sessionを保存するようになった。詳しくは[認証基盤](../decisions/systems/ax/auth-foundation.md)を参照する。既存会話・receiptは.state/runsに維持する。固定Substrateは起動ログへDSNを出すためパスワードをDSNへ含めず、SecretのPGPASSWORDで渡す。PostgreSQLの秘密・dumpは.state/postgres、認証サービスとアプリsessionの秘密・dumpは.state/authに保持し、Gitへ入れない。

全API停止・Pod消滅・旧client接続0の後、最終dump前後と復元先の16表全行hash/件数とsequence1件が一致した。worker_outbox全partitionとworker_outbox_trimは旧cluster固有のXIDを持つ派生通知なので、一致を記録した後に復元先だけ同一transactionで初期化し、一次表の不変を再照合した。全APIのcold起動で現在状態を読み直す。新APIの起動自体が書き込むため、起動前に永続markerを作り、以降は古いDBへ自動rollbackしない。

既存15 Taskを保持し、新offline Taskの終了0・成果物23bytes・回収/通信deny/停止を確認。DBコンテナ再作成後も全表/sequenceが一致し、Task snapshotの再開でも成果物hashを保持した。移行後の3DB dumpとSubstrateの試験復元も成功。旧Postgresは0台、data-postgres-0 PVCと移行backupを保持する。追加モデルAPI呼び出し0。Redis永続化とRustFSを含む全体復旧は未実施。

再利用手順はax-local/postgres/README.md、実測はax-local/verification.md、作業記録は.space/tasks/ax-postgres/task.md。初期導入用rebuild.mdの上流installerを無条件に再適用して外部DB接続を上書きしない。

## 現在の構成

- Docker上にクラスタ `ax-local`、コンテナ `ax-local-control-plane` を作成した。
- kind v0.33.0、Kubernetes v1.36.4、Linux ARM64、control-plane 1台。
- ノードイメージは `ax-local/kind.yaml` に公式のダイジェストで固定している。
- Substrateのkind構成を参考に、ClusterTrustBundle、ClusterTrustBundleProjection、PodCertificateRequestとcertificates.k8s.io/v1beta1を有効にした。
- APIのホスト公開アドレスは127.0.0.1、クラスタネットワークはIPv4。
- 管理ツールはMacのmiseで管理する。`/Users/const/.config/mise/config.toml` にkind 0.33.0とkubectl 1.36.4を固定し、グローバルで有効にしている。
- 専用の接続設定は `ax-local/kubeconfig`。グローバルのKubernetes接続先は変更していない。
- 接続設定は権限600で保存し、実行記録 `ax-local/.state/` とともにGitの対象外にした。認証情報を記録や成果物へ転載しない。

## 確認済みの状態

`ax-local/.state/verification.json` に確認結果を保存した。APIのreadyzがok、ノードがARM64かつReady、基本機能の9 PodがすべてRunningかつReadyだった。証明書APIにclustertrustbundlesとpodcertificaterequestsが存在することも確認した。ダウンロードしたkindとkubectlは公式のSHA256と照合した。

状態の再確認はプロジェクトルートで `kubectl --kubeconfig ax-local/kubeconfig get nodes` を実行する。既存クラスタを削除して作り直す前に、状態と保存データを確認する。Substrateの一括作成スクリプトは既存クラスタを削除するため、今回の構築では使用していない。

この実動作確認は[完了を証拠で確かめる原則](../principles/prove-it-works.md)に対応する。

## ツール管理の変更

2026-10-04、利用者の指示により、作業フォルダへの直接配置からMacのmise管理へ移行した。`mise use --global --pin kind@0.33.0 kubectl@1.36.4` で同じバージョンを有効にした。新しい対話用zshから両コマンドがmise配下へ解決されること、kindによるax-localの検出、kubectlによるノードReadyとAPIのreadyz=okを確認した。既存クラスタは再作成していない。

miseの実行ファイルが従来のものと一致することを照合した後、重複した `ax-local/.tools/` と対応するignore設定を削除した。`.state/` は作業記録の保存先として維持する。

## AXとSubstrateの構成（2026-10-05）

AXは ac2332829f22360ff97b0ba34d94dd0dd782f17e、SubstrateはAXの依存版と一致する944abe3278b895ccbf5d45555a49dd0f2f6ceae7。Go 1.27.1とko 0.19.1をmiseでプロジェクト指定した。公式ソースはax-local/.sources/、生成CLIはbin/、実行ログと匿名Docker設定は.state/に置き、いずれもGit対象外。汎用ツールの.tools/は再導入していない。

Dockerのkind-registryを127.0.0.1:5001へ公開し、kindネットワークではkind-registry:5000を使う。kindノードのcontainerdに接続を設定し、公式Substrate手順に従ってproxy ARP/NDPを有効化した。ARM64 Jobでレジストリからの取得と実行を確認済み。Docker Desktopのcredential helperが停止したため、with-env.shで専用の匿名Docker設定を使用する。通常のDocker設定は変更していない。

Substrateは主にate-system、AXとRedisはax-system、gVisor WorkerPoolはax-demoに配置した。ワーカーは1GiB・1 CPU上限を2台とし、golden snapshotの準備と通常Taskが1台を取り合う状態を避ける。AXの公式runnerをGOOS=linux/GOARCH=arm64でビルドし、Python 3.12とgoogle-antigravity 0.1.20を同梱した。上流コードは変更していない。AXのスナップショット参照はgs://ate-snapshots/ax-local/だが、kind構成の実バックエンドはローカルのRustFS（S3互換）。

AX CLIのapply/resumeからax-demo/ax-smokeを起動し、実ActorのログでAX_SMOKE_OKとtask command completed successfullyを確認した。Task削除後の再作成、suspend/resumeをまたぐ/workspace/persistence-check.txtの保持も確認済み。Running/Readyだけでは子コマンドの正常終了を表さない。

## 通信・認証・観測

ActorのEgressPolicyがない場合は拒否される。標準TLS passthroughではホスト名ルールだけでHTTPSを許可できないため、公式の実験的な--experimental-use-sdsmintを使用した。公開CAだけを派生runnerイメージへ追加し、Macの信頼設定は変更していない。実ActorからHTTP/HTTPSのexample.com=200、example.org=403とgatewayのpolicy拒否を確認した。Python httpxは200、Google genai SDKは無効テストキーに対するAPIの400を受信し、TLS経路を確認した。実モデルの成功とは扱わない。試験後のax-smokeは空の許可リストへ戻した。任意のTCP/UDP・一般Podを含む全経路の隔離は未確認。

AXのKubernetes権限はax-demo/gemini-api-secretのgetだけに限定し、独立レビューで他Secret取得・一覧・他namespaceの拒否を実測した。解決後のキーはActorTemplateのenvとしてSubstrate側にも保存される。この版はSubstrateのatespace単位RBACが未実装なので、共有利用者間の隔離が完成したとは扱わない。公開CAの再作成時は派生runnerとTaskの更新が必要。

公式kind構成のPrometheusに6 targetのup=1、Jaegerに4 service（ateom-gvisor、atenet-router、ateapi、atelet）を確認した。Actorログはkubectl-ate logsで取得できる。アラートと長期保管は未構築。初期導入時はPostgres/RustFSともkindのPVCだった。2026-10-06にPostgresだけを上記Docker volumeへ移し、RustFSはkindのPVC、レジストリはDocker volume、AX Redisは永続volumeなし。Redis Pod再作成によるAX登録情報の消失、kind削除後の復旧は本番向けの耐久性を満たしていない。

## モデル接続と操作

ローカルの受け渡し用ファイル ax-local/.state/model-api-key の存在・非空・権限600を確認し、Developer APIのmodels.listで認証成功後、stdin経由でax-demo/gemini-api-secretへ登録した。このファイルパスはGoogle AXが自動で読む指定パスではない。workspace goalはgolden actorでも起動し、bootstrap失敗でもReadyになり得る。model-smoke.yamlは開始合図を待つTask commandで、通常Actorのポリシー設定後に費用制限付きのAntigravity試験を実行する。公式runnerは維持し、ローカルのrunner/model-smoke.pyで同梱SDKのモデル・予算を指定する。有料処理前にattemptedを排他的に作成し、成功・失敗にかかわらず同じ保存領域で二度目を拒否する。開始合図は消費済み。修正版ax-model-smoke-v2でファイル作成と正常終了を確認した。旧ax-model-smokeは失敗記録を保ったままSuspended。

操作は`ax-local/README.md`、版と導入は`ax-local/rebuild.md`、判定と証拠は`.space/tasks/ax-first-agent/verification.md`を参照する。[最初のゴール](ax-agent-platform-direction.md)のモデルによるファイル操作と正常終了を含めて確認済み。後続の拡張機能は別のマイルストーンとする。

記録作成前のOKF全体検証では、既存のprinciple文書23件が孤立文書として検出された。構造エラー・壊れたリンク・driftはなかったが、strict gateは未通過だった。2026-10-05、関連する原則同士に説明付きのリンクを14件追加して孤立を解消し、全25文書を対象とするstrict・drift検査が通過した。kindの構築・動作には関係しない記録管理上の問題だった。

## 費用条件（2026-10-05）

利用者は利用上限と前払いをそれぞれ2,000円にしたと申告し、超過に加えて成果のない大量送信・予算消化も明確に禁止した。以前の10 USD条件は置き換える。[費用のグラウンドルール](../rules/ax-model-spending.md)を今後の作業の正本とする。課金画面自体は未確認。

AI Studioで対象プロジェクトのGemini APIに月額上限を設定していれば、同じ範囲のspend capをCloud Billingに重ねることは必須ではない。通知用予算と利用停止付きspend cap、利用上限と前払い残高は別。利用停止付きでも集計遅延・処理中リクエストによる超過があり、金額設定だけで厳密な上限は保証できない。公式資料：[AI Studioのspend cap](https://ai.google.dev/gemini-api/docs/billing#project-spend-caps)、[Cloud Billingのspend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)、[前払い](https://ai.google.dev/gemini-api/docs/billing#prepay)。

同梱Antigravity 0.1.20の設定を使い、モデルはgemini-3.1-flash-liteに固定、モデル呼び出し3回・ツール2回・入力6000・出力512・合計6512トークン、API再試行0・出力形式の再処理1、create_file/finishだけ、subagents無効、90秒timeoutを設定した。SDKの上限は課金額の厳密保証とは扱わない。local_auth_reviewがネットワークなし・実キーなしで、設定の反映、限定したツール、キーを除外するdockerignore、開始合図と完了markerを確認した。後述の修正で出力形式retryだけを1へ変更し、API retry=0を維持した。SDKが内部補完する画像モデルは画像ツール無効で使用しない。VertexEndpointにはAPIキー接続の設定があるが、今回Vertex AIは実行していない。

最安候補のgemini-2.5-flash-liteはmodels.listにあったものの、2026-10-05 08:59 UTCの生成要求1件が404。次に安いgemini-3.1-flash-liteへの09:02 UTCの生成要求1件は402となり、SDKの保存記録にYour prepayment credits are depletedを確認した。各試験は終了1、再試行なし、成果物なし。試験後はax-model-smokeのegressをdeny-allに戻した。これらは利用者の入金前の履歴。確定請求額は未確認。エージェントによる残高購入・自動チャージ・上限変更は行っていない。

モデル用派生イメージはversions.jsonのrunner_budget（6f4f48e64ae1eab1a9d1755d24675f676b0164e936d316d76ab64fa0246a2cad）。公式ソースは変更せず、公開CAと試験スクリプトだけ追加した。APIキーはイメージに含めない。モデル試験の成否とログは.space/tasks/ax-first-agent/verification.md、現状と再送防止の説明はax-local/README.mdを参照する。

## 2,000円ルール適用後の結果

利用者の入金申告後、再送防止と使用量記録を加え、独立レビューとネットワークなしの最終イメージ検証を行った。AXのTask specは登録後immutableで、applyによるimage更新が拒否された。証拠保存済みの旧402 Taskを削除し、新imageでTaskを作成した。この時点の旧Taskには今回導入するattemptedはなかった。

2026-10-05 09:23 UTCに1回だけ試験し、生成要求1件がHTTP 200となった。入力1123・出力26・思考0・合計1149トークン、標準料金の概算0.00031975 USD。モデルはresult.txtへのリンクとコードブロックだけを返し、ツール実行と実ファイルはなかった。成果物検査は終了1。attemptedとusage.jsonを保持し、startとverifiedはない。egressを[]に戻し、追加送信・marker解除・Task再作成はしていない。費用が少額でもA2の成功には数えない。

usage_metadataはSDKのturn内の全モデル呼び出しの累計で、記録は数値とモデル名・終了理由・概算のみ。使用量不明なら停止する。概算は確定請求額・円換算と区別する。この時点で停止し、次の追加指示を受けてツール利用の設定を調べた。証拠はax-local/.state/model-smoke-trial-3-*と検証記録に保存した。[料金表](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)の標準入力0.25 USD/百万・出力1.50 USD/百万を用いた。

## ツール設定の修正と最初のマイルストーン達成

同日、利用者は厳密にAPI送信なしで原因を調べ、根拠が得られたら少数回の低額試験を進めてよいと明示した。Dockerのnetwork noneとローカルHTTPスタブでSDK 0.1.20の実要求を確認し、model_output_retry.max_retries=0ではfunctionCallingConfig.mode=NONE、1ではAUTOになることを再現した。API retry=0と総モデル呼び出し3回は維持する。

workspace_onlyだけではcreate_fileの許可規則がなく、fail-closedで拒否されることも確認した。明示allowだけでは/tmpでの範囲外作成を防げず、policy経路のcanonical_pathはnullだった。修正版ではツール引数TargetFileが絶対パスで、Path.resolve後に試験workspaceのresult.txtと一致する場合以外を明示denyし、その後にcreate_fileをallowする。これはこの試験ファイル1件向けの許可で、一般的なエージェント作業の全権限設計ではない。

runner/verify-model-smoke.pyで、通常作成、範囲外、..、symlink、ツール上限2、モデル上限3、不正出力打切りを確認した。修正前Red、修正後と最終イメージで7ケース成功。独立レビューも合格。オフラインの人工使用量は実利用額に含めない。

旧失敗TaskをSuspendedで残し、修正版ax-model-smoke-v2を作成。2026-10-05 10:27 UTC（19:27日本時間）の実試験1回でモデル要求2件がともに200となり、result.txtの正確な12バイト、終了0、verifiedと正常終了ログを確認した。入力2396・出力61・思考0、概算0.0006905 USD。使用量が取れた試験3・4の概算合計は0.00101025 USDで、確定請求額・円換算・以前のエラー分を含む総請求は未確認。試験後の通信許可は[]に戻した。これで最初のAX実行マイルストーンは達成。成功後の追加有料試験は行わなかった。

成果物コピーはax-local/.state/agent-result.txt。固定版、再現手順、詳細な証拠はversions.json、rebuild.md、.space/tasks/ax-first-agent/verification.mdに対応する。

## 参照

- [kind v0.33.0公式リリース](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0)
- [Substrateのkind作成スクリプト](https://github.com/agent-substrate/substrate/blob/main/hack/create-kind-cluster.sh)

- [mise useの公式仕様](https://mise.jdx.dev/cli/use.html)（2026-10-04確認）

kind・Substrateの参照日は2026-10-03。将来再構築する際は互換性と配布イメージを再確認する。

## 最初の動作確認のPR反映（2026-10-05）

利用者は通常の変更をPR作成・マージまで進め、危険な操作だけ人間に確認する方針を示した。[PR承認方針](../rules/pr-delivery.md)を参照する。

最初のエージェント実行までのコード・設定・公開用手順と検証要約を[PR #1](https://github.com/sori883/agent-workspace/pull/1)にまとめ、20:41日本時間にmainへsquash mergeした。マージコミットは7d023e85ab622bf16940ed721f9082bf107e6e70。ローカルmainも同じコミットへfast-forward済み。公開リポジトリなのでAPIキー、kubeconfig、実行ログ、上流ソース、生成バイナリ、個人用スキル、会話由来の内部記録は含めていない。

PR準備でnetwork noneの実SDK7ケースを再検証し、実行イメージ内と公開したPythonコードのSHA256一致、既存成功Taskの成果物・終了0・verified・開始合図なしを読取確認した。モデルAPIへの追加送信はない。独立レビューでは依存ツールripgrepの記載不足を修正し、最終指摘0件。GitHubのCIは未設定で、今回の根拠はローカル検証と独立レビューである。

後続の任意指示・入力を扱うCLIはこのPRに含まない。公開手順はax-local/README.mdとrebuild.md、検証要約はax-local/verification.mdに置いた。


## 指示と入力を変えて実行するCLI（2026-10-05）

ax-local/taskで少量UTF-8指示・入力から1実行1Taskを作り、成果物・結果・使用量を回収できる。共通処理とAntigravityアダプターを分け、モデルに渡すwrite_outputは本文だけを受け取って固定ファイルを1回作成する。SDKは引き続きエージェント実行を担う。他プロバイダーとWebは未実装。

開始の再送を拒否し、使用量不明・cleanup失敗・未調査の有料失敗後は追加実行を止める。recoverは既存の回収と停止だけでresumeしない。SDKの部分累計を既知にしないため、Gemini要求ごとの使用量を監視する。[採用した設計と理由](../decisions/systems/ax/single-task-cli.md)を参照する。

実AXのoffline2実行とホスト強制終了からの回収、65tests、network noneのSDK12ケース、最終imageと7sourceのSHA一致、独立レビューを確認した。最初の実試験はbuiltinのArtifactMetadataが原因で予算停止となり、上限を増やさずcustom toolへ変更した。修正後のax-run-42a5505a34e292abは通常終了し、AX_INPUT_OK改行12bytesを回収。usage1403/34/0、2要求、概算0.00040175 USD。今回の2試験合計概算は0.00126475 USD。以後追加送信せず、全Taskは通信deny・Suspended。公開検証はax-local/verification.md、詳細は.space/tasks/ax-task-cli/task.md、変更は[PR #2](https://github.com/sori883/agent-workspace/pull/2)。

