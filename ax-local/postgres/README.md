# Kubernetesの外に置くローカルPostgreSQL

Docker Desktop上の専用コンテナ `ax-local-postgres` に3つのDBを置く。アプリとDBの配置は独立しており、将来は接続先・認証情報・CAを外部のPostgreSQLに差し替える。RDS等のサービス契約はこの手順に含めない。認証は[Keycloak](../keycloak/README.md)、会話・実行保存と限定ロールは[実行管理](../../execution/README.md)の手順に従う。

| 用途 | DB | 接続ユーザー | 状態 |
| --- | --- | --- | --- |
| Substrate実行基盤 | `substrate` | `ax_substrate` | 2026-10-06、既存 `atepg` から移行済み |
| Keycloak認証 | `keycloak` | `ax_keycloak` | ログイン・パスキー・認証設定を保存 |
| アプリ | `app` | 管理・BFFは`ax_app`、APIは`ax_api`、controllerは`ax_execution` | 認証セッション、会話、受付、結果、成果物bytes、旧原本を保存 |

基盤・認証・アプリ管理の各ユーザーは自分のDBを所有する。他用途のDBには接続できず、DB作成・ユーザー管理・superuser権限は持たない。APIとcontrollerのロールはDBを所有せず、用途別の関数・必要な参照権限だけを持つ。1つのPostgreSQLを共有するので、CPU・容量・障害の影響までは分離されない。

## 起動と接続

前提はDocker Desktop、Docker Compose、Python 3、OpenSSL、既存のkindと `ax-local/kubeconfig`。以下はリポジトリルートで実行する。`init` は既存の秘密ファイルを保持する。データvolumeだけが残っている場合は新しい秘密を生成せず停止する。

```bash
python3 ax-local/postgres/manage.py init
python3 ax-local/postgres/manage.py up
python3 ax-local/postgres/manage.py provision
python3 ax-local/postgres/manage.py status
python3 ax-local/postgres/verify.py
```

`provision` はDB・ユーザーがなければ作成し、既存データや既存パスワードを置き換えない。`verify.py` はTLS、誤ったパスワード・CA・ホスト名・非TLSの拒否、用途間の接続拒否、Podからの接続を確認する。診断用Podは終了時に削除する。

- Macからは `localhost:55432`。公開は `127.0.0.1` に限定する。
- Docker Desktop内のkindからは `host.docker.internal:55432`。この名前はローカル環境専用。
- 接続は `sslmode=verify-full`。公開CAは `ax-local/.state/postgres/secrets/ca.crt`。
- パスワードは同じディレクトリの `substrate.password`、`keycloak.password`、`app.password`。管理者用は `admin.password`。Git対象外、ファイル600・ディレクトリ700。
- 証明書の有効期限は生成から365日。Macの信頼ストアには追加しない。

Substrateでは接続先を `ATE_API_POSTGRES_CONNECTION_STRING`、パスワードを別の `PGPASSWORD` としてKubernetes Secretから渡す。固定版のSubstrateは起動ログへ接続文字列を出すため、**接続文字列にパスワードを入れない**。公開CAは `postgres-server-ca` Secretからマウントする。SecretはConfigMapの後に読み込まれ、同名の古い接続設定より優先される。

## 保存先と停止・再開

DB本体はDocker named volume `ax-local-postgres-data`、コンテナ内では `/var/lib/postgresql/18/docker`。ホストの `.state/postgres` は秘密ファイル・バックアップ・移行記録の保存先であり、稼働中DB本体ではない。

```bash
docker compose -f ax-local/postgres/compose.yaml stop
python3 ax-local/postgres/manage.py up
```

停止中は実行基盤がDBを使えないため、Taskの実行中には停止しない。通常の停止・コンテナ再作成ではvolumeを保持する。`down -v` やvolume削除は保存データを消すので、通常手順には使わない。

## 既存kind内DBからの移行

この節はSubstrate DBを外置きした当時の手順。アプリのPostgreSQL移行後は旧CLIと直接AX操作を拒否するため、切替後の確認は[共通API・controllerの手順](../../execution/README.md)で行う。既に移行済みのDBにcutoverを再実行しない。

このスクリプトは [versions.json](../versions.json) のSubstrateと、旧 `ate-system/postgres-0`・DB `atepg` の構成用。移行先は空の `substrate` DBでなければ停止する。外部から直接AXを操作する処理も止めてから実施する。

先に `kubectl-ate get actors -A` で全Actorが停止中、`get actor-template -A` でgolden tag生成済み・ERRORなし、`get workers` で実行中Actorなしを確認する。CLIは `bash ax-local/with-env.sh ax-local/bin/kubectl-ate ...` で呼ぶ。これらはAXのTask一覧だけでは確認できない。

```bash
python3 ax-local/postgres/migrate.py rehearse
python3 ax-local/postgres/migrate.py cutover
```

`rehearse` は旧DBの完全dumpを取得し、専用の一時DBへ一括復元して表を確認する。一時DBは成功後に削除し、dumpと確認記録は保持する。稼働中の旧DBとの完全一致判定は次の停止中に行う。

`cutover` は次の順序で進む。

1. ローカルCLIの排他ロックを確保し、未解決実行なし・全Task停止を確認する。元の接続設定とAPI台数を秘密のバックアップへ保存する。
2. APIを0台にし、Podの消滅と旧DBの他client接続0を待つ。
3. 最終dumpを取得する。取得前後の各表の件数・全行SHA-256・sequenceが一致することを確認する。
4. 空のDBへ `pg_restore --single-transaction --no-owner --no-privileges --role=ax_substrate` で復元し、全表・sequenceを照合する。復元に失敗したら切り替えない。
5. 通知用 `worker_outbox` の全partitionと `worker_outbox_trim` だけを同一transactionで初期化する。一次表とsequenceが変わっていないことを再照合する。
6. 接続用Secret・公開CAを反映し、元のAPI台数を起動する。全APIが一次表から現在のWorker状態を読み直す。

通知用の2表には、元のPostgreSQLクラスタ固有のトランザクションIDが含まれる。これを新クラスタへ持ち越すと通知の欠落検知が成立しない。完全dumpと初期化前の一致記録を残したうえで、再生成できる通知だけを破棄する。固定版の [outbox実装](https://github.com/agent-substrate/substrate/blob/944abe3278b895ccbf5d45555a49dd0f2f6ceae7/cmd/ateapi/internal/store/atepg/outbox.go) と [PostgreSQLのXID仕様](https://www.postgresql.org/docs/18/transaction-id.html) に基づく処置。

切替後は既存Taskの保持、新規offline実行と終了、DB再起動後の保持を確認する。モデルAPIは呼ばない。

managed移行後はWebの「動作テスト」からoffline実行を行い、成果物とDBの結果・実停止証拠を確認する。旧`ax-local/task run`を再有効化しない。受付再開前の管理者検証は[実行管理の検証](../../execution/README.md#モデルを呼ばない検証)を参照。

確認後、旧DBだけを停止し、PVCは残す。

```bash
kubectl --kubeconfig ax-local/kubeconfig -n ate-system scale statefulset postgres --replicas=0
```

## 移行が止まった場合

バックアップは `.state/postgres/backups/<UTC時刻>-cutover/`。`progress.json` が最後に進めた段階、`original-deployment.json` が元のAPI台数、`original-*.json` が元の接続設定、`atepg.dump` が最終dump。ユーザー内容やSecretを含むため、これらの中身をログやPRへ貼らない。

- **新API起動前**：APIを0台のままにし、元のSecretの `data` を完全に戻す。元ファイルが `null` だったSecretは今回新規作成したものなので削除する。ConfigMapは移行で変更していない。旧DBが稼働していることを確認し、`original-deployment.json` の台数へ戻す。追加した `PGPASSWORD` などのキーを残さない。復元先データは調査のため保持する。
- **`NO_AUTOMATIC_ROLLBACK` がある場合・進捗不明の場合**：Ready失敗でも起動処理が新DBへ書き込んでいる可能性がある。古いDBへ戻さず、再び全APIを停止し、新DBの完全dumpを取得して復旧する。旧PVCは移行時点のコピーであり、最新データではない。このmarkerは新API起動前に永続化し、その後は上書きしない。

スクリプトは失敗時にDBの自動上書き・自動削除・自動rollbackを行わない。原因を解消し、どちらのDBが最新か確認してから操作する。復元の一括性は [pg_restore公式仕様](https://www.postgresql.org/docs/18/app-pgrestore.html) を参照。

## 移行後のバックアップと復元確認

次は稼働中の3つのDBを個別にdumpする例。DB間で同じ瞬間の整合性が必要なら、先に各利用サービスの書き込みを止める。バックアップ先はGit対象外・新規ディレクトリにする。

```bash
(
  set -eu
  umask 077
  backup_dir="ax-local/.state/postgres/backups/$(date -u +%Y%m%dT%H%M%SZ)-docker"
  mkdir "$backup_dir"
  for db in substrate keycloak app; do
    docker exec ax-local-postgres pg_dump -U postgres -d "$db" -Fc > "$backup_dir/$db.dump.partial"
    mv "$backup_dir/$db.dump.partial" "$backup_dir/$db.dump"
  done
)
```

終了コードを確認し、空の検証用DBで `pg_restore --single-transaction` の成功まで確認する。`substrate` を別クラスタへ復旧する場合は上記の通知用2表の初期化と全API再起動も必要。秘密ファイルは別途、アクセスを制限した保存先へバックアップする。dumpだけでは接続ユーザーのパスワードやCA秘密鍵は復元されない。

証明書更新はAPIを止め、現在の秘密ファイルを退避したうえで同じCAから新しいサーバー証明書を発行し、コンテナを再作成する。CA自体も変える場合は全クライアントのCAを更新してから再開する。`init` を再実行して既存の秘密を削除・再生成する方法は使わない。

上流のSubstrateインストーラーを既存環境へ再適用する際は、保存済みのSecret・CAと外部DB設定を維持する。bundled PostgreSQLを再有効化しないこと。`manage.py apply-substrate` は全API停止中にだけ設定を再適用する操作で、データ移行は行わない。
