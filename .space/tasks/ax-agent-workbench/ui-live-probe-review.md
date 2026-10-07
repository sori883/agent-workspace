# 実モデルUI検証helperの限定レビュー

2026-10-08、担当C。対象はA作成の `web/scripts/verify-workbench-local.ts`、SHA256 `0907caf7dbe013a210f7314d057bedd246892766da6d0b040d70f69f6c03a81c`。devlow/review、既存の実行枠・課金・本人/Workspace境界の制約を引き継ぐ。helper本体、ブラウザ、DB、AX、モデルは実行していない。所有はこのレビュー文書のみで、製品コード・他担当の変更・OKFには触れていない。

## U1 / P2: 未所属拒否だけで本人限定の検証が合格する

- 箇所: `verify-workbench-local.ts:274–290`。
- 到達条件: Aliceが選んだ検証WorkspaceにBobが所属していない。helperはこの所属を検査しない。Workspaceを今回新規作成した場合も同様。
- 影響: rootで `workspace_not_found`、file get/readで同じエラーを成功扱いするため、同Workspaceの別ownerに内容を公開する不具合があっても `bob_root_denied` / `bob_input_denied` / `bob_output_denied` がtrueとなる。確認できた所属境界を本人境界の検証に置き換えてしまう。
- 最小修正: 同Workspaceに所属済みのBobを有料start前に読取り確認し、未所属ならstartを送らず終了する。helperで招待等を追加せず、事前設定は運用者に任せる。その条件でrootの `workbench_not_found`、fileの `file_not_found` を確認する。開始後に所属失効しても未所属拒否を本人隔離の成功扱いにしない。
- 状態: 親とAへ返却済み。修正版の再確認待ち。

## その他の確認

- `--run` と `--real-model` の両方を要求し、重複/未知flagを拒否する。これらの検査より前にブラウザ・password読取りを行わない。
- HTTP接続先は `127.0.0.1:3100` と `localhost:8180` 固定。service workerを閉じ、許可外要求をabortする。startは固定依頼、合成15bytesの保存済みfile1件、model同意あり、agent/skill無しを照合し、送信前にcounterを増やす。route.fetchもredirect/retryを無効化する。
- startは最大1回。待機中に質問・失敗・unknown・停止状態を観測すると終了し、answer/stop/recoverや別startを許可しない。browser終了をサーバー停止の証拠にしない。300秒待機はDOM側の上限で、実際の費用/回数/active時間/停止証拠は親がrootから別照合する。
- input uploadはbegin/put/seal各1回、bytes/hashが固定値に一致する場合だけ許可する。出力はreadyのsummary.csv1件・4KiB以下・1chunk、保存metadataとdownload bytes/hash、total=300を確認する。reload後も同rootを要求する。
- passwordはNOFOLLOW・通常file・私有mode・512bytes以下で読む。秘密やraw例外・response body・trace/storage stateを証拠へ保存せず、標準出力は固定phase/error codeと観測値に限定する。スクリーンショットは履歴や入力をマスクする。
- 証拠はDOMと受付receiptの範囲と明記し、server model/tool/Python回数をnull、料金/cleanup検証をfalseに保つ。未測定を成功扱いしない記録形式である。

## 検証と判定

CがNode24.15.0でTypeScriptの単独strict/noEmit/bundler検査を実行して成功した。UI・shared schema・BFF transferとの静的照合を行い、helperの実行はしていない。U1を修正又は証明範囲を正しく限定する必要があり、現版を本人隔離の合格証拠として扱わない。実課金試験の承認・予算・gate・配備判断は親が管理する。

Cはこのhelperの実装には参加していないが、v8 PGと統合契約の作者である。同一モデルの別担当によるhelper差分の独立レビューであり、PG/契約全体の独立評価ではない。

## U1修正版の再確認（2026-10-08）

**U1は解消。追加の必須指摘なし。** 修正版SHA256 `1919f4b1c65c66721892c501e4d7a6e6b4e9f4c098145a900c8ff0550812a3ee` を現在ファイルと照合した。

AliceのWorkspace確定後、uploadとmodel開始より前に別contextでBobをログインさせ、Workspace一覧の同じUUIDへのリンクが一つ存在することを確認する。未所属では開始counterが0のまま終了する。送信guardもこの確認済みflagを必要とする。招待/参加操作は追加していない。

rootの拒否は `workbench_not_found` の表示と会話/出力領域なし、input/output get/readは404かつ `file_not_found` だけを受理する。`workspace_not_found` を成功扱いしないため、開始後の失効を本人隔離の証拠にも置き換えない。

Cが同じNode24.15.0の単独strict/noEmit/bundler型検査を修正版で再実行し成功。本体・ブラウザ・DB・AX・モデルは未実行。検証WorkspaceへのBob事前所属は親が用意する条件であり、未準備時の早期終了は意図した動作。実課金検証の前提となる実Actor/予算/gateの確認はこの静的レビューに含めない。
