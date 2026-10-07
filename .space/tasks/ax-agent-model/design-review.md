# 実モデル接続の独立設計レビュー

2026-10-07。担当 `w1_design_review`。基点 `13eb7f118c4bf8af7cdd4d6ae84d27d37f2c42aa`、branch `codex/ax-real-model`。対象は [task.md](task.md)、親と担当A/Bが共有した追加契約、基点のGateway・controller・v4台帳。既存構成は再利用し、今回の送信・費用・同意の境界を確認した。同じモデルの別担当による設計レビューであり、実装後の独立検証ではない。

## 判定

明示したmodel同意、root固定profile、送信前予約、生成一回、使用量と成果の成否を分ける構造は採用可能。下記を実装契約へ反映することが条件。実装・live送信は未検証で、今回の報告をその合格とは扱わない。A/Bは構造候補を別々に作った担当ではなく、既存構成への追加部分を並行調査・具体化した担当として扱った。

親は、生成直前の再認可と、入力・費用を絶対上限として表現しない指摘を採用した。担当Bは再認可用 `ax_agent_send` と既知費用超過時の保存を契約へ加える方針を共有した。

## 必須条件

1. **生成直前に送信権を確定する。** Reserve後にcountTokensが走るため、その間に停止・失効・除籍・期限切れが起き得る。countと同じ生成payload/hash・profileに対して、claim世代、rootの停止・grant・所属・残時間を `ax_agent_send` で再確認する。送信権は一度だけ取得できる。ACK喪失・生成timeout・controller喪失を未送信と扱わず、追加生成は禁止する。生成権の確定後に届いた停止は、既に許可した外部操作を取り消せた証拠にはならない。usageの精算と清掃は継続する。

2. **既知の費用を失敗判定で取り消さない。** 有効なprovider usageが得られたら、提案JSON不正、MAX_TOKENS、安全性による中断、入力・出力・見積費用の超過があっても保存する。Goは提案検証のerrorでsettleを飛ばさない。PGはusage・料金・状態更新後に例外を投げてtransaction全体をrollbackしない。応答として確定したfailed状態を返す。既知usage超過、停止後の応答、同一settle再送について、別接続から費用保存と追加送信拒否を確認する試験が必須。JSON全体破損やusage欠損・矛盾は既知0へ置き換えず、予約保持とholdにする。

3. **旧経路と新経路を一つの費用ガードへ合算する。** ownerなしを含む旧antigravity費用、新modelの確定費用、未精算予約、今回予約を同じglobal枠で確認する。新model費用をrun resultとoperationの両方から加算しない。旧有料入口からも新台帳の費用・unknown・失敗レビュー要件を見なければ、旧経路で迂回できる。既存v1〜v4の保存値・hashは変更せず、v5のwrapperとruntime権限で共通化する。

4. **同意・profile・秘密を固定する。** 新規modelには `allow_model:true` が必要で、mode/profileをrootと送信台帳に固定する。回答・同key再送でmodeや単価を変更できない。既存previewは鍵の読取もモデル送信も行わない。生成先・model・料金・candidate数・出力上限・thinking設定は管理側の固定profileから決め、Task入力で上書きしない。鍵はcontroller/Gatewayだけに渡し、Task・Web応答・DB usage・例外ログへ含めない。redirect、SDKの再試行、自動fallbackで別送信を発生させない。

5. **計測誤差と保証範囲を分ける。** countTokensへはsystem instruction等を含む最終generateContentRequestを渡し、計測後に本文を追加しない。`count <= remainingInput - 128` は余裕を持つ入場条件で、実入力6000を厳密に保証する証明ではない。残input全額による予約も保守的な見積であり、数学的な最悪額ではない。実usage超過を保存して停止する条件と、0.01 USDは試用停止ガードであることを契約・表示へ明記する。2,000円上限や追加購入禁止の既存ルールを緩めるものではない。

## 根拠と残る確認

Gemini公式の[countTokens定義](https://ai.google.dev/api/tokens?hl=en)は生成要求全体を受け付ける。一方、同ページの例でも事前10に対して生成prompt11であり、完全一致や128以下の誤差は保証していない。[thinkingの制限](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens)はmax_output_tokensをthought込みのhard cutoffとし、minimalは思考0を保証しない。したがって出力512にはcandidatesとthoughtsの双方を加え、各生成は `min(256, remainingOutput)` を指定する。MAX_TOKENSの空出力でも費用0とはしない。

[料金表](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)で3.1 Flash-Lite Standardのtext入力0.25 USD、thought込み出力1.50 USD／100万tokenを確認した。固定profileはその適用条件と確認日を持つ。tool・grounding・音声等の別料金経路は今回開かない。

countTokensも外部へのデータ送信であり、生成とは別に一回の試行を記録し、同意・期限・active90秒の対象にする。生成3回の計数と混同しない。countTokens自体の料金の扱いはAが公式根拠を確認中のため、本報告では無課金と断定しない。これはlive送信前に確認する残件である。

予算の根拠としてOKF `rules/ax-model-spending` を読み、`execution/gateway` のパス検索で既存Runtime／portable API決定への適用を確認した。原則1 root・生成2回以内、試験全体最大3回、結果とusageを一回ずつ確認し、失敗・不明時には送信を止める。製品のroot内カウンターだけを、今回のlive試験全体の回数管理の代用にしない。

本担当はコード・DB・Kubernetes・秘密ファイルを変更せず、モデル送信も行っていない。この報告のみを作成した。共通契約の最終文書と実装は後続の統合レビューで照合する。
