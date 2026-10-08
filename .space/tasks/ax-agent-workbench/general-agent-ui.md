# 汎用エージェントと依頼画面の整理

2026-10-08 JST。PR #20後の利用者確認からの追加依頼。標準がファイル集計専用に見えること、組み込みskillが一覧に出ないこと、登録後の利用経路がわからないこと、複数の実行入口で迷うことを修正する。

## 終了条件

- G1: 標準Runtimeが添付なしの相談・文章作成を直接扱い、表計算手順を必要な依頼に適用する。名称だけの変更にしない。
- G2: 組み込みagent/skillの用途と適用方法をlibraryで確認でき、表示とRuntime読込の原本が一致する。
- G3: 登録→公開→その公開版を選んだ依頼画面→送信まで辿れる。未公開、利用終了、別Workspace、本人用の他人参照を通さない。
- G4: 依頼本文を主操作にし、添付・追加skillを任意の操作へ整理する。既存chat/agent/tasksのURLと履歴、質問待ち・停止・回収を維持する。
- G5: 型・SDK/局所・ブラウザ・実環境の該当経路、独立レビューを確認し、意味のある1 PRで反映する。

実道具は既存の隔離Python、出力は会話本文/CSV/XLSX。任意ネット接続・追加package・新認可・費用枠拡大は含めない。定期実行の版選択は元タスクの人間回答待ちのまま。

## 設計比較

A（独立担当w1_design_a）: 既存chatを主にし、添付/skill時にworkbenchへ渡す。会話とroot関連表と文脈固定が必要で、二つの実行状態・予算を維持する。
B（独立担当w1_design_b）: v2を通常入口にし、Thread→Root[]へ新しい保存体系を追加する。統一会話には適するが、今回はUI整理に加えて完了後の発言の受付・文脈引継ぎ・新DB契約まで広がる。

今回採用する範囲はBの単一依頼入口・catalog共通原本・登録から利用する導線。既存v2の有限rootと質問回答を維持し、完了rootの自動再開や新Threadは追加しない。既存chatの継続会話と旧履歴は補助導線から利用できる。新依頼の汎用化と画面整理に新保存体系は必須ではないため、予算・履歴所有の再設計は分離する。完全な会話統合を実装済みとは報告しない。

## 所有と実行順

- A: Runtime専用指示、general/tabular builtin skill、共通catalog JSON、runtime tests。既存固定SDKで無課金検証。
- B: libraryとdefinition-editorのcatalog表示/公開からの利用CTA、対応library tests。
- 親: workbenchの依頼中心UI/版preselect、共通nav/CSS/入口、対応tests、統合・実配備・記録。
- C: 設計比較・統合diffの独立レビュー。全担当が他者差分を戻さず、共有ビルド/配備/ブラウザ試験を親へ集約。

catalog JSONはax-local/task_runtime/builtin_catalog.jsonを原本に、defaultAgentとskillsのid/name/description/when/path/sha256を持つ。Runtimeは読込hashを検証し、Webは同じ原本を表示する。rootの固定runtime imageがbuiltinの版を固定する。UI定義は既存PG不変公開版を使い、GETで選んでも送信時に再認可する。

DADSはローカル20260909版、status installed=true/check_due=false。layout・typography・disclosure・selectを確認。本文16px以上・行間1.5以上・レスポンシブ・明示label/focus、任意の追加機能だけ折りたたみ、外部送信同意やエラーを隠さない。独自CSSの名前を公式component名として扱わない。

## 進行と検証

進行の正本: orchのgeneral-agent-ui unit。親が更新する。新規会話テーブルなしの単発文章応答、catalog一致、公開版preselect、file0件送信、既存失効/競合、320px/desktop/keyboardと画面実物を確認予定。有料検証は既存0.05 USDの累積枠内で最小限、別予算を作らず、実行前に対象・回数を確定して試験後に閉じる。

### 独立レビューと現在の検証

Cは狭い採用案と製品差分を独立に検討し、必須修正なしと報告。GETで実行しないこと、公開版のkind/archive確認とPOST再認可、Workspace別の画面状態、予算・権限・再送不変を照合した。Webとimageの別配備によるcatalog不一致を懸念として挙げたため、構築image内のcatalog/本文を別途hash照合した。

Aの固定SDK0.1.20・network none試験は20件成功、skip0。最初の19件では追加fixtureの日本語skill名が既存slug規則に拒否され、fixtureだけ修正し、標準/登録定義なしの相談応答試験を追加して20件を通した。製品の検証制約は緩めていない。

親のブラウザ試験は初回group27件成功。別groupはcatalog JSONのNode import attribute欠落により開始前に失敗したため、import attributeとbundler向けmodule ESNextを設定した（target ES2022は維持）。次の22件中21成功、残り1件はsr-only境界の空白をtest selectorが許容していなかった。名前・版・hrefの照合を維持した空白許容へ修正して再実行する。

新しいRuntime imageは `localhost:5001/ax-task-runner@sha256:22a4a52d721ffe36e2caff751cbe1a6c4fd69ed9f7d6c5021fde7b037f364ec9`。image内catalog SHA256 `6da9fa1469c1e6cf4e031203f319479bf82a82681e697b98916aba8025cfcb2d`、general本文 `0f7bae85ac7e0faa227e15f1ac4bab0041548bfd7a064ea128c19037cd107a1d`、tabular本文 `47c67805bf384f4051ad2c7392ef9e18b194dc611c1133775646e5e8f50313d5` がWebの共通原本とRuntime sourceに一致。受付閉鎖・未解決0でpinを更新し、モデル禁止のままcontrollerを配備、rollout成功。

### 限定した実モデル確認の計画

既存の累積0.05 USD検証枠内で、新しい標準エージェントへ架空の社内会議案内文を1回だけ依頼する。既存の専用WorkspaceとAlice試験アカウントを使い、入力ファイル0・登録skill0・agent指定なし、追加回答・再送・自動再試行なしとする。公開文脈は10月8日15時から30分の開発定例、80字以内の日本語案内。質問待ちや不明状態なら同じ依頼を繰り返さず、rootに紐づく状態・費用・停止を確認する。1root既存の6モデル/8tool/Python3・300秒・概算0.01 USD上限は変更しない。期待はmodel1・Python0・本文応答・結果file0、終了後に有料Gateway/DBtrial/鍵mountを閉じる。

実行入口は `web/scripts/verify-general-local.ts --run --real-model`。scriptが示すのはブラウザ上の結果であり、server回数・費用・cleanupは別途DBとActorを照合する。直前の全体既知概算は0.006797 USD。実行結果は後段へ追記する。

### 最終結果

ブラウザの対象49件は最終的に全成功（27件group成功、別22件のうち21成功、selectorを修正したlibrary4件は全成功）。新しいURLの種類違い・曖昧なquery・別Workspace・同じWorkspaceの他人のprivate版・archive後の拒否、古い公開版の選択を確認。320px横はみ出しなし、該当画面Axe違反0、desktop/mobileの実画像を確認した。Node24の型検査とVite本番build、差分検査、OKF strict/driftが成功。

実モデル試験のroot `c78be1c4-0cec-4e1d-9bab-0a354eed3e0e` は成功。新しい固定imageのAX Taskが添付・登録定義なしで、日時・30分・開発定例を含む69字の日本語案内を返した。model1/tool1（output proposal）/Python0、input1244/output59、実作業33,599ms、概算0.0003995 USD。結果file0、Actor/Task停止・worker未割当・通信denyを独立inspectで確認した。

自動browser試験は「10月8日15時」の「15」の先頭を日付regexが誤拒否し、結果の照合でfailを記録した。製品の返答と実行は成功しており、判定のみ修正。実データを含む正負11例で修正を無課金検証した。失敗記録を残し、同rootを読み取り専用で開き直して返答hash・69字・再読込後の一致を確認（新規start0）。追加モデル実行なし。したがって有料script全体を初回成功とは扱わない。

終了時はtrial false・Gateway false・鍵mountなし、専用Secret削除、未解決/invalid0、予約0、無料受付を再開。過去を含む全体既知概算0.0071965 USD。証拠は [general-agent-live.json](evidence/general-agent-live.json) と [実応答](evidence/general-agent-live-result.png)。Web/APIは新buildで稼働中（session73190）。実モデルは閉じているため、通常の画面確認は無料操作テストを使う。

前段の登録/ファイル/実行機能の台帳は過去の受け入れ記録として保持する。今回変更したソースの最新判定はgeneral-agent-ui unitと本記録を使い、古いhashで現版全体を確認済みとは扱わない。定期実行と完了依頼間の自動文脈引継ぎは今回の成果に含めない。
