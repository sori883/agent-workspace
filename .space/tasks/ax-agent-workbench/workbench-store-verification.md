# Workbench v8保存層の実装・検証

2026-10-07、担当C。基点 `ede929e`、作業branch `codex/agent-workbench`。実装者自身の検証であり独立レビューではない。スキルdevlowの実装/検証工程と既存OKF検索結果を再利用した。親の採用済み [統合契約](runtime-integration-contract.md) に対応する。

## 変更と境界

所有する `schema-v8.sql`、`workbench.ts`、`workbench-contracts.ts`、`workbench.test.ts` を作成した。v1–v7のSQLファイルは編集せず、v8で共通入口を版分岐する。既存 `ax_runs/jobs/effects/execution_slot/agent_operations` へ合流し、費用/送信権/slotの別正本は増やさない。migration登録・DB interface・permissions・API・Go/Python・稼働配置は親/他担当の所有。

本人＋現在Workspace、公開定義/依存の版固定と再認可、同key同payloadの再生、token失効/除籍による旧grant停止を維持する。旧v1のstrict一覧/詳細にv2内部attemptを混在させない。モデル/コードの未知操作は全体hold、既知費用は提案失敗やhandoff拒否でも保存する。

runtime/code/runtimeの次attemptは、旧attemptのdeny/suspendとcodeの場合server-owned host cleanupを保存した後、finish transaction内部だけで作る。同finish ACK喪失は同じnext IDを返す。recoveryは後続自動生成をしない。trial/python gateは既定false。固定image/profileは運用者設定からrootに封印する。

## 実施した検証

専用 `app_auth_test` 内の一意schemaを作成し、authとv1–v8を適用、終了時にschemaを削除した。実app DB、AX、モデル、live秘密は操作していない。DB関数へ渡したActor/usage証拠は明示的な合成fixtureであり実Actor停止の証明ではない。

- 最終専用26/26成功。8 MiB入力と出力を32 KiB×256chunkで搬送・封印し、SHAとbytesを照合。runtime→code→runtime、停止前不可、host cleanup欠落hold、同finish再生、コード前の停止/失効と出力予約解放を確認した。
- root同keyの4並列受付が1run、モデル予約の並列が1送信権、生成権の再取得/ACK不明はhold、count中logoutは生成拒否＋証明されたno-send精算を確認した。
- 除籍→再加入、token恒久失効、他人のroot/file、間違ったclaim世代、未宣言file、旧private関数/role越境を拒否した。
- `ax_api` と `ax_execution` の限定ロールで開始→claim→effect→reserve→settle→cleanup→finishを実際にCOMMIT。直接表参照・旧v7関数・相互roleの入口を拒否した。
- 過去のownerなしantigravity費用と新ledgerを合算。旧0.01 USD guardを保持し、新経路0.05 USDの残額判定と予約を確認。既知入力超過7000tokens、実費0.01 USDの超過記録をrollbackせず保存した。
- 300秒/6model判定、4KiB source/4files/8MiB宣言境界、rootに封印された定義と依存順、公開版chunk SHA、archive後拒否、単独skillのbuiltin権限を確認した。
- 合成の既存ready file容量248 MiBと出力8 MiB予約で256 MiB上限を満たし、通常upload追加を拒否。出力begin後も二重計上せず、停止後未完取消で枠が戻ることを確認した。
- 回答をcode後の履歴へ保持。16 KiB履歴上限を超える制御文字ログは直前の結果を保存して次区間を作らず終了。API一覧は最初user_startのみ・checkpoint空、詳細は全messagesを返すことを確認した。
- 不正なcollectのusage/estimated型と成功error_typeを拒否するテストは修正前 `Missing expected rejection` を確認し、修正後成功。別operationに保存済みの実費が残り、停止を確定できることを確認した。

コマンド（cwd=web、Node24.15.0をPATH先頭）:

```sh
node --import tsx --test tests/workbench.test.ts
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --esModuleInterop --skipLibCheck --strict --types node data/workbench.ts shared/workbench-contracts.ts tests/workbench.test.ts
```

全Nodeは最終版176/176成功（79.46秒）。先行版175/175成功後、messages/list投影・source境界の回帰を追加して再確認した。最終26件も全体実行に含む。対象限定の型確認は成功。全体tscは親の新route `+types/workbench-transfer` 未生成で一度停止し、対象外として親へ通知した。対象差分のwhitespace確認は成功。共有OKFの末尾空白は親へ通知し、当方は編集していない。

## 引き渡す版と残件

- schema-v8.sql（messages/list投影を含む最終版）: `a57c5e50ef41037178ef3a3d78d37c629e7663fa0da60ee623f7f703ec45ea68`
- workbench.ts: `002486c2e5009f651bf2b18518222abde8c1ee1036564eab7ce73eb4be59bfe6`
- [合成PG fixture](evidence/workbench-pg-fixture.json) は親の追加許可で保存。agent＋skill順序・PG canonical/SHA・日本語bytesをGo/Pythonが照合するための資料で、live会話を含まない。

実Actorの8 MiB profile、cold start、host mount cleanup証拠、300秒内の全RPC搬送、実モデル、ブラウザ/UI、migrationの稼働適用は未確認。他担当の結果をこの試験の成功に含めない。Python gateを開く判断は親の統合検証へ渡す。独立レビューは親へ依頼済み、当方の検証を採用判断や全体完了として扱わない。OKFは変更していない。

最終hash追記:

- `web/shared/workbench-contracts.ts`: `4b430266eac6c33f8ced18e921c46a547caa9642946d50bb21efdeb7ef25cc27`
- `web/tests/workbench.test.ts`: `63264cbec8aae354e4d18b51a7c9a9a427f7bcd31edbbc981ba0a0f657beca16`
- `.space/tasks/ax-agent-workbench/evidence/workbench-pg-fixture.json`: `473f01ff28906cc845fcdca96d89f23703799eebd747474fc880ade686a18c5e`
- `.space/tasks/ax-agent-workbench/runtime-integration-contract.md`: `3ac01279fe4f6ad0e29aa00bfb012cdea4827121199a1e29736b77046644b1ee`

PG fixtureはGo担当のstrict decoder/descriptor SHA/bundle SHA、および親のPython stage/chunk/sealで一致したとの報告を受領した。この合流照合の実測者は各担当であり、C自身のSDK/Go実行結果ではない。
