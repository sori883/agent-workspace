---
type: decision
title: AX Task内の対話型ランタイムと外部の制御基盤
description: AX内Runtimeへ変更した判断、外部の認可・秘密・費用、SDK継続試作と初期対話経路の条件
status: draft
governance: context
code_refs: 
  - web/api/
  - execution/
  - ax-local/task_runtime/
  - ax-local/runner/Dockerfile
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
generated: 
  by: agent:codex
  at: 2026-10-07T07:47:20.291Z
---
# AX Task内の対話型ランタイムと外部の制御基盤

## 現在の判断（2026-10-07）

利用者提供の独立レビューをコードと照合し、**A：Agent RuntimeをAX Task内で、作業が進む区間だけ動かす構成**へ推奨を変更した。会話・認可・秘密・費用の正本はAX外に置く。Bの常駐Runtimeは起動遅延等の実測で必要性が示された場合の再検討案とする。これは設計判断であり、詳細全項目の人間承認や稼働保証ではない。

利用者はランタイム充実の方向性を了承して実装を依頼した後、AX外配置に疑問を示し、別担当のレビュー結果を提供した。実装依頼は取り消されていない。Aを採用し、初期の無課金対話プレビューを実装した。実Keycloak・実Webから実AX Taskを2区間動かし、質問→再読込→回答→本人の成果物、別ユーザーの拒否、PG使用量と独立した実停止観測を確認した。模擬providerによる固定の質問・回答転記であり、実モデルによる推論とは表示しない。

## 変更した理由と事実の訂正

Bを当初推奨した理由は、平常時のTask停止・復元を減らせることだった。Bでも外部保存と障害復旧が必要であり、AXに外部Runtimeを必須とする制約は確認できない。AX中心という利用者の目的と既存Task内SDKを踏まえ、Aを基準に進める。

現在は上流ax-task-runnerがPID1として独自Python commandを起動する構成で、標準runner全体を置き換えてはいない。現在のTask作成にはAX Workspace bindingがない。固定AXのsetupSkillsはディレクトリ作成にとどまり、確認した起動経路でMCP設定の実体化は未確認。goal bootstrapは鍵不足や失敗でも後続commandを起動し得て、アプリの費用制御を通らないため、そのまま採用しない。

AXはatespace Secretまたはサーバー環境からモデル鍵をActorTemplateへ自動注入する。Task要求のenvから省くことだけでは秘密を除去できない。初期Runtimeはax-runtime atespaceへの注入とdefault template fallbackを固定patchで禁止し、env/volume等の実体を照合する。Taskは区間ごとに新規作成し、旧snapshotを復元しない。生成code経路は未実装である。

固定版はAX `ac2332829f22360ff97b0ba34d94dd0dd782f17e`。根拠は設計書の固定版リンク、`ax-local/runner/Dockerfile`、`execution/native/adapter.go` とタスク記録。静的照合を実Actor隔離の証拠にはしない。

## 責務と継続

- Hono/TypeScript共通APIは本人・所属・会話ownerを確認し、受付・回答・停止をapp PostgreSQLへ保存する。APIにPython実行を戻さず、DB配置をKubernetes内に固定しない。
- RuntimeはAX Task内で依頼理解・質問・登録済みスキル・信頼済み固定toolを実行する。DB資格情報を持たず、限定されたGateway操作で状態を保存する。
- Execution Gatewayは現在の権限・秘密・送信intent・予算予約・使用量とcheckpointを管理する。会話owner、操作ID、費用などアプリ固有の責務をAXへ押し込まない。
- 既存Go controllerが有限の実行区間をAXへ送り、回収・通信遮断・実停止と全体枠を管理する。AX/SubstrateのTask・Actor・volumeの仕組みを再実装しない。
- 生成コードと未信頼scriptは後続の別code Task。鍵・DB資格情報・制御RPC・Gateway capabilityを持たせず、全通信と改ざんの境界を実Actorで確認してから公開する。

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
