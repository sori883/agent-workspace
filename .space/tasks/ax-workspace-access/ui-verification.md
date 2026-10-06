# U2: Workspace UI/BFF 検証

対象: `codex/workspace-access`、基準 `b07173e` からの未コミット変更。実施日: 2026-10-06。担当: ui/workspace-ui-1。台帳の受け入れは親が行う。

## 実装範囲

- `web/app/routes/{workspaces,workspace-manage,join}.tsx`: 所属一覧・上限3個の作成、メンバー/操作権限/業務ロール、グループ複数参加、メール宛先付き招待、退出。削除・所有権移譲・カスタムロール・メール送信機能は追加していない。
- `web/app/lib/workspaces.server.ts`: 認証付きHTTP、共有Zodの入力/応答検証、要求64 KiB/応答1 MiB、8秒期限、redirect/自動再送なし。全変更フォームでHost/Origin、CSRF、重複/未知フィールドと本文上限を検証する。
- `workspace-scope{,.server}.ts` と既存chat/run画面: URLの `workspace` をAPIの `X-AX-Workspace-ID` へ渡す。選択中の名前を表示し、会話/実行/成果物/回収/一覧更新のリンクへ引き継ぐ。複数タブで選択を共有しない。無指定は一覧へ戻す。
- `legacy=1` は本人の旧記録の読取りと終了確認だけ。チャット送信欄・新規実行欄を表示せず、細工したPOSTも403で拒否する。旧履歴GETでは新規受付用draftの補完redirectをしない。
- `components/{workspace,organization}.tsx` とCSS: DADSのラベル、説明、必須表示、操作権限と業務ロールの別fieldset、複数参加checkbox、結果通知、狭幅配置。認証処理とlogin routeは親の所有。

## 方法と隔離

`web/tests/browser/serve.ts` の組織APIには実 `WorkspaceRepository` を接続した。DBは `prepareTestAuth()` が専用 `app_auth_test` に限定し、browser専用 `ax_browser_workspace` schemaを作成・削除する。`PGOPTIONS` はテストmoduleだけで設定し、BFF/API/テストworkerの接続先schemaをそろえる。製品の認証設定へテスト用項目を追加していない。

OIDCはfixture。run/chatはownerとworkspaceをキーに持つメモリfixtureで、所属確認だけ実PGへ問い合わせる。組織試験の前に当該schemaの組織データを初期化する。実DBの通常schema、実Keycloak、AX、モデルへは操作していない。課金モデル呼出しは0件。

## 確認結果

- `cd web && npm run typecheck`: 合格。親が編集中だったruntime testの型不一致は親の修正後に解消を確認した。
- `cd web && npm run build`: 合格。最終入力修正を含むserver/client buildを作成した。
- 修正前ビルドの全回帰28件、追加の応答消失試験1件、およびCSS調整後の全29件が合格。
- 最終入力修正後: `cd web && npm run typecheck && npx playwright test --reporter=line` が成功。全31件、再試行0回、1.2分。group renameを含むclipboard貼付け試験もJavaScript有効/無効の両方で合格。
- `git diff --check -- web/app web/tests/browser`: 合格。終了後、専用testDBで `to_regnamespace('ax_browser_workspace') IS NULL` がtrue、fixture schemaの片付けを確認。

追加した組織試験は次を確認する。

1. 空所属の案内、同key作成再送、変更内容の409、最大3個、2タブの別Workspaceと会話非混在。
2. 招待リンクのコピー、未ログインからOIDCを経て元の招待へ復帰、宛先本人の参加、管理者と業務ロールの分離、2グループ参加、同Workspaceでも他人の会話を参照不可。
3. 最後の管理者のUI制限と細工POSTの409、CSRF拒否、除名後の管理画面404・会話送信不可。
4. 招待同key再送はtokenを再表示せず既存リンクを維持。メール不一致、verified email不足、期限切れ、取消を案内。
5. 旧履歴の新規/継続送信不可、再開始を伴わない終了確認、JavaScriptなしのグループ作成、320pxの横スクロールなし、axe。
6. PGへ保存した直後に503を返すfixtureで、Workspace/招待の入力とキーを保持。同じフォームの再送でレコードが増えず、失われた招待リンクは再表示できない旨を案内。
7. 101文字のworkspace/group名と254文字超メールをclipboardから貼り付け、全文保持・400・失敗入力保持をJavaScript有効/無効の両方で確認。グループ名変更でも対象グループへ失敗入力を保持する。

既存の認証7件・chat5件・run4件・接続画面5件・lifecycle3件も同じfixtureで検証する。認証で予期したCSRF/不正callback拒否のログは失敗に数えない。

## 不具合と修正

- 旧履歴への拒否POST後、loaderが新規draftへredirectして最終HTTP200に見える問題を試験で検出した。旧履歴ではdraftを要求しないためredirectを除き、403と送信不可を確認した。
- 独立レビューで新規NameFieldと招待emailのmaxlengthによる黙った切り詰めが指摘された。ソース修正後・再build前の旧配信物に貼付け試験を当て、101文字が100文字になる失敗を確認した。新buildではmaxlengthを外し、共有schemaの上限エラーと全文保持、名前のaria-invalid/エラー説明へ変更した。既存chatの入力方式へは広げていない。
- 320px目視でヘッダーの短いラベルが途中改行されていたため、400px以下だけheaderを折り返す配置とし、ブランド名/環境ラベル自体は途中改行しないようにした。

## 見た目と根拠

DADSのローカル参照は `dads-markdown-20260909.zip`（statusで更新期限内を確認）。Typography/Layout/Input text/Select/Button/Checkbox/Radioを参照し、選択肢が2つの権限・業務ロールにはラジオ、複数所属にはcheckboxを使った。axeは完全適合の証明ではない。

Desktop一覧/管理画面と320px管理画面を画像として目視した。ヘッダーの途中改行を解消し、情報の重なりがないことを確認。スクリーンショットはPlaywright生成物（再試験時に更新）:

- `web/test-results/organizations-empty-member-e2ad0--limit-and-independent-tabs/empty-workspaces.png`
- `web/test-results/organizations-email-invita-566ba-rivate-data-remain-separate/workspace-management.png`
- `web/test-results/organizations-legacy-is-re-b09f9-rganization-forms-fit-320px/workspace-320.png`

## 親の実環境確認への引き継ぎ

- 通常ログインは `/workspaces`。作成後の管理画面に「チャットを開く」がある。実AX offlineはそのWorkspace付き画面の「エージェントの実行」から行う。
- 名簿の表示名は実ログイン情報に従うため、fixtureのAlice/Bobという別名をselectorへ固定しない。権限・業務ロールの操作は対象memberカード内で行う。
- グループ参加は対象group内のメール/表示名checkboxを変更し、その行の「参加を保存」を押す。ボタンのアクセシブル名には視覚外の「（表示名）」と空白が含まれる。対象group内のformを `hasText: 実表示名` で絞るなどして操作する。
- 初回の招待リンクだけを保存・コピーして招待先の別ブラウザへ渡す。戻り先が招待画面であることを確認して「参加する」。同key再送のtoken:nullは仕様どおりで、必要なら取消後に新しい受付で発行する。
- 実Keycloak/AX経路、実Actor停止、再起動保持は親の全体verificationで判定する。U2のfixture成功をこれらの成功と読み替えない。
- OKFと共通設計は親が更新する。U2は製品と試験、検証記録だけを所有し、commit/PRは行っていない。
