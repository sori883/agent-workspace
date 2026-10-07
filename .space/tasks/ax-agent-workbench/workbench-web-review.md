# Workbench Web 独立レビュー

- 担当: B。親が実装した Web v2 を評価。自作の Go 実装はこの独立レビューに含めない。
- 基準: `ede929ea87af8173af128e7b8706c11d1a9b16f6`、共有 checkout の未コミット差分。2026-10-07。
- 対象: API workbench-service/app/runtime、shared workbench-transfer、BFF workbench client/copy、workbench/transfer routes、FileDownload、files-transfer list、route/navigation、API/browser tests と fixture。
- 最終読取 snapshot: `bfe9a5ca0c70f67f9e48c04ac3ac845efa4c111a2c664dc432a2d0a7f329485f`。対象16ファイルの順序付き `path + NUL + SHA256(file bytes) + LF` の SHA256。workbench.tsx 単体 `4a1e6be20a43537c35f94f86ac151af3ecd17a9ef220e4d7e02145add2869486`。
- 手順: devlow/review、interrogate reviewer-prompt、DADS を適用。OKF path 検索は workbench.tsx → knowledge/ax-web-foundation。既読の boundary-discipline、idempotency、auth/workspace/agent-runtime、model-spending 制約を継承。秘密・稼働環境・モデルへアクセスしていない。

## 指摘と修正確認

### R1 / P2: 一覧の次ページが回答キーを新規受付へ流用する

初回版の `web/app/routes/workbench.tsx:121` は root 詳細からのページ移動でも `draft=initial.draftKey` を生成した。root 詳細の draftKey は `answerKey(root.id, root.revision)` であるため、50件超の一覧をページ移動して新しい作業を始めると、元の回答専用キーが start として消費される。元 root への回答は `ax_agent_requests` の kind 不一致で idempotency_conflict となる（schema-v8.sql の start/answer 再送判定）。

親へ共有し修正済み。最終版124–125行は requested rootId と draft を分け、root 詳細のページ移動で root を保持する。回答キーを新規画面へ伝播しないことをコードで再確認した。50件超＋回答待ち＋ページ移動のブラウザ回帰は親が実行する。

### R2 / P2: 一時的な詳細取得失敗で未送信回答を消す

初回版は waiting_input を3秒ごとに再取得し、GET失敗で root=null、draftKey=null となった。component key の変更で本文・結果不明の同一 packet が失われ、revision の effect も undefined への遷移で本文を消した。利用者が回答を入力中に API が一度503となるだけで成立する。

親へ共有し修正済み。最終版51/56行の requested rootId で component identity を維持し、65–69行で取得成功時の revision 変更だけを採用する。70行は失敗時も同じ root の取得を継続し、128行の再読込も現在 URL を維持する。入力 state と uncertain packet が取得失敗だけで初期化されないことを再確認した。GET503→成功の入力保持回帰は親が実行する。

## その他の確認

- start は公開済み version ID と本人 ready file ID を送る。設定名は公開版名、実行側で利用権を再確認する構造。本文・結果を共有へ変える UI はない。
- 不明な POST 結果は保存した同一 packet/key で再確認する。owner/期限/fingerprint は認証 context から API へ入り、本文で指定できない。workspace は明示 header で渡る。
- BFF mutation は Host/Origin、CSRF、strict schema と入力上限を確認する。API/BFF は2 MiB応答上限・strict schemaを持つ。
- FileDownload は owner/workspace の既存取得経路を通り、各 chunk 長と全体 SHA256 を確認後に Blob を渡す。HTMLとして本文を展開しない。
- label/fieldset/legend、状態通知、エラーへのfocus、既存DADS layoutを確認した。親のbrowser試験は320px/axe/download/受付後503を含む。
- fixture は専用PGと合成 effect/preview、download用の合成結果1件。実AXの成立を示す証拠には数えない。

## 判定・限界

報告完了。P2二件は修正の独立コード再確認済みで、最終snapshotに追加の必須指摘はない。ブラウザ回帰・実Actor統合の結果は親の検証記録へ委ねる。本担当はブラウザ試験を再実行しておらず、未実測の成功は主張しない。OKFは親担当のため変更していない。
