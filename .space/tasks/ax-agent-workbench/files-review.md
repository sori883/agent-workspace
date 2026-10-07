# 私有ファイル保存の独立レビュー

2026-10-07、担当`w1_design_review`。基点`ede929ea87af8173af128e7b8706c11d1a9b16f6`から`codex/agent-workbench`の未コミット差分（新規ファイルを含む）を確認。製品実装に参加していない別担当によるレビュー。同じモデルを用いており、異モデル検証ではない。所有するこの報告だけを編集し、live DB・AX・課金操作は行っていない。

## 範囲と参照

`web/api/app.ts`の`/v1/files`、`runtime.ts`、`file-service.ts`、`web/app/lib/files.server.ts`、`routes/files.tsx`・`files-transfer.ts`、共有file契約・転送、`web/data/schema-v6.sql`・`files.ts`・permissions・移行、それに対応するAPI/PG/browser試験。既存認証・CSRF・Workspace scope・限定roleの呼出箇所も狭く追った。

devlowの全体フロー・reviewとinterrogate担当指示を適用。OKFは先行調査の全rule/principle検索を引き継ぎ、`web/data/`・`web/app/routes/`を追加パス検索。`portable-api-postgres`の単一正本/限定role、`knowledge/ax-web-foundation`の本人＋現在所属・CSRF/Origin・上限・再送の条件を照合した。今回の費用枠変更・共有定義・登録運用は対象外であり、未回答を承認扱いしない。

## 指摘

### F1 / P2：失効した所属のdraftが他Workspaceの送信枠を永久に塞ぐ

初回確認版`schema-v6.sql:74`はowner全Workspace合算でuploadingを4件に制限する。一方、`ax_file_cancel`の同`:147`は`ax_file_owned`→現在所属検査を要求する。Workspace Aで4件begin後にAを除籍されると、Aの一覧/取消が拒否され、引き続き所属するWorkspace Bでのbeginも`file_draft_limit`になる。UIにIDを保っていても取消不可、IDを失った場合は一覧から発見もできない。readyデータを消さずに容量・draft枠を解放する経路が必要。

静的に成立条件を追い、保存層担当も成立を確認。親は修正を採用した。対応方針は、認証済みownerと現在の画面Workspace所属を検査し、同owner・uploading・現在所属なしのdraftだけを本人の明示操作で一括cancel、件数だけを返すもの。旧Workspaceの本文/metadataやreadyは返さず変更しない。既存の単体cancelは現在所属必須を維持する。

**状態：修正後ソースと専用DB回帰により解消。** `ax_file_cancel_unavailable`は現在Workspaceを認可し、対象WorkspaceのSHARE lock→quota共通lock→file lockの順で、同owner・uploading・所属なしを再検査して取り消す。本文/metadataを返さず件数だけを返す。専用DBの再加入、seal/chunkとの競合、取消再送、二人のowner分離、現在所属のdraftとready不変、4件取消後の別Workspace begin成功を試験ソースで確認し、親から4回帰成功を受領した。API/BFFの新操作は同じ認証・Workspace・CSRF経路を使い、UIではIDを知らずに明示実行できる。

## 初回に確認した境界

- APIは内部tokenと検証済みidentityからownerを確定し、Workspace headerを必須化。DBは本人とWorkspaceを合わせて照合し、他人の管理者にもfile本文を返さない。全通常操作で現在所属・active userを検査する。
- beginの同owner/key・同本文は既存ID、異なるWorkspace/name/size/hashは競合。chunkのindex・最終chunk長・同bytes再送をDBでも検査し、readyへの変更は全bytesのSHA-256確認後だけ。readyの書換えとcancelによる削除を拒否する。
- 8MiBのfile、32KiBのchunk、本文64KiBの実読取量制限、canonical base64、メタ情報のchunk数整合を確認。ブラウザのダウンロードは検査済みsizeで確保し、各chunk長と完成SHA-256を照合してBlobを作る。保存はopaque bytesで、CSV/XLSX内容の安全解析を済ませた扱いにはしない。
- BFF転送POSTはHost/Origin/CSRFを経てAPIを呼び、redirectを拒否。JSONのowner等の追加fieldはstrict schemaで拒否。ページとAPI応答はno-store。私有bytesの公開URLを作らない。
- ブラウザはbeginのkeyを失敗後も保持し、既知file IDの再開はname/size/hashを照合。chunk・seal再送はDBの冪等契約を使い、reload後は一覧のdraftから明示再開できる。失敗を受けて自動的に別fileを作成する処理はない。
- v1–v5を変更せずv6を追加し、公開file関数のみAPI roleへ許可する構造。helperのPUBLIC EXECUTEを一括取消し、execution roleへfile本文読取りを追加していない。

## 検証と限界

担当自身がNode 24.15.0で`node --import tsx --test tests/file-api.test.ts`を実行し、1件成功。Honoの模擬serviceによるHTTP/owner伝達/上限/canonical base64/Origin/token試験であり、実PG・BFF・ブラウザを通した実証ではない。

PG/browser試験のソースを読んだが、担当自身による実行はない。親からbrowser2件成功を受領し、失われたchunk応答→同一file再送→download bytes一致、Bob拒否、偽装payload/CSRF拒否、空/上限超過拒否、draft取消、320px/axeという試験内容と照合した。一括取消の0件UI操作は親が最終確認中。Nodeの局所API試験は新操作追加後も担当自身が再実行して1件成功。

最終読取り時のSHA256：`schema-v6.sql`=`b2aea19fbf9e3eb9f389a8bbe7b1c75b6db28f8f1a16165f1f9d0d345a598d9f`、`files.ts`=`5fadc7ee17dccc5a113c17b8abfd87427fc77a3efcd57aea6ebadd67ea8f610a`、共有契約=`12b337a293fcbee34be6212953d1713531f6fa77beece6d083968049100edb14`、API app=`1520b8d02a08d156f5b69ab572802939b6f1ef3fb745b5fc3b76af78d35047bd`、UI files=`179d71d47c5e487207691649ec2f0e485c59d86ad98c06c18701404f5fc4f1a7`。

後続の限定修正：Workspace列挙後に別Workspaceへ新draftが増える競合に対して、保存層担当は取消対象を今回SHARE lockを取得した`locked_workspaces`集合へ限定した。後発draftは次の明示取消へ残す。この差分と「今回0件→次回1件」の専用DB試験を照合した。最終v6 SHA256は`cd2380231128fc573373213e33b3a8e5fb954877a1313553ee932c18b8c2f186`で、先のv6 hashを置き換える。

保存層担当から全Node133件（保存層18件を含む）と型検査成功を受領し、`files-verification.md`の記録と試験ソースを確認した。これらは担当による実行結果で、自分が同じ試験を再実行したものではない。

最終差分に残る確定した必須修正はなく、対象のファイル保存単位はコードレビューとして引き渡し可能。live適用の実施・既存データ照合・Workbench全体の合格は親の別工程である。
