# Workbench保存処理の統合レビュー

2026-10-07、親担当。Cのv8実装を親がレビューし、既存移行入口・API・Go/Pythonとの契約に照らして確認した。親自身が移行入口を編集しており、その部分について完全に独立したレビューではない。

- 定義の公開版と依存を固定し、本人/Workspaceの認可を受付・各区間・モデル送信・chunk取得で確認する。共有定義から私有ファイルや会話を共有しない。
- 既存の実行slot・operation・費用台帳を再利用する。結果やusageが不明な送信は再実行せず保持する。停止とcode cleanupが確認される前にslotを開放しない。
- 入出力は所有者・Workspace・runに束縛し、hash/sizeで封印する。未完了出力は画面へ出さない。known resultを保存した後の認可失効で既知結果を巻き戻さない。
- 旧v1のvalidator/履歴を維持し、新規v2が旧画面の厳密schemaを壊さない。
- 会話の依頼/回答/checkpointは時間順・17件/16KiB、一覧は先頭依頼のみの50件pageとして応答を抑える。

親レビューでcollect resultの型判定と出力ファイル名の言語間差を指摘。Cが明示型検査と64文字ASCII CSV/XLSX basenameへ修正し、PG/Go/Pythonの条件を揃えた。最終版を再確認し、追加の必須指摘なし。

専用DBのv8試験26件、移行入口をv8へ統合した後の全Node177件が成功した（`evidence/web-tests-v8.log`）。限定ロール、idempotency、境界値、取消、未知usage、停止、8MiB roundtrip、既存v1の回帰を含む。PG生成fixtureはGo/Pythonでもcanonical/hash一致。Browser側では実v8 DBを使う8経路が成功した。

実DB移行と実AX/cleanup伝播は未実施。無課金fixtureの停止証拠を実AXの停止証拠とは扱わない。Go recoveryの独立指摘は別unitで修正・確認中。

## 対象SHA-256

- `web/data/schema-v8.sql`: `a57c5e50ef41037178ef3a3d78d37c629e7663fa0da60ee623f7f703ec45ea68`
- `web/data/workbench.ts`: `002486c2e5009f651bf2b18518222abde8c1ee1036564eab7ce73eb4be59bfe6`
- `web/shared/workbench-contracts.ts`: `4b430266eac6c33f8ced18e921c46a547caa9642946d50bb21efdeb7ef25cc27`
- `web/tests/workbench.test.ts`: `63264cbec8aae354e4d18b51a7c9a9a427f7bcd31edbbc981ba0a0f657beca16`
- `web/data/db.ts`: `da0ee79db47c5274677ab180bf3dfc1ff8daaca0fd6b35604f0922e9fb8b570e`
- `web/data/permissions.ts`: `d7e3c5957b259121125465565d2c1c58ee27cd5b1987cccca670d1c8ddeed450`
- `web/server/data-migrate.ts`: `9685ae3765a80fb201b357abefb16edd5451466d4acdac6b6659e8e079e2a527`
- `web/tests/workspaces.test.ts`: `ec8287682a1bf2ea5aabc6a22184d9aa0e054b07183540a8260c27ef3dfd52d1`
