# スキル原本保存の実装・検証

2026-10-08、担当 `/root/implement_skill_storage_data`。基点は `498abb96d7405c78985a35a32f15262e75f15ba8`、branch は `codex/skill-file-storage`。下記は未コミットの担当差分に対する結果で、全体の受け入れ判定は親担当へ渡す。モデル呼出し・live app DB の変更・コミット・PR 作成は行っていない。

## 実装した境界

- `web/data/schema-v10.sql`: 保存要求・容量予約・writer の世代・不変 revision を追加。保存開始と確定の両方で現在の権限・期待 revision を確認し、同じ要求キーの別内容、古い writer、容量超過を拒否する。元の公開 JSON 行は変更しない。
- `web/shared/skill-storage-contracts.ts`: manifest v1、原本参照 `skill-object-v1`、各ファイルの path・bytes・SHA-256・media type を定義。PG の管理 JSON は name・description・files metadata・content SHA-256・source で、本文を含まない。
- `web/data/skill-storage.ts`: 入力から標準 `SKILL.md` と補助テキストを作り、不変キーへ保存。manifest と全ファイルを検査して既存の `SkillContent` へ復元する。公開版の従来の semantic hash と manifest hash は別に保つ。
- `web/api/skill-object-store.ts`: 設定注入による S3 HTTP 接続。[aws4fetch](https://github.com/mhart/aws4fetch) `1.0.20` を固定し、独自署名実装は追加していない。条件付き PUT、保存後の GET/hash 照合、読取り bytes 上限、HTTPS 既定、明示したローカル HTTP 例外を持つ。自動再試行・redirect 追従は行わない。
- `web/data/definitions.ts`: 一覧は PG の管理情報から返し、詳細・公開版は原本から本文を復元する。通常の新規保存はストレージ未設定なら失敗する。読取り中の編集権限喪失と公開後の読取り権限喪失を、本文返却前に再確認する。
- `web/package.json` / lockfile、migration 登録と schema version を更新。親・実行担当が後から追加した v11 登録を保持している。
- 既存回帰 fixture は明示的な `{ legacyWrites: true }` で旧 schema の保存を再現する。変更箇所は `definitions.test.ts`、`workbench.test.ts`、`tests/browser/serve.ts` の repository 初期化。

API role には `ax_skill_save_begin`、`ax_skill_save_commit`、`ax_skill_publish_prepare` の実行権限が必要で、親が配備権限へ追加した。Task へ原本ストレージの資格情報を渡さない。

## 確認結果

コマンドは `web/` で Node `24.15.0` の実行ファイルを使用した。DB 試験は `prepareTestAuth()` の専用 `app_auth_test` に固有 schema を作り、終了時に削除した。

| 実行 | 結果・対象 |
| --- | --- |
| `node --import tsx --test tests/skill-storage*.test.ts tests/definitions.test.ts` | レビュー A 修正後に 32 件合格、実 RustFS の明示実行用 1 件は通常時 skip。本文非保存、原本破損・欠損、再送、中断、CAS、writer 世代、容量、旧公開版不変、読取り中の降格、設定欠損時の公開、公開確定後の失効を確認 |
| `node --import tsx --test tests/skill-storage*.test.ts tests/definitions.test.ts tests/workbench.test.ts` | レビュー修正前に 71 件合格。既存の定義・スキル選択・実行制御の回帰を含む。後続の局所修正は上の 32 件で確認 |
| `node --import tsx --test tests/runtime.test.ts` | S3 接続修正後に 7 件合格。Node / workerd の API 保存・公開、既存の DB・認証・再起動経路を含む。公開後の失効確認追加より前の実行 |
| `node node_modules/typescript/bin/tsc --noEmit` | 最終変更で成功 |
| `git diff --check` | 担当差分を含む共有作業場所で成功 |

workerd の初回失敗は、`Request` が `redirect: "error"` を受け付けないことによる通信前の例外だった。`manual` に変更し、3xx を失敗として扱う。Node / workerd の保存・公開を再実行して成功した。診断用の出力は削除済み。

独立レビューからの 3 件を修正した。管理者が原本読取り中に member へ降格した場合は未公開下書きを返さない。原本設定なしの公開は確定前に拒否する。公開確定後の本文読取り中に Workspace 所属が失効した場合は、確定した版を保持しつつ本文返却を拒否する。それぞれ専用の回帰テストを追加した。

## 実 RustFS

`RUN_SKILL_STORAGE_LIVE=1 node --import tsx --test tests/skill-storage-live.test.ts` で 1 件合格。API の 0600 env を内部で読み、秘密値は出力していない。固有 schema、UUID の Workspace と原本 prefix を使用した。

API 資格による署名付き PUT/GET、登録→公開→詳細・版の復元、同一 bytes の再 PUT、異なる bytes の拒否、controller 資格での GET 成功と PUT 拒否を確認した。生成した 4 オブジェクトを記録し、そのキーだけを maintenance 資格で削除した。既存の利用者データは対象にしていない。

workerd 向け `manual` 設定と権限再確認の追加後にも、インフラ担当と書込み時間を調整して同じ試験を再実行した。最終差分で 1 件合格し、固有 schema と生成した 4 オブジェクトの清掃も完了した。

## 追加レビュー B：パス衝突と BOM

追加依頼により、新しい原本保存のファイル同士が `references/a` と `references/a/b` のように衝突する入力を拒否した。`SkillStorage.prepare` で容量予約前に検査し、manifest・PG 管理 JSON の schema と `ax_skill_metadata` でも検査する。SQL は文字列の prefix として比較し、`_` を LIKE の wildcard として扱わない。manifest/source の JSON 形式は変更していない。旧 `skillContentSchema` は変更せず、旧 inline 公開版の読取りを保っている。

補助ファイルの先頭 U+FEFF が標準 `TextDecoder` に除かれる問題は、保存スキル用の局所 decoder に `ignoreBOM: true` を設定して修正した。既存の共通 `decodeUtf8` は変更していない。BOM を 1 個・2 個持つ内容、通常の本文、空ファイルを保存・公開・再読取りし、元の文字列・bytes・semantic hash の一致を確認した。

`node --import tsx --test --test-name-pattern='file-directory|path collisions|BOMs' tests/skill-storage.test.ts` の 3 件は、修正前に意図した失敗を再現した。パス衝突の保存と manifest 検査が通過し、BOM 付き原本の読み戻しは `skill_storage_integrity` で失敗した。修正後は同じ 3 件が合格した。衝突する順番を逆にした入力、衝突しない `a` と `ab/b`、`a_` と `ab/b`、旧 inline 公開版の読取りも確認した。

修正後の `tsc --noEmit` は成功。続けて `node --import tsx --test tests/skill-storage*.test.ts tests/definitions.test.ts tests/runtime.test.ts` を実行し、保存・定義 35 件が合格、実 RustFS 明示用 1 件は skip だった。runtime の 7 件は共通 before フックが migration 用 advisory lock の取得待ちで `Query read timeout` となり、本体は未実行。この実行の全体判定は不合格であり、製品動作の失敗とは切り分ける。親の全 Web 試験と実行時期が重なったため、単独再実行を調整する。実 RustFS の上記成功は、この追加レビュー修正より前の結果である。

## 制約・引き継ぎ

- 旧下書きは次の保存で原本方式へ移る。旧下書きを保存し直さず公開した場合は旧 JSON 方式を保持する。親がこの互換方針を採用済み。
- 初期の PG 物理予約枠は 256 MiB。未完了保存と過去 revision を含め、容量不足時は新保存を拒否する。自動 GC は追加していない。インフラ側 bucket quota は別の制限。
- PG の論理上限 128 MiB、既存本文・補助テキスト・公開版数の上限は維持した。原本側の 256 MiB は外部バックアップ媒体の容量保証ではない。
- 独立レビューへの修正結果は親へ報告済み。全 Web test/build、Go・Task 接続、PG と原本を組にした復元、live schema への適用判断は親・各担当の範囲。
- OKF をこの担当では変更していない。保存候補は原本参照と semantic hash の分離、途中保存の容量保持、Node / workerd の redirect 制約、読取り後の権限再確認。
