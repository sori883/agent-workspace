# ローカルPostgreSQLをKubernetesの外へ移す

## 依頼・範囲

2026-10-06、利用者は既存の実行基盤用DBも外部PostgreSQLへ移す方針を承認し、ローカルDockerで作成するよう依頼した。既存Substrateのデータを保持して移行し、認証用・アプリ用は別DBと別接続ユーザーを用意する。認証機能の実装、クラウド契約、Redis/RustFSの移行、有料モデル呼び出しは含めない。

基準はmain `80fca75`、Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7`。現行のPostgreSQL 18イメージを再利用する。PostgreSQLの配置とアプリの配置を別にする承認済み方針を具体化する。

## 工程・担当

標準規模の保存先移行。既存の外部DSN設計と、停止・最終バックアップ・復元・照合・切替の手順を再利用するため構造の再探索は省略する。親がファイル・DB・クラスタの変更を一括所有し、共有環境の書き込みを直列化する。blast-radiusで現行の接続・ログ・保存先を調べ、interrogateによる独立した読み取りレビューを切替前と実装後に行う。同一モデルの別担当であり、モデル多様性によるレビューではない。

適用知識は `knowledge/ax-local-kind-environment`、`decisions/systems/ax/auth-foundation`、`rules/ax-model-spending`、`rules/pr-delivery`。既存ファイル台帳・全体の費用制御・AXの停止確認を維持する。

## 作業単位と条件

| ID | 結果・確認条件 | 状態 |
| --- | --- | --- |
| P1 | DockerでPostgreSQLを起動し、永続volume・TLS検証・用途別DB/ユーザー・他用途への接続拒否を確認 | 完了。19項目合格 |
| P2 | 切替前のバックアップを試験復元し、既存データと照合。元接続設定と戻し方を保存 | 完了。試験復元16表成功、元設定保存 |
| P3 | 受付とDBの書き込みを止め、最終dump・復元・表の内容とsequence照合後に接続先を切り替える | 完了。16表・sequence1件一致、API2台復帰 |
| P4 | API、既存Taskの保持、新規offline Taskの実行・成果物・停止、DB再起動後の保持を確認。旧DBは停止しPVC/backup保持 | 完了。新Task成功、DBコンテナ再作成とsnapshot再開確認、旧DB0台/PVC保持 |
| P5 | 起動・バックアップ・復旧・再配置手順とOKFを更新。検証・独立レビュー後にPRで納品 | 文書・知識・独立レビュー完了。CIとマージ結果はこの変更を含むPR履歴を参照 |

P1→P2→P3→P4を直列で進める。レビュー担当はコード・設計・非機密な証拠を読み取り、DB操作をしない。全表照合の実データ・dump・元Secret・パスワードはGit除外の `ax-local/.state/postgres/` 配下へ権限を制限して保存する。公開記録には件数・ハッシュ・結果のみを残す。

## 守る条件と戻し方

- 初期起動は既存DBに触れない。移行先は新規の専用volumeで、既存の無関係なDocker資源を使わない。
- 現行ateapiは解決後のDSNをログに出すため、接続文字列にパスワードを含めず、SecretからPGPASSWORDを渡す。TLSはサーバー名まで確認する。
- CLIのglobal flockを確保し、未解決実行がないことを確認してからate-api-serverの全replicaを停止する。最終dumpは書き込み停止後に取得する。
- API Podの消滅と旧DBの他client接続0を確認し、dump前後の全表・sequenceが同値であることも確認する。試験復元は専用の一時DB、最終復元は空のsubstrate DBへ `--single-transaction` で行う。
- 独立レビューで旧clusterのXID持越しを指摘された。実測は旧xmin8964/trim8935、新xmin781。全表・sequence同値を確認した後、復元先の通知用worker_outbox全partitionとworker_outbox_trimだけを同一transactionで初期化する。一次表とsequenceが不変なことを再確認し、全APIのcold起動で一次表から状態を読み直す。
- 接続切替前に失敗したら元設定でAPIを復帰できる。切替後に新DBへの書き込みが始まった場合は、古いDBへ自動的に戻さない。再度書き込みを停止し、新DBの内容を保持して復旧先へ移す必要がある。
- この境界は新DSNでAPIのreplicaを戻す直前とする。Ready前でも起動時migration・保守が書き込むため、Task未実行を旧DBへ戻せる根拠にしない。
- 旧PostgreSQLのPVCとバックアップは削除しない。移行後の照合が済むまで旧DBを停止しない。
- 認証用・アプリ用DBは空で用意する。アプリの会話・入力・成果物は既存ファイルのまま保持する。

## 状態

ローカル移行・実動作確認は完了。接続経路はPodから `host.docker.internal:55432`、ホスト公開は127.0.0.1だけ。実行結果は `ax-local/verification.md` にまとめた。移行前の最終backupは `.state/postgres/backups/20261006T073655Z-cutover/`、事前の復元試験は `20261006T073055Z-rehearse/`。本文・Secretは公開しない。

独立レビューでXIDの持越し、API起動前のrollback境界、全Pod消滅とclient接続0、単一transaction復元、progressの永続化を反映した。`NO_AUTOMATIC_ROLLBACK` は新API起動前にexclusive作成・file/dir fsyncし上書きしない。通常progressもatomic replaceする。optional Secret初回作成と旧DB停止後の診断用Podも対応済み。通知初期化前後の一次表同値、復元所有者ax_substrate、接続のTLS、APIログのパスワード非露出を親が実測した。

新offline Taskは `ax-run-c2f7488061946da9`、成果物23bytes、終了0、モデル使用量・追加費用0。DBコンテナ再作成後にも16表・sequence1件が同値、Task snapshotの成果物hashも一致した。検証後はTask停止・通信deny、旧PG0台・data-postgres-0 PVC保持。認証用/アプリ用DBは空。Redis/RustFS/会話ファイルの保存方式は変えていない。

最終差分を2担当が独立して静的レビューし、追加P0–P2指摘0件。実環境の検証は親が実施した証拠と区別した。既存Python100件、接続19項目、初回TLS生成・再実行時の秘密保持・保存権限・原子的progress保存を確認。OKFは `knowledge/ax-local-kind-environment`、`decisions/systems/ax/auth-foundation`、`knowledge/ax-agent-platform-direction` をCLIで更新・読み返し、strict/driftは32 concepts、エラー・警告0。ステージした差分に秘密値・秘密鍵・実行状態がないことも照合した。
