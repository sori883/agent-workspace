# 本人用ファイル保存層の検証

2026-10-07。担当B。基準は `ede929ea87af8173af128e7b8706c11d1a9b16f6`、`codex/agent-workbench` の未コミット差分。採用設計と [file-contract.md](file-contract.md) を再利用し、保存層の実装・検証までを担当した。API/BFF/UI、稼働DB適用、AX実行は親担当へ渡す。

## 変更範囲

- `web/data/schema-v6.sql`：本人ファイルのメタデータ、bytea chunk、不変化、容量予約、認可、公開DB関数。
- `web/data/files.ts` と `web/shared/file-contracts.ts`：DB注入による保存クラス、入出力のZod検証。Node/fs/Bufferに依存しない。
- `web/data/db.ts`、`web/server/data-migrate.ts`：v6の追加。v1〜v5のSQLとchecksumは変更していない。
- `web/data/permissions.ts`：APIの8関数だけを追加。execution roleにファイル権限は追加していない。
- `web/tests/files.test.ts`：専用PostgreSQLによる18件。`web/tests/workspaces.test.ts` は期待するmigration版の配列だけを更新。

最終 `schema-v6.sql` SHA-256：`cd2380231128fc573373213e33b3a8e5fb954877a1313553ee932c18b8c2f186`。

## 実装した契約

`FileRepository` は `begin/list/get/putChunk/readChunk/seal/cancel/cancelUnavailable` を持つ。一覧は既定50件、上限100件、同じ本人・Workspace内のfile UUIDを `before` cursorとして使う。`get` は未完了・取消済みの状態も返し、`readChunk` はreadyだけを返す。

1ファイルは1 byte〜8 MiB、chunkは32 KiB。同時draftは本人4件、draft予約とreadyの合計は本人256 MiB、アプリ全体1 GiB。受付と取消は共通のquota advisory lockで直列化する。同keyの同要求は元のfile IDを返し、異なる要求は拒否する。既存chunkの同bytes再送は許すが上書きは許さない。全chunk、長さ、SHA-256が一致して初めてreadyになり、完成後のbytes・メタデータは不変となる。

通常の全操作は本人、指定Workspace、現在の所属、user activeを検査する。他人・別Workspace・存在しないfileは404。Workspace adminも他人のファイルを読めない。ファイルはbyteaで保存し、base64の永続保存や完成bodyの重複保存はしない。

所属を失ったWorkspaceのdraftで上限が塞がる問題には、本人の明示操作 `cancelUnavailable(owner,currentWorkspace)` を追加した。現在のWorkspace所属を確認し、同owner・uploading・元Workspaceへの現在所属なしを満たすdraftだけを取消す。返すのは `{cancelled_count}` のみ。ready、他人のファイル、再加入済みdraftを変更しない。

一括取消は対象Workspaceの `FOR SHARE` を先に取得し、quota lock、file row lockの順で進む。組織の参加・退出処理が持つWorkspaceの排他ロックと協調し、取消UPDATEでも所属なしを再検査する。対象は今回Workspace lockを取得できた集合に固定する。列挙後に別Workspaceへ増えたdraftは次の明示操作へ残す。

## 実行結果

試験は `app_auth_test` の一意な `files_test_*` / 移行用schema内で実行し、終了時にschemaを削除した。接続情報は出力していない。

| 確認 | 結果 |
| --- | --- |
| 保存層の初回最終試験 `npx tsx --test tests/files.test.ts` | 17/17成功。後発draftの競合試験追加前 |
| 後発draft試験 `npx tsx --test --test-name-pattern='locked snapshot' tests/files.test.ts` | 1/1成功 |
| 最終 `npm test`（web/） | 133/133成功。最終保存層18件を含む。ログ `/tmp/ax-work-files-node-final.log` |
| 最終 `npx tsc --noEmit`（web/） | 成功 |
| `git diff --check` | 成功 |
| v1〜v5 SQLのGit差分 | なし |

保存層18件では以下を確認した。

- UTF-8 CSV、最小構成の正常XLSX、NULや非UTF-8 bytesを含むデータをアップロードし、ダウンロードbytesとhashが一致する。
- chunk順序違い、同位置再送、同key並行受付、chunk競合、同時sealで、一つの結果だけが確定する。欠落・長さ違い・hash違いは完成扱いにならない。
- 本人、他人、Workspace admin、別Workspace、所属喪失、user停止を全操作へ適用する。通常のcancelは所属要件を保つ。
- 8 MiB境界、4draft、256 MiB、1 GiBの上限を、実chunkを持つfixtureと並行受付で検証する。未充填draftも予約容量として数え、取消による解放は一回だけとなる。
- 一括取消による4draft枠の回復、複数取消の競合、ready/current-member/他ownerの保持、実際の招待受諾による再加入、除籍とchunk/sealの競合を確認する。
- Workspace lock待ちの間に別Workspaceへ新draftを作り、そこから退出しても、今回の取消では対象外となる。次の明示取消で回収できる。
- `ax_api` の限定権限で8関数を呼び、COMMITできる。直接tableアクセス、private helper呼び出し、execution roleからのreadは拒否する。PUBLICへのEXECUTEを全関数で拒否し、公開関数のSECURITY DEFINER/search_path固定を確認する。
- v5までのmigration、既存Workspace、既存offline runを作成後にv6を二度適用し、旧checksumと旧行のJSONが不変で、新しい保存機能だけが使える。

初回試験で `ax_file_begin` 内のローカル変数参照がSQLエラーになる問題を検出し、変数名を `upload_key` に修正した。また、既存所属認可の404/user停止400と不一致だった試験期待値を既存契約へ合わせた。独立レビューF1の失効draft枠問題は、親が承認した一括取消契約で修正した。

## 限界と引き渡し

保存層は拡張子を許可し、bytesの完全性を保証する。CSVの文字コード、XLSX内部構造、暗号化・数式・外部リンクの安全性は判定していない。これらの解析は後続の隔離実行側で扱う。readyの削除・自動GC、共有添付、controllerの成果物登録も今回の対象外。

この担当では稼働DBのmigration、AX操作、有料モデル送信、commit/PRを行っていない。API/BFF/UIの実操作結果は親の証拠に従う。独立レビューは [files-review.md](files-review.md) に集約する。OKFへの保存は親担当とし、本担当からは容量予約、不変seal、失効draftの明示回復とロック順序を知識候補として渡す。
