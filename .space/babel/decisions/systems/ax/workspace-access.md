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
  - web/data/schema-v3.sql
  - web/app/components/ownership.tsx
sources: 
  - resource: .space/tasks/ax-workspace-access/design.md
  - resource: .space/tasks/ax-workspace-access/plan.md
  - resource: .space/tasks/ax-workspace-access/verification.md
  - resource: web/data/schema-v2.sql
  - resource: .space/tasks/ax-workspace-access/ownership.md
  - resource: .space/tasks/ax-agent-workbench/task.md
type: decision
title: 組織への所属を権限と業務ロールの境界にする
description: 複数Workspace・Group所属、現在所有50個と承諾式譲渡、管理権限・業務ロール、本人限定データの契約と採用理由
generated: 
  by: agent:codex
  at: 2026-10-07T12:39:15.811Z
---
# 組織への所属を権限と業務ロールの境界にする

2026-10-06、利用者は会社を表すワークスペース、部署やプロジェクトを表すグループ、ワークスペースごとの業務ロールを整理した後、実装を依頼した。新たな認証サービスや権限サービスを分けず、既存のHono共通APIとapp PostgreSQLを所属の正本にする。Keycloakは本人確認を担い、将来のEntra/Cognito利用やDBの外部配置を妨げない。

## 所属を中心に置く

Userは複数のWorkspaceに所属でき、その所属に管理権限admin/memberと業務ロールgeneral/developerを一つずつ持つ。業務ロールを管理権限に読み替えない。Groupは一つのWorkspaceに属し、一人が複数のGroupへ参加できる。Group参加の複合外部キーは同じWorkspaceへの所属を要求する。初期版にはグループ階層、独自ロール、グループからの権限継承を設けない。

2026-10-07、利用者の追加指定により、累計作成3個から現在所有50個へ変更した。招待参加数には上限を設けない。Workspaceのowner_user_idを現在所有の正本とし、created_by_user_idは不変の履歴として保持する。ownerをmembershipの第3の管理権限にする案と比較し、既存admin/memberの認可を維持できる明示owner列を採用した。所有者は一人のadmin所属で、退出・削除・降格は譲渡まで禁止する。admin所属は遅延制約、所属自体は複合FKでも保証する。削除機能は追加していない。

所有者は参加中の有効なメンバーへ7日期限の譲渡を申請する。有効pendingはWorkspaceごとに1件で、承諾・辞退は受取本人、取消は申請元だけが行える。承諾時に現在owner、元所有者のactive/admin、受取人のactive所属、期限、所有50個未満を確認し、所有権と申請の消費を同一transactionで更新する。旧所有者はadminで残り、業務ロールとGroup参加を保持する。受取人が退出・除籍された申請は取消となり、再加入しても復活しない。確定済みの同操作再送は無操作で成功し、再譲渡後に古い承諾を送っても所有者を巻き戻さない。

作成と承諾は現在所有数を同じquota advisory lockで保護する。承諾では旧・新所有者のUUID順にquota lockを取得してからWorkspaceをロックする。既存の招待承諾がWorkspaceからUserへ行ロックを取るため、User行を先にFOR UPDATEしない。二重の件数カウンターは持たず、譲渡成立後に旧所有者の枠が空く。最後の有効adminも退出・削除・降格できない。

所属0件を許し、初回に作成か招待参加を選ぶ。個人用Workspaceは自動作成しない。所属解除時はGroup参加も削除し、再参加時はmember/generalから始める。過去の管理権限やGroup参加を復元しない。

## 招待と本人確認

adminがメールアドレスを指定し、有効期限7日のリンクを発行する。アプリからのメール配送は行わない。秘密は32bytesの乱数、DBにはSHA256だけ保存する。初回応答でだけ全文を返し、同一キー再送は既存招待を維持してtoken:nullを返す。失くしたリンクは取消して明示的に再発行する。応答不明を理由に既に渡したリンクを自動で無効にしない。

参加時に有効期限・取消・現在の招待者のadmin資格・宛先を確認する。IDトークンのemail_verified=trueかつ妥当なemailだけをusers.verified_emailに保存し、未検証・欠落時はNULLへ戻す。メール一致だけで別のissuer/subjectを統合しない。リンク受取人もログインし、確認済みメールが宛先に一致して初めて参加する。使用済み招待の再送は現在も同じ所属がある場合だけ同じ結果となる。

## 会話・実行と失効

新規会話と実行はWorkspaceとownerを固定して保存する。参照・追記には現在の所属と本人ownerの両方を要求し、管理者にも他人の会話を公開しない。URLでWorkspaceを指定して別タブの切替と混同させず、APIのX-AX-Workspace-IDで同じ境界を検証する。旧API関数の実行権は外し、Workspace確認を通る関数だけをruntimeへ許可する。

開始側のcreate/resume/stage/egress_prepare/egress_allow/startのintent確定時にも有効なUserと所属を確認する。P0001/workspace_access_revokedというDBの確定拒否だけをGoが識別し、外部操作前は送信権0件などを再検査してnot_startedへ終了、操作後は同じclaimでdeny/suspendへ進む。通信断、heartbeat喪失、外部操作の応答不明は従来どおり保留し再送しない。既に開始した処理の回収・後片付けと所有者の安全な復旧要求は、所属解除後も許可する。メンバー削除を即時モデル取消とは扱わない。

v1スキーマを変更せずv2を追加する。旧会話・実行のWorkspaceはNULLのまま保持し、本人限定の参照・復旧のみを許す。勝手なWorkspace割当や共有はしない。既存の費用・未知usage・同一失敗・全体実行枠の制約はWorkspaceをまたいで維持する。

## 所有権の追加移行

v1/v2のSQLとchecksumを保持してv3を追加した。作成者が現在active adminである全行だけを最初のownerにし、退出・降格・停止のある環境では全体をrollbackする。自動再参加・復権・別admin選出はしない。実ローカルの17実行・2会話・16成果物と既存の所属・Groupは内容hashで保持を確認した。実Keycloakの二人が往復譲渡し、枠の移動と新Workspace所有者による他人の成果物参照拒否を確認した。詳細は `.space/tasks/ax-workspace-access/ownership.md` と担当検証記録。

## 採用理由と確認範囲

認証基盤の組織機能を所属の正本とする候補と比較し、アプリの会話境界、SQL制約、将来の認証プロバイダー変更を同じ正本で扱える構造を採用した。詳細比較は `.space/tasks/ax-workspace-access/design.md` と候補A/B、実装契約はplan.md、結果と限界はverification.mdおよび担当別証拠に残す。

現ローカルKeycloakは管理者が用意したアカウントを使う。公開自己登録・確認メール配送・Entra/Cognito同期・RAGやスキル権限への接続は本変更に含めない。実装・検証を一つのPRへまとめ、設計の補足ごとにPRを作らない。

## スキル・エージェント登録のWorkspace境界

2026-10-07、利用者は、画面から登録する本人用のスキル・エージェントもWorkspaceごとに分け、なるべくそのWorkspaceに閉じる方針を指定した。共有用は現在の全メンバーが登録でき、作成者とWorkspace管理者が編集できる。共有するのは再利用可能な指示・設定・補助資料であり、実行者の会話・入力ファイル・成果物を共有しない。本人用に対して管理者だから読めるという権限は付けない。

組み込みの基本指示・標準スキルのGit管理は開発時の原本管理を意味する。実行時は製品へ同梱したファイルを読み、Gitサービスを保存基盤として要求しない。画面登録した内容はapp PostgreSQLで版管理し、利用者にGit操作を要求しない。設計・実装契約は `.space/tasks/ax-agent-workbench/registry-contract.md`。この追記時点では登録機能を実装中で、稼働済みの証明ではない。

# Related Concepts
- [ローカルWebの境界と非同期実行](../../../knowledge/ax-web-foundation.md): 所属境界の採用理由を現在のWeb構成へ対応付ける
