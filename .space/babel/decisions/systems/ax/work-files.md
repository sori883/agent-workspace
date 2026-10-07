---
governance: context
code_refs: 
  - web/data/schema-v6.sql
  - web/data/files.ts
  - web/shared/file-contracts.ts
  - web/shared/file-transfer.ts
  - web/api/file-service.ts
  - web/app/routes/files.tsx
  - web/app/routes/files-transfer.ts
  - web/app/lib/files.server.ts
  - web/tests/files.test.ts
  - web/tests/file-api.test.ts
  - web/tests/browser/files.spec.ts
  - web/data/schema-v8.sql
  - web/data/workbench.ts
  - execution/native/code_transfer.go
sources: 
  - resource: .space/tasks/ax-agent-workbench/file-contract.md
  - resource: .space/tasks/ax-agent-workbench/files-verification.md
  - resource: .space/tasks/ax-agent-workbench/files-integration-verification.md
  - resource: .space/tasks/ax-agent-workbench/files-review.md
  - resource: web/data/schema-v6.sql
  - resource: .space/tasks/ax-agent-workbench/evidence/actual-ax-fixtures.json
type: decision
title: 本人用作業ファイルをPostgreSQLで分割保存し不変確定する
description: CSV・Excelの私有ファイルについて保存上限、再送と確定、所属失効時の予約回復を定めた理由と実装範囲
generated: 
  by: agent:codex
  at: 2026-10-07T17:42:52.620Z
---
# 本人用の作業ファイルを分割保存して確定する

2026-10-07、CSV・Excelの集計と結果ファイル作成を最初の実用化対象とする利用者の回答に基づく。`codex/agent-workbench`で保存・再取得経路を実装し、専用DBとブラウザで確認した。2026-10-08には稼働app DBをv8へ移行し、実AXの固定CSV/XLSX集計・8MiB搬送・結果登録と通常controllerへの復帰を確認した。モデル提案を固定した試験と、実モデルの生成品質は区別する。

## 保存先と所有

初期のCSV/XLSXはapp PostgreSQLのbyteaへ32KiBずつ保存する。1ファイル8MiB、本人の保存総量256MiB、アプリ全体1GiB、本人の未完了送信4件という上限を持つ。別のobject storageとその認証・整合性管理を先に増やさず、現在の外部接続可能なPostgreSQLを利用する判断。将来の移行用に参照はfile UUIDとし、Task内のpathやDB列を公開上の識別子にしない。

ownerは共通APIが認証から確定した内部user ID、workspaceは現在の所属で検査する。workspace adminにも他人のファイルを公開しない。スキル定義を共有する方針は入力・結果の共有許可ではない。保存層はbytesを保持する責務で、拡張子やmedia typeを内容の安全性の保証にしない。

## 完成と再送

begin時に総サイズ分を予約し、未完了分も容量へ算入する。同じ受付キー・同じ要求、同じchunk位置・同じbytesの再送だけを許可する。chunkが全部そろい、総長とSHA-256が一致したときだけ一つのtransactionでreadyへ移る。readyのbytesは不変とし、未完了データを通常downloadや実行へ渡さない。受付後の応答喪失から再送してもファイルを重複作成しない。

SQL v6を追加し、既存v1〜v5は変更しない。API用DBロールには限定したファイル関数だけを許可し、保存表やcontroller権限を公開しない。Node固有のfilesystemやプロセスに共通APIを依存させない。

## 所属喪失と容量の回復

所属を失ったworkspaceのファイルを読み取ったり送信継続したりできない。ただし未完了送信が本人全体の上限を塞ぐため、現在所属するworkspaceから本人の明示操作で、利用できなくなった未完了送信だけを取り消せる。旧workspaceの内容やmetadataは返さず件数だけを返す。対象owner・uploading状態・現在の所属なしを再検査し、再加入したworkspace、他人、readyファイルを除外する。予約解放は一回だけ、受付キーの記録は残す。

完成ファイルを自動削除しない。長期保存期間、完成ファイルの削除操作、共有スキルの添付は後続の利用経路で決める。controllerによる結果登録は、rootの本人とWorkspaceに固定し、通常uploadと同じ容量予約・全chunk照合を通してからreadyへ確定する。

## 実行時の搬送

v8ではroot開始時に本人のreadyファイルをalias・UUID・size・hashで固定する。入力は32KiBずつ直接mTLS RPCで隔離されたcode Taskへ渡す。子が終了してから信頼側が指定出力だけを検査・封印し、controllerが同じ分割経路で回収してPGへ登録する。次のRuntimeへ進む前にcode Taskの停止とhost一時領域の回収を確認する。

実AXの単一8MiBは256chunkずつ、端数を持つ4ファイル合計8MiBは259chunkずつを入出力し、全bytes/hashが一致した。後者の実作業時間は153213msで300秒枠内だった。固定CSV/XLSXの集計結果と、各3区間の停止・通信deny・worker未割当・同一世代cleanupも確認した。永久証拠の抜粋は `.space/tasks/ax-agent-workbench/evidence/actual-ax-fixtures.json`。

## 根拠と範囲

保存境界・権限・並行競合は `.space/tasks/ax-agent-workbench/files-verification.md`、APIとブラウザ経路は `files-integration-verification.md`、独立レビューは `files-review.md` に記録した。保存テストの成功を任意Pythonの隔離やAX実行の成功とは扱わない。

# Related Concepts
- [共通APIと実行管理を分離しPostgreSQLへ保存する](portable-api-postgres.md): 共通APIと外部PostgreSQLの保存境界を私有binaryファイルへ広げる
