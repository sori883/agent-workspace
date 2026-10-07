# 実モデル接続：UI・配備・検証helperの独立レビュー

2026-10-07。担当 `w1_design_review`。基点 `13eb7f1`、branch `codex/ax-real-model` の未commit差分を確認した。作成者は親。対象は `web/app/routes/agent.tsx`、`run-detail.tsx`、`components/workspace.tsx`、`app.css`、`web/tests/browser/agent-fixture.ts`、`agent.spec.ts`、`web/scripts/deploy-execution.ts`、`verify-interactive-local.ts`。同じモデルの別担当による部分レビューであり、PG/Gatewayの実装と実課金は対象外。

## 必須指摘

### P2：JavaScriptなしでは無料previewにも実モデル同意が必要になる

箇所：`web/app/routes/agent.tsx:134–136`。

初期SSRではmode=modelなので、`required`付きの同意checkboxが描画される。JavaScript無効時、またはhydrationが終わる前にpreviewのradioを選んでも、Reactによるcheckboxの除去は起きない。利用者が無料previewを選び、同意を未checkのまま送信すると、HTMLの必須検証でPOST自体が止まる。

影響：外部送信・課金への同意をしない利用者が、無料previewを開始できない。課金の迂回は確認していない。BFFの94行はmodel未同意を既に拒否するので、JavaScriptなしでも選択modeに適合する検証へ直す。例えばcheckboxのHTML `required` に依存せずBFFで検証するか、mode変更をサーバーへ反映する導線が必要。

最小再現：PlaywrightのJavaScript無効contextへ同じradio／required-checkbox構造だけを配置し、previewを選択した。結果は `selectedMode=preview`、`consent=false`、`consentMissing=true`、`formValid=false`。DB・モデル・アプリへの通信はしていない。修正後は実fixtureで「noJS preview＋未同意は送信できる」「noJS model＋未同意は拒否され有料受付されない」を確認する。

親がcheckboxの `required` を除去し、BFFのmodel未同意拒否を維持した版を再読した。新しいnoJS回帰はmodel未同意のサーバー拒否→preview未同意で開始→停止を確認する内容で、修正方向は適合する。その後、親の [verification.md](verification.md) でこの試験を含む6件と、追加のmodel受付ACK喪失1件の成功を確認した。P2は修正と回帰証拠により解消と判定する。

## 指摘以外の確認

- 初期modelの同意は未check。BFFはCSRF／Origin検証後、model未同意をAPI呼出し前に拒否する。previewのAPI bodyはallow_model=falseへ正規化する。
- rootの回答ではmodeをAPIへ送らず、既存rootのmodeを表示する。uncertain状態ではradio／checkboxを無効にし、元modeと同意をhiddenで保持する。text/keyも維持する構造を確認した。
- 実行詳細と一覧はagent_modeで実モデルと旧previewを区別する。金額は記録済み概算とし、previewだけを課金なしと表示する。
- 配備helperは既定でmodel gateを閉じ、`--enable-model`がある場合だけ既存SecretからGEMINI_API_KEYを選んでコピーする。stdin経由でapplyし、CLIエラー本文を出力しない。鍵volumeはexecution containerだけへmountし、AXのax-runtime注入禁止とTask templateの制約を維持する構成。
- 検証helperは既定preview。real-model指定時だけ同意をcheckし、start／answer POSTをそれぞれ一回に制限する。最初の質問成功、reload保持、正の概算料金を確認してから回答する。失敗・不明時に再送しない。生成回数や実停止・費用正本は別途照合が必要であることを証拠の限界に記す。

SecretのhashがPod annotationに含まれない点は今回の必須指摘としない。現Gateway設定はキーを関数経由でファイルから読み、起動時キャッシュにはしていないことを接続箇所だけ確認した。Secretの投影更新を待たずに同じkeyを使い続ける保証はしていない。

## 判定と残件

上記P2は解消。その他、対象範囲で追加の必須指摘はない。親の型・build、配備／検証helperの単独型検査、ブラウザ7件の成功報告と記録を確認した。追加のmodel受付ACK喪失試験はfixtureで503を返し、reload後の同じroot・1turn・1区間分の料金とmode変更UIなしを確認している。本担当は実fixtureブラウザ試験や配備を再実行していない。modelはfixtureであり、実課金や実AX成功の証拠とは区別する。

稼働DB・Kubernetes・秘密ファイル・モデルは操作していない。製品コードを変更せず、この報告だけを保存した。
