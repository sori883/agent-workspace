# 容量テストのCI用データ準備を分割する

PR #20の初回Web CIでは、`seedReady(127, actors)` が約1GiBのchunkを一つのINSERTで準備し、10秒のstatement timeoutで失敗した。失敗箇所はseed helperで、容量競合のassertionには未到達だった。

- 失敗CI: https://github.com/sori883/agent-workspace/actions/runs/37667024533/job/112948761963
- 修正: 同じtransaction内で、1ファイル（8MiB/256chunk）ずつINSERTする。全件ready化、commit/rollback、総bytes、保存hash、10秒timeout、製品SQLとquota競合のassertionを維持した。
- ローカル: 専用`app_auth_test`の一時schemaでfiles.test.ts全18件成功、9.921秒。本人quotaは2.176秒、全体1GiB quotaは3.878秒。typecheck成功。
- 独立レビュー: `/root/w1_design_review` が変更と失敗ログを読み、同一transaction・総量・ready化・rollback・競合検証・timeoutの維持を確認。必須指摘なし。テスト再実行は親が担当した。
- 検証対象SHA-256: `d41abcd29dbf49b03517f1a0f5f2613e8dae74f1d75ffcaabced4d1a765914c2`
- 確認日時: 2026-10-07T18:37:50.918453+00:00

本変更はテストデータ準備だけ。製品コード・画像・保存上限・権限は変更せず、有料試験は追加していない。既存の製品側レビューと実AX証拠を再利用し、今回の局所差分を追加確認した。リモートCIの最終成否はPR #20のチェックを正本とする。
