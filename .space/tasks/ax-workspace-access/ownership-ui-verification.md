# 所有権 UI の実装と検証

2026-10-07。対象は `codex/workspace-ownership`、基準 `ec7c9e44862d58c6c221d8b17ec123f27fd5af26` と今回の未コミット差分。担当は `ownership-ui`。採用Aの `ownership.md` と共有Zod契約に接続した。

## 変更

- `web/app/routes/workspaces.tsx`: 現在の所有数 / 50、所有者表示、譲渡による枠返却と招待参加無制限の説明。
- `web/app/routes/workspace-manage.tsx`: 所有者の降格・除籍・退出を画面から防止。BFF actionで譲渡申請と承諾・辞退・取消を受け、CSRF確認後に共通APIを呼ぶ。申請に失敗した場合は同じkeyと選択を保持する。
- `web/app/components/ownership.tsx`: 現所有者、7日間の申請、受取人だけの承諾・辞退、所有者だけの取消。承諾による管理権限・所有数・退出条件とprivate記録の保持を説明。5人以下の譲渡先はradio、6人以上はOS標準selectを使う。
- `web/app/lib/workspaces.server.ts`: proposeOwnership / respondOwnership。ID・入力・応答を共有Zodで検証し、既存の制限付きHTTP/タイムアウトを使用する。
- `web/app/lib/workspace-copy.ts`: 新しい所有上限・所有者保護・申請失効等のエラー案内。
- `web/tests/browser/organizations.spec.ts`: 上限と譲渡の回帰試験。

## 確認済み

- `npm run typecheck`: 成功。追加試験のform型の修正後に再実行して成功。
- `npm run build`: 成功。
- `npm run test:e2e -- organizations.spec.ts`: 10 / 10成功、35.1秒。
- 作成・同key再送・独立タブを保ち、50件で作成UIを閉じ、直接POSTの51件目を409で拒否。
- JS有効 / 無効の両方で、二人のログイン、譲渡申請→取消、再申請→辞退、再申請→承諾を画面から実行。
- 管理者が複数いても所有者の降格・退出・除籍は409。所有者でない管理者からの申請と、受取人以外の承諾は403。不正CSRFも403。
- 譲渡後は旧所有者がadminで残り退出可能。業務ロールとグループ所属が維持され、受取人に旧所有者のprivate会話は表示されない。同じ承諾の再送も成功し、所有数は増えない。
- 50件所有中の利用者でも招待参加できる。譲渡承諾は409で拒否。別の所有Workspaceを譲渡して49件にした後、元の申請を承諾すると50件になる。
- 320pxで横スクロールなし。申請の受取画面をaxeのwcag2a / wcag2aa / wcag21aaで確認し違反0。JS有効 / 無効のスクリーンショットも目視した。
- `git diff --check -- web/app web/tests/browser/organizations.spec.ts`: 成功。

画像はブラウザ試験が生成する `web/test-results/organizations-ownership-tr-85644-ivate-data-JavaScript-true-/ownership-320.png` と `web/test-results/organizations-ownership-tr-0a6a5-vate-data-JavaScript-false-/ownership-320.png`。無視対象の実行成果物であり、後の試験実行で再生成される。

## DADS と限界

DADS statusはinstalled=true / check_due=false。ローカル公式資料 `foundations/layout/index.md`、`components/select/index.md`、`components/button/index.md` を参照し、既存の余白・書体・ボタン・フォーカスと入力部品のスタイルを再利用。新しいCSSトークンや独自の選択リストは追加していない。全DADS/WCAG適合の宣言ではない。

試験は専用 `app_auth_test` の `ax_browser_workspace` schema、実WorkspaceRepositoryとOIDC fixtureを利用した。会話・実行は既存の模擬サービスであり、モデル呼出しは0。実Keycloak・実app DB移行・稼働確認は親の担当。6人以上のselect表示、期限経過・並行承諾等の全DB条件はこのブラウザ単位では確認していない（共有API/SQL担当の試験と区別する）。

全ブラウザ回帰 `npm run test:e2e` は34 / 34成功（1.4分）。ログイン・失効・本人境界・チャット継続・起動終了・従来の実行フォーム・JSなし・320pxも通過した。担当範囲の実装と検証は完了し、親の受け入れと最終レビューへ渡す。
