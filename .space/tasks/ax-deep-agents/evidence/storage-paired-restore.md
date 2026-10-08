# PostgreSQLとスキル原本の対整合復元

2026-10-08 13:36:19–13:36:22 UTCに、専用テストschemaと実RustFSで保存・削除・復元を確認した。結果は合格。共有スキルと本人用スキルの2定義について、PGの全行、hydrateした本文と補助ファイル、公開版hash、原本manifest・各ファイルhash、認可metadataと拒否動作が復元前後で一致した。モデル呼出しは0。

これは同じPC上での復旧試験であり、外部媒体へのバックアップ完了や実ユーザーデータ全体の復旧を示すものではない。

## 対象と分離

- Git基点: `498abb96d7405c78985a35a32f15262e75f15ba8`、branch `codex/skill-file-storage` の未コミット実装。
- DB: Docker `ax-local-postgres` の `app_auth_test`。専用schemaは `skill_pair_5c88e1168b2e472dbb9a800b1e983e6f`。
- オブジェクト: アプリ専用RustFS 1.0.1、非公開 `app-skills` bucket。image index digestは `sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c`。
- fixture: 合成したowner・member・strangerと固有Workspace。共有用と本人用を各1件作り、本文、`references/example.md`、`scripts/example.py`、空の `assets/empty.txt` を保存した。scriptの実行はしていない。
- 実ユーザーの `app` DB/schema、他のテストschema、既存snapshot RustFSは変更していない。dumpは上記schemaだけを指定し、DROPもその名前だけに限定した。

data担当の実RustFS試験終了と清掃を確認し、親・data担当とbucketコピー中の書込み停止を調整した。fixture作成後はwriterを再開せず、dumpとbucketコピーを連続して取得した。原本は不変キーで、コピー中の削除処理も動かしていない。

## 実施した経路

1. `tests/skill-storage-live.test.ts` と同じ `prepareTestAuth`、`migrateAuth`、`migrateData`、`WorkspaceRepository`、`DefinitionRepository`、`S3SkillObjectStore` で専用schemaとfixtureを作成・公開した。
2. ownerの下書き・公開版をhydrateし、期待本文との一致を確認。共有版はmemberが読めて編集不可、本人用版はmemberを拒否、strangerは両版を拒否することを確認した。
3. schema内43表の全37行をJSONへ正規化し、表ごとの件数とSHA-256を記録した。本文はPGに置かれず、`draft.source` とファイルmetadataが原本を参照することも確認した。
4. `docker exec ax-local-postgres pg_dump --format=custom --schema=skill_pair_5c88e1168b2e472dbb9a800b1e983e6f --strict-names -U postgres -d app_auth_test` で534,377 bytesのdumpを保存した。PG dumpの終了時刻は13:36:20.943 UTC。
5. 既存の `object-storage/storage.py` の `backup` をbackup資格で実行し、bucket全体をコピーした。全bucketが今回のfixtureの10 object・2,347 bytesであること、記録した生成キー10件がすべて含まれることを確認した。コピー前後の一覧は一致し、全blobのSHA-256検査も通った。終了時刻は13:36:21.099 UTC。
6. fixtureのschemaだけをDROPし、記録済みの固有Workspace配下の10キーだけをmaintenance資格でDELETEした。schema不存在と対象キー不存在を確認した。
7. `docker exec -i ax-local-postgres pg_restore --exit-on-error --single-transaction -U postgres -d app_auth_test` へdumpをstdinで渡し、同名schemaを復元した。全43表37行の件数とhashが一致した。この時点では原本が欠けているため、公開版のhydrateは `skill_storage_integrity` で拒否された。
8. 保存manifestから今回のキーだけを選んだ復元セットをrestore資格で復元した。実際には全bucketの10キーと同一の集合だった。既存CLIの全blob検査・条件付きPUT・読戻しSHA-256照合を通した。
9. ownerの下書き・公開版・補助ファイル、共有版のmember読取り、memberの編集不可、本人用のmember拒否、stranger拒否を再確認した。API返却metadataも復元前と深い比較で一致した。PG参照が持つmanifest SHA-256と各ファイルSHA-256も、実S3 GETのbytesと一致した。
10. 試験後は同じschemaと記録した10キーを削除した。独立した再確認でも対象schema 0件・対象prefixのobject 0件。bucketコピーのための書込み停止を解除した。

## 照合結果

| 対象 | 実測 |
| --- | --- |
| fixture | 2定義・2公開版・10 object |
| 原本bytes合計 | 2,347 bytes |
| PG | 43表・37行、復元前後の各表hashが一致 |
| 全表の比較用fingerprint | `a3618c4b7d6e71f08318837e80b21ad53a8f22f2f96b0b139add1e4d9d90e74c` |
| hydrateした返却値・metadataのfingerprint | `cb9cc4a0dec85f6215138c58e7b28949ff86beba83416cd9ad52f0d381845094` |
| schema dump SHA-256 | `4bcb98c56997298d512029dc2a22a7f6102b9381df176ae2f9c859922f1c0173` |
| bucket backup manifest SHA-256 | `b737196a2b61e1061bcad2088765576483cb628690e38c65e55d238e5d2f7e0d` |
| 共有用content SHA-256 | `059033463bcca20adb5b47e9d0ab64e872af8e52472d5be0382b04c3625f696b` |
| 本人用content SHA-256 | `60e5cf4626dba93f3388c996af73d85a2877701187ae9c3cd7f36a6101039b87` |
| 共有用manifest SHA-256 | `276904be5009ebe28566c1555e01af1497483c041c80badfd3b843ce882d1b38` |
| 本人用manifest SHA-256 | `b27aed28884dd034dbe3784996f12235666a02f7970519967681734b17c3d958` |

共有範囲、作成者・公開者、Workspace所属、membership、定義revision、公開版ID・番号、manifest参照とhash、容量予約の行を含めてPGの全表を比較した。外部原本を復元する前にPGだけで成功扱いにならないことも確認した。

## 保存した証拠と再実行

ローカル証拠はGit対象外の `ax-local/.state/storage-paired-restore/5c88e1168b2e472dbb9a800b1e983e6f/` に0600で保存した。`schema.dump`、`bucket/`、`fixture-objects/`、`rows-before.json`、`rows-after.json`、`views-before.json`、`views-after.json`、`fixture.json`、`source-hashes.json`、`result.json` がある。`result.json` のSHA-256は `f821fae8effc0e04fc5f073a2ed978bf60c2e2a0aab48de9e88c6e13f3d04d42`。

専用の一時driverとobject操作helperも同じignored領域に置き、製品コードは変更していない。実行コマンドは `ax-local/with-env.sh node web/node_modules/tsx/dist/cli.mjs ax-local/.state/storage-paired-restore/run.ts`。再実行時は新しいschema・Workspace・キーを発行する。driverのSHA-256は `3cfbaab1cae6cc8dceed4a8c7355d2599db8b1daf926f6a328f7f5e58fbfa330`、helperは `b43e69927c2b7c2d32ea4b7b886b970ba2fc2f3bdda7651a29780582e886c3af`。資格情報は既存の0600設定を内部で読み、値を出力していない。

対象ソースのSHA-256:

| ファイル | SHA-256 |
| --- | --- |
| `web/api/skill-object-store.ts` | `4611307c823918a2083fcfc00a665bbb6249279d96cdf65b6e1670f1873dbc13` |
| `web/data/definitions.ts` | `89d1188b1ee01b0a55f88ccf0d2728802549da0193e41d72f499db816e917a49` |
| `web/data/skill-storage.ts` | `9337145d5546ae2a30a1eb2bee46425b8d09a3911a6154fc24232d259d6adf32` |
| `web/data/schema-v10.sql` | `93a5eb7ec33d72fb5c9fb7c23213eca8c9775b821f44ce6faf1d01594846722c` |
| `web/server/data-migrate.ts` | `d80428a32c19c036752cea757742691fab9c788042663c10a29b86632c6f378e` |
| `ax-local/object-storage/storage.py` | `6686dad358efacea87ae9a778c374216c4afbae7aae175f27acba86306744724` |
| `ax-local/object-storage/manage.py` | `64d858bb2a3ab2b86553aee1be9fa2e131e71685c60fc14fb377f2542c094ce1` |

## 初回試験と限界

13:35:03 UTCの初回fixtureでは、strangerに対して `workspace_not_found` だけを期待した試験が、実際の `definition_not_found` により停止した。いずれも情報を公開しない404であり、期待を両方の拒否コードへ合わせた。初回schema `skill_pair_e8465c0ec8634a4d846287fdd7d5a217` と生成objectは清掃済み。これは製品の認可修正を伴わない試験条件の修正で、その後に上記の全経路を実施した。

専用fixtureにwriterがない条件で整合した組を取得した。本番の複数writer停止、実ユーザー全体のPG参照列挙、バックアップ中の参照保持・GC抑止の自動化、外部媒体、別PC・新RustFSへの復旧、復旧目標時間は今回の対象外。IAMは稼働中の専用RustFSへ維持しており、IAM自体を別サービスへ復元する試験ではない。kindやDocker volumeは削除していない。
