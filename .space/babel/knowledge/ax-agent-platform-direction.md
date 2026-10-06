---
type: knowledge
title: AXエージェント実行基盤の構想と検討事項
description: AX単発CLIとWeb土台W1までの現在地、SSR/BFFと共通APIの採用、認証・RAG・クラウド配置の構想
status: draft
tags: 
  - ax
  - vision
  - observability
  - egress
generated: 
  by: agent:codex
  at: 2026-10-06T01:49:14.065Z
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
---
# AXを中心とするエージェント実行基盤の構想

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

## 現在の到達点

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

