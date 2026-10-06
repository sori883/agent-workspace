---
governance: context
code_refs: 
  - web/data/schema-v2.sql
  - web/data/workspaces.ts
  - web/api/workspace-service.ts
  - web/shared/workspace-contracts.ts
  - web/app/routes/workspaces.tsx
  - web/app/routes/workspace-manage.tsx
  - web/app/routes/join.tsx
  - execution/controller/
sources: 
  - resource: .space/tasks/ax-workspace-access/design.md
  - resource: .space/tasks/ax-workspace-access/plan.md
  - resource: .space/tasks/ax-workspace-access/verification.md
  - resource: web/data/schema-v2.sql
type: decision
title: 組織への所属を権限と業務ロールの境界にする
description: 複数Workspace・Group所属、管理権限と業務ロール、招待・本人限定データ・実行失効の契約と採用理由
generated: 
  by: agent:codex
  at: 2026-10-06T14:18:43.752Z
---
# 組織への所属を権限と業務ロールの境界にする

2026-10-06、利用者は会社を表すワークスペース、部署やプロジェクトを表すグループ、ワークスペースごとの業務ロールを整理した後、実装を依頼した。新たな認証サービスや権限サービスを分けず、既存のHono共通APIとapp PostgreSQLを所属の正本にする。Keycloakは本人確認を担い、将来のEntra/Cognito利用やDBの外部配置を妨げない。

## 所属を中心に置く

Userは複数のWorkspaceに所属でき、その所属に管理権限admin/memberと業務ロールgeneral/developerを一つずつ持つ。業務ロールを管理権限に読み替えない。Groupは一つのWorkspaceに属し、一人が複数のGroupへ参加できる。Group参加の複合外部キーは同じWorkspaceへの所属を要求する。初期版にはグループ階層、独自ロール、グループからの権限継承を設けない。

有効な利用者全員がWorkspaceを最大3個作成できる。作成者は固定し、ユーザー行のロック下で作成数と同一キー再送を確認する。招待による参加は作成数に含まない。削除・作成者移譲・作成枠返却は初期範囲外。作成者はadmin/generalで始まり、最後の有効adminを退出・削除・降格できない。管理変更と開始側の認可はWorkspaceの行ロックで順序を決める。

所属0件を許し、初回に作成か招待参加を選ぶ。個人用Workspaceは自動作成しない。所属解除時はGroup参加も削除し、再参加時はmember/generalから始める。過去の管理権限やGroup参加を復元しない。

## 招待と本人確認

adminがメールアドレスを指定し、有効期限7日のリンクを発行する。アプリからのメール配送は行わない。秘密は32bytesの乱数、DBにはSHA256だけ保存する。初回応答でだけ全文を返し、同一キー再送は既存招待を維持してtoken:nullを返す。失くしたリンクは取消して明示的に再発行する。応答不明を理由に既に渡したリンクを自動で無効にしない。

参加時に有効期限・取消・現在の招待者のadmin資格・宛先を確認する。IDトークンのemail_verified=trueかつ妥当なemailだけをusers.verified_emailに保存し、未検証・欠落時はNULLへ戻す。メール一致だけで別のissuer/subjectを統合しない。リンク受取人もログインし、確認済みメールが宛先に一致して初めて参加する。使用済み招待の再送は現在も同じ所属がある場合だけ同じ結果となる。

## 会話・実行と失効

新規会話と実行はWorkspaceとownerを固定して保存する。参照・追記には現在の所属と本人ownerの両方を要求し、管理者にも他人の会話を公開しない。URLでWorkspaceを指定して別タブの切替と混同させず、APIのX-AX-Workspace-IDで同じ境界を検証する。旧API関数の実行権は外し、Workspace確認を通る関数だけをruntimeへ許可する。

開始側のcreate/resume/stage/egress_prepare/egress_allow/startのintent確定時にも有効なUserと所属を確認する。P0001/workspace_access_revokedというDBの確定拒否だけをGoが識別し、外部操作前は送信権0件などを再検査してnot_startedへ終了、操作後は同じclaimでdeny/suspendへ進む。通信断、heartbeat喪失、外部操作の応答不明は従来どおり保留し再送しない。既に開始した処理の回収・後片付けと所有者の安全な復旧要求は、所属解除後も許可する。メンバー削除を即時モデル取消とは扱わない。

v1スキーマを変更せずv2を追加する。旧会話・実行のWorkspaceはNULLのまま保持し、本人限定の参照・復旧のみを許す。勝手なWorkspace割当や共有はしない。既存の費用・未知usage・同一失敗・全体実行枠の制約はWorkspaceをまたいで維持する。

## 採用理由と確認範囲

認証基盤の組織機能を所属の正本とする候補と比較し、アプリの会話境界、SQL制約、将来の認証プロバイダー変更を同じ正本で扱える構造を採用した。詳細比較は `.space/tasks/ax-workspace-access/design.md` と候補A/B、実装契約はplan.md、結果と限界はverification.mdおよび担当別証拠に残す。

現ローカルKeycloakは管理者が用意したアカウントを使う。公開自己登録・確認メール配送・Entra/Cognito同期・RAGやスキル権限への接続は本変更に含めない。実装・検証を一つのPRへまとめ、設計の補足ごとにPRを作らない。

# Related Concepts
- [ローカルWebの境界と非同期実行](../../../knowledge/ax-web-foundation.md): 所属境界の採用理由を現在のWeb構成へ対応付ける
