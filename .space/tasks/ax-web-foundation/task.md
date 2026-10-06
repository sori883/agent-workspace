# W1：WebとAPIの土台

更新日：2026-10-06。状態：実装・ローカル検証完了。基準：`7b5968c`、作業ブランチ：`codex/web-foundation`。

利用者の「次の作業を確認して進める」という指示を、前回のcheckpointと公開設計に照合した。今回の区切りはW1。React Router Framework ModeのSSR/BFFとHonoの共通APIをローカルで起動し、ブラウザからの実HTTP疎通を確認する。デジタル庁デザインの基本・ボタン・テキストエリア・通知を参照した確認画面を作る。

## 範囲と条件

| ID | 受け入れ条件 | 確認方法 | 結果 |
| --- | --- | --- | --- |
| W1-1 | 単一コマンドでWebとAPIがloopbackに起動し、終了時に自分のプロセスを回収する | 開発・ビルド後起動、ポート競合・終了確認 | 合格。dev/start起動、dev/startのWebポート競合、devのAPI停止・終了回収をブラウザ試験で確認。独立担当がAPIポート競合も実測 |
| W1-2 | 初期HTMLに画面が含まれ、フォームからBFF経由でAPIの模擬応答を表示する | SSR取得、ブラウザ操作、API受付ID照合 | 合格。SSRのHTML、ブラウザの往復、JavaScriptなしの通常POSTを確認。画面の確認番号とAPIログを照合 |
| W1-3 | 内部設定をブラウザに渡さず、Host/Origin/session/CSRFと入力上限を検証する | 境界テスト、client出力・ブラウザ通信確認 | 合格。境界テストと実HTTPで拒否を確認。生成clientに秘密設定名・API設定なし。ブラウザ通信はWeb originのみ |
| W1-4 | API不通や入力不備を表示し、自動再送せず入力を保持する | 不通・異常応答試験とブラウザ確認 | 合格。API停止で503とエラー表示・入力保持、空白入力400、Cookie消失403時の入力保持、本文途中のtimeout・異常応答と再試行なしを確認 |
| W1-5 | 狭い画面とキーボードで操作できる | desktop/mobile、focus、アクセシビリティ検査 | 合格。320px幅で横スクロールなし、44px以上の送信ボタン、skip linkと結果へのfocus、axe自動検査0件。1440/390pxの実画面も目視確認 |
| W1-6 | 既存AXを変更せず、モデルAPI送信なしで確認できる | 差分と依存先の確認 | 合格。ax-local差分なし。AX・kind操作0件、モデルAPI送信0件 |

W2の実AX接続・永続実行記録、W3のタスク一覧/成果物表示、共通認証・AWS・モデル送信は後続。確認用POSTはメッセージの往復だけであり、Taskを作成しない。GET・SSR・起動から実行を開始しない。

## 設計の比較と採用

既存のSSR/BFF→共通APIという責務は再利用。新しい起動・障害境界のみ、devlowの設計手順で独立担当A/Bが探索し、第三の担当が比較した。全員同じモデルであり、モデルの多様性を持つレビューではない。

| 候補 | 構造 | 利点と不利益 |
| --- | --- | --- |
| A | 単一Nodeプロセス、Web/APIの別loopbackリスナー | 起動が単純。障害・再起動が一体になる |
| B（採用） | Web/APIを別Nodeプロセス・別loopbackポート、最小supervisor | 実HTTP・API単独障害を試せ、W2でAX操作をAPI側に追加しやすい。起動管理が増える |

親の評価と独立比較はBで一致。supervisorは起動・準備確認・自分の子の終了に限定する。Webだけを開発時更新し、APIは自動再起動しない。起動途中の失敗は全体を終了し、稼働後のAPI停止ではWebを残してエラー表示する。通信は本文の読み終わりまで3秒、再試行なし。秘密値は引数やログへ出さない。

Aのメモリsessionは取り込まず、署名付きCookieにCSRF値と絶対期限を保持する。サーバー側にsession表を持たないため件数上限は不要。起動ごとの署名鍵で再起動時に失効する。loopbackは同じPCの別プロセスを隔離する仕組みではなく、複数利用者向け認証はW1に含まれない。

## 実装の契約と順序

親担当が `web/`、公開文書、CI、タスク記録、OKFを所有する。A/B/比較担当は読み取り専用。既存の `ax-local/` は変更しない。

1. `web/shared/` に疎通の要求・応答と入力上限、`web/server/` に設定検証を定義する。
2. Hono APIの `/v1/status` と `/v1/connection-check` を実装する。全APIでHost・起動時Bearerを検証する。
3. SSRのloader/action、署名Cookie、Origin/CSRF、server-only API client、確認画面を接続する。
4. 型・境界・ブラウザ・停止/起動を検証し、独立レビュー後に通常のPR経由で反映する。

疎通用メッセージは200 UTF-16 code units、要求/応答本文は16 KiB。これはW1の疎通契約であり、既存Task入力上限を変更しない。Webは `127.0.0.1:3100`、APIは `127.0.0.1:3101` を既定とし、portだけ設定可能とする。サーバー間資格情報・Cookie署名鍵は起動時生成し、clientにはCSRF値だけ渡す。

## 根拠

- [前回checkpoint](../../checkpoint/ax-web-architecture-resume.md)、[公開設計](../../../docs/web-architecture.md)、[W1〜W4の概算](../../../docs/web-mvp-estimate.md)
- OKF：`principles/boundary-discipline`、`principles/foundational-thinking`、`principles/prove-it-works`、`rules/ax-model-spending`、`rules/pr-delivery`。全rule/principle候補は同セッションで取得済み。新規 `web/app/routes/home.tsx` のパス検索は0件。
- [React Router Framework Mode](https://reactrouter.com/start/framework/installation)、[session](https://reactrouter.com/explanation/sessions-and-cookies)、[serve](https://reactrouter.com/api/other-api/serve)、[Hono Node](https://hono.dev/docs/getting-started/nodejs)
- デザイン参照：導入済みDADSの `foundations/{color,typography,spacing,layout}` と `components/{button,textarea,notification-banner}`。本文16px以上、行高1.5以上、44px以上の操作領域、可視ラベル・フォーカス・色以外の状態表示を採用する。OSフォントと本アプリの配色を用い、完全適合を宣言しない。

## 検証とレビュー

実装対象は本ブランチの `web/`。macOS arm64、Node 24.15.0、Chromiumで以下を実行した。CIは `.github/workflows/web.yml` に同じ確認を用意し、PRでLinuxの結果も確認する。

| 確認 | 結果 |
| --- | --- |
| `npm --prefix web run typecheck` | 成功 |
| `npm --prefix web test` | 境界テスト5件成功 |
| `npm --prefix web run build` | client/SSR両方成功 |
| `npm --prefix web run test:e2e` | ブラウザと起動管理の7件成功 |
| `npm --prefix web audit --audit-level=high` | 脆弱性0件 |
| OKF `validate --strict --drift` | 30 concepts、error/warning/broken/orphanなし |

[初期画面](evidence/desktop.png)、[送信成功](evidence/success.png)、[390px幅](evidence/mobile.png)は実ブラウザの画像。目視で文字・操作領域・余白・折り返しを確認した。axeは初期/成功状態のdesktopと320px幅を対象とし、WCAGの完全適合や全支援技術での検証を意味しない。

実装は親担当が所有し、`interrogate`の手順でA（要求元・セッション・秘密情報）とB（起動・終了・障害）に独立して読み取りレビューを依頼した。担当は同じモデルで、実装コードの作成には参加していない。指摘と対応は次のとおり。

| 発見者 | 指摘・観測 | 採否と対応 |
| --- | --- | --- |
| A | session失効時にJSなしのフォーム入力が消える | 採用。構造検証後、session検証前に表示用入力を保存。Cookie消失時の実ブラウザ試験を追加 |
| B | 使用中のWebポートが200を返すと、一瞬起動成功を通知する | 採用。起動時の鍵で署名Cookieを検証してからreadyとする。dev/start双方で競合試験 |
| B | 生成元のDockerfileと現在の起動コマンドが不整合 | 採用。W1に不要なDockerfileと生成元の案内・未使用資産を除去し、ローカル手順を記載 |
| 親とB | index routeの直接POST試験が実Formと異なり405になる | 試験を実経路の `/?index` へ修正 |
| 親 | no-referrerによってJSなしのPOSTがOrigin:nullになる | same-originへ変更し、通常form送信が通ることを実測 |
| 親 | 503後に接続状態欄が古い成功表示を残す | actionの接続失敗を表示に反映。API実停止でエラー・状態表示・入力保持を確認 |

修正後にA/Bが該当コードと回帰試験を再確認し、担当範囲の指摘は解消した。最終7件のブラウザ試験は親が実行した証拠を共有しており、再確認担当自身の再実行とは区別する。

## 引き渡しと次の作業

W1の実装・文書・記憶・検証を通常のPRで引き渡す。利用画面は `http://127.0.0.1:3100`、起動方法は `web/README.md`。模擬応答の確認までであり、実AX接続・タスクの永続化・共通認証・公開配置は含まない。

次はW2。既存Pythonの開始・回収処理を共通API内部から利用し、HTTP応答後も管理する実行受付・ID・状態/結果の照会・永続台帳へ接続する。費用台帳、排他、二重開始防止、使用量不明時の停止条件を維持し、まずoffline経路で確かめる。W2の実装にはまだ着手していない。
