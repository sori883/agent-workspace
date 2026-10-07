# 登録画面とAPIの検証

2026-10-07、親。スキル・エージェントを選択Workspaceに登録し、下書き保存、公開、公開版参照、コピー、利用終了までのAPI/BFF/UIを追加した。新規は公開範囲を明示選択し、変更はcopyで新しい設定を作る。本文はtextとして表示しHTML実行しない。APIはJWTから本人を解決、Workspace header、strict JSON、BFFはOrigin/CSRFを検査する。登録要求は192KiB、本文上限128KiB、応答512KiB。旧API要求64KiBの上限は維持。

通信結果が不明なmutationはbody/keyを保持し、同一送信の照合を行う。確定した400/403/409等は入力を修正できる。保存revisionのCASで他の編集を上書きしない。指示と補助資料を共有しても、本人の作業file・会話・結果を共有しない。

## 結果

- TypeScript typegen/型検査、production build成功。API境界試験1/1成功。
- v7共通migrationを含むfile/definition/workspace/APIの専用DB試験58/58成功。後続の公開版name追加は定義DB16件＋API1件＋型検査で再確認済み。
- Chromiumの登録画面2/2成功（最終session2057、5.1秒）。登録受付後の503喪失→同key再送で単一登録、補助資料、下書き更新→第2版公開→旧版本文維持、CSRF403・owner偽装400、一覧filter、agentのskill版固定、copyの明示共有、archive後の履歴保持を確認。
- draftだけの改名が公開版選択名に混ざる独立指摘R1を修正し、公開版nameを使用する回帰を追加。スキルの公開nameのまま第2版を選択し、再読込み後も版を保持した。
- 320pxで横overflowなし。axe WCAG2 A/AA・2.1 AAタグの自動検査は違反0件。全アクセシビリティ適合を保証する検査ではない。mobile screenshotを目視確認し、ラベル・入力・版選択・操作が読めることを確認。

初回のbrowser試験ではselectのラベルへoption本文が混ざる箇所を発見し、label/forへ修正。続く失敗2回はテスト側のaccessible nameの空白と閉じたdetails内の旧表示を選んだlocatorによるもので、実際の画面構造を確認して対象を修正した。これらを成功と数えず、最終の全2件成功を採用した。

証拠は [レビュー](registry-web-review.md)、[保存検証](registry-verification.md)、[保存層独立確認](registry-store-review.md)、[320px表示](evidence/registry-editor-mobile.png)。

## 未実施

専用DBの試験であり稼働DBへv7を適用していない。localhost:3100は基点版のまま。登録した定義を実Runtimeで使う経路、Python実Actor、定期実行は次の実装単位。課金・commit/PRは行っていない。
