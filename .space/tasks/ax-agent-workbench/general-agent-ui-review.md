# 汎用エージェント・導線整理の最終レビュー

2026-10-08 JST / 担当C。対象はPR #20後の追加差分と [general-agent-ui.md](general-agent-ui.md) のG1〜G5。今回の製品差分には実装参加していない別担当として、既存レビューを再利用し、最終変更と保存証拠を照合した。同じモデルによるレビューであり、人間・異なるモデルによる独立監査ではない。

## 判定

追加の必須修正はない。G1〜G4は今回の限定範囲で確認済み。G5の検証・レビューは確認済みで、PR作成・CI・反映は親の後続作業として残る。新Thread、完了した依頼間の自動文脈継承、定期実行、道具や費用枠の拡大を完成扱いにしていない。

| 条件 | 確認内容と判定 |
| --- | --- |
| G1 標準Runtimeの汎用化 | general指示を常時、tabular指示をdescriptorのファイル参照がある区間でロードする実装。添付なしの文章応答が実AX・実モデルで成功し、model1/Python0/結果file0。名称変更だけではない。一般的な相談・文章品質の網羅的保証はしない |
| G2 組み込み一覧と動作 | WebとRuntimeが同じcatalog JSONを使用。Runtimeは固定ID/path・本文SHAを検査し、未選択の本文改変も拒否する。image `22a4a52d…` 内のcatalog/general/tabular一致は親の構築検証記録、UI表示は保存画像とブラウザ結果で確認。旧imageの確認を新imageの証拠へ流用していない |
| G3 登録から公開版利用 | CTAは公開version IDをURLへ渡し、下書き名・最新下書きを実行しない。GETはkind/archive/本人/Workspaceを確認する読み取りのみ。POSTは既存経路で再認可。古い公開版、種類不一致、重複query、利用終了、別Workspace、同Workspaceの他人のprivate版を扱う最終試験も確認 |
| G4 入口と既存機能 | v2有限rootを主入口とし、本文を主操作、添付と追加skillを任意panelにした。Workspaceをコンポーネントkeyへ含め、確定したroot/draftと選択を分離。既存の質問回答・固定body再送・停止・回収と旧URLへの導線を維持。完了後は自動文脈継承しないと表示。desktop/320px画像で主要操作・説明の欠落は見られない |
| G5 検証・引き渡し | SDK20件、型・build成功、対象browser49件の最終成功を親/Aの記録で確認。browser件数は27件group＋他22件であり、修正後library4件の再実行を重複加算しない。実環境の限定確認・保存証拠照合を完了。PRは未作成のため、この条件全体の完了にはしない |

## 境界と最終限定変更

- 新しい保存体系・実行経路は追加していない。model同意、既存予算、本人の私有ファイル、公開版固定、権限失効、SDK tools無効・subagents無効・retry 0は維持されている。
- catalog本文はRuntime imageで固定される。今回の新imageとWeb原本の一致は確認されているが、将来別々に配備するときも同じ照合が必要である。
- JSON importに `with { type: "json" }` を付け、tsconfigのmoduleをESNextへ変更した。targetはES2022、moduleResolutionはbundlerを維持し、Node24+tsxとViteの確認記録が対応している。
- 公開版CTAのsr-only境界は空白を許容するselectorへ修正しているが、名前・版・hrefの検査は残る。製品の認可条件を試験へ合わせて緩めた変更ではない。

## 実モデル試験と誤判定の区別

[general-agent-live.json](evidence/general-agent-live.json) と [実応答画像](evidence/general-agent-live-result.png) を読んだ。root `c78be1c4-0cec-4e1d-9bab-0a354eed3e0e`、run `ax-run-44896fe7bbc68624` のIDはUI・PG・inspectで一致する。

実応答は「10月8日15時」「30分間」「開発定例」を含む69字の案内文である。画像で読める本文を転記し、69字と保存SHA `d63adcdf265abf439cc16d07a606259ee34b1df63c4931e892b7312673f77583` の一致も確認した。rootは添付0・登録skill0・agent指定なし。model1、tool1はoutput proposal、Python0、結果file0。実作業33,599msで1runがresolved/finished/job done/succeededとなっている。

初回のbrowser結果は `passed:false`、`answer_context_mismatch` のまま保存されている。旧predicateは空白を除いた「10月8日15時」の日付直後に数字があることを拒否した。修正版は日本語日付と数字形式の日付の境界判定を分け、日付の検査では空白を残す。Aの正負11例の確認と、現在の1行修正が対応し、network guard・送信・証拠保存は変更されていない。初回script全体を成功したとは扱わない。

その後のread-only recheckは新規start 0で、同root・同じ69字・同じanswer SHA・reload後一致を示す。追加生成して成功結果に置き換えた証拠ではない。

入力1,244・出力59・思考0から公開単価で再計算した概算はUSD 0.0003995で、operation/run/rootの記録と一致する。以前のUSD 0.006797を含む累計はUSD 0.0071965。2 operationはsettled、7 effectはconfirmed、slot空、holdなし、未解決/invalid 0。settled行に残る予約額は履歴であり、予約込み全体費用が既知費用と同じことも確認した。

正式inspectの保存結果はActor停止・AX Suspended・egress deny・worker未割当。Pythonを実行していないためcode cleanupはnullで整合する。保存closureはtrial/Gateway/workbench model閉、鍵mountなし、Secret削除、rollout ready、無料受付再開を示す。Cはこれらの保存結果を照合したのであり、live DB・AXへ再問い合わせしていない。

## 証拠の限界と残件

- 実モデル確認は合成の文章作成1件。相談全般の品質、実モデルによる追加のファイル集計、定期実行を今回新たに実証してはいない。
- 検証scriptの上限は1 browser start/1rootである。生成1回は今回の実測結果であり、scriptが強制する回数上限とは異なる。親の最終計画は既存root上限を維持することを明記している。
- browser/SDKの全suiteは担当者が実行した結果を読み、Cは再実行していない。UI画像からの目視とAxe該当項目の成功を完全なアクセシビリティ適合保証にしない。
- PR作成・CI・反映の完了は親が別途記録する。定期実行の版/入力方針の人間回答待ちは継続する。

最終照合版:

- Runtime adapter: `ee5929724ce9d9214c3271be750da4ab14672941bfcd3151695db3909a2bb592`
- catalog: `6da9fa1469c1e6cf4e031203f319479bf82a82681e697b98916aba8025cfcb2d`
- workbench UI: `ddb1936340172cc6c4b0cec3c764375cb03fd29cf91eba78e5a9c8d053d30aed`
- 修正後検証script: `c3b6548ce031fb0647daa8ff0fabe0abb2a076716f5fead8aa680bff63d2ce66`
- general-agent-live.json: `fce0580eaf9b964c17442418f7fb501a9ff78751878c3f293de753d6d5a02f2c`

変更したのは本報告だけ。製品・他担当の文書・OKF・原証拠は変更せず、追加のモデル送信・稼働操作は行っていない。
