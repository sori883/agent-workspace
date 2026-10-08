# 登録スキルの原本ストレージ

アプリ専用のRustFSをDockerで起動し、登録スキルを非公開の `app-skills` bucketへ保存する。データとIAMはnamed volume `ax-app-objects-data` の `/data` に置く。kindと既存のAX snapshot用RustFSは使用しない。

## 起動と確認

Docker Desktop、Docker Compose、Python 3の標準ライブラリを使う。Pythonはローカル運用CLIだけに必要で、Hono APIの保存経路には含まれない。リポジトリのルートで実行する。

```sh
ax-local/with-env.sh python3 ax-local/object-storage/manage.py start
ax-local/with-env.sh python3 ax-local/object-storage/verify.py --recreate
```

`start` は資格情報を生成し、コンテナの起動後にbucketと用途別のIAM権限を設定する。既存の資格情報は保持する。秘密値は標準出力・コマンド引数に出さない。`verify.py` は専用の一時キーだけを作成・削除する。`--recreate` を付けると `ax-app-objects` を再作成し、同じ原本と読取り権限が残ることも確認する。この間、アプリのストレージ接続は一時的に切れる。

起動前の資格情報作成だけなら `manage.py prepare`、IAM設定の再適用は `manage.py provision`、状態確認は `manage.py status`、停止は `manage.py stop` を使う。通常の起動・停止・再作成ではvolumeを削除しない。

ホスト上のAPIは `http://127.0.0.1:19000`、Docker Desktop上のcontrollerは `http://host.docker.internal:19000` に接続する。管理画面は `http://localhost:19001`。両ポートのホスト公開は127.0.0.1に限定する。controller Podからの到達確認とNetworkPolicyへの必要な許可は配備時に別途行う。AX推論用Taskへ接続設定・資格情報を渡さない。

## 設定と権限

`ax-local/.state/object-storage/` はGit対象外。ディレクトリを0700、秘密ファイルを0600で保存する。`secrets/root.access-key` と `secrets/root.secret-key` はRustFSの起動と初期設定だけで使用する。起動用シェルは秘密をコンテナ内tmpfsへコピーし、RustFSをUID 10001で実行する。rootの値をComposeの環境変数やアプリ設定へ埋め込まない。

| ファイル | `app-skills` 内の許可 | 利用者 |
| --- | --- | --- |
| `api.env` | GET / HEAD / PUT | 共通API |
| `controller.env` | GET / HEAD | 実行管理 |
| `backup.env` | GET / HEAD / LIST | バックアップ |
| `restore.env` | GET / HEAD / LIST / PUT | 復元 |
| `maintenance.env` | GET / HEAD / LIST / DELETE | 検証後の削除・承認済み保守 |

全identityで他bucket・IAM管理は許可しない。APIとcontrollerはbucketの一覧取得もできない。アプリでの公開・非公開はPostgreSQLの認可に従い、bucketを公開に切り替えない。`provision` はこのbucketの公開policyを解除して、管理する用途別policyを再設定する。

bucketの保存bytesには補助的なhard quotaを1GiBで設定する。アプリの論理128MiB・物理256MiBの容量予約は別に維持する。未完了の保存・旧revisionもbucket容量を使い、自動GCは行わない。容量を使い切ったら新規保存を止め、参照とwriter停止を確認した保守手順で扱う。quotaはオブジェクトのbytesを対象とし、Docker volume全体のディスク使用量や別媒体のバックアップ容量を制限しない。アプリ側の予約・完全性検査を省略する根拠にはしない。

各envファイルは次のキーを持つ。資格情報ファイルの内容を端末や作業ログへ表示せず、APIプロセスの環境またはcontroller専用のSecretへ設定する。

| キー | 値・用途 |
| --- | --- |
| `APP_SKILL_STORAGE_STORE_ID` | `local-skills` |
| `APP_SKILL_STORAGE_ENDPOINT` | 上記のホスト用またはcontroller用接続先 |
| `APP_SKILL_STORAGE_BUCKET` | `app-skills` |
| `APP_SKILL_STORAGE_REGION` | `us-east-1` |
| `APP_SKILL_STORAGE_FORCE_PATH_STYLE` | `true` |
| `APP_SKILL_STORAGE_ALLOW_INSECURE_HTTP` | ローカル開発だけ `true` |
| `APP_SKILL_STORAGE_ACCESS_KEY_ID` | 用途別に生成したaccess key |
| `APP_SKILL_STORAGE_SECRET_ACCESS_KEY` | 用途別に生成したsecret key |

本番接続はHTTPSと証明書検証を必須とする。付属CLIのHTTP例外は明示したlocalhost・127.0.0.1・host.docker.internalだけに限定する。外部S3へ移すときは提供元のIAM、条件付きPUT、署名、TLSを同じ契約試験で確認する。

## バックアップと復元

このCLIはbucket全体を別ディレクトリへコピーし、各キー・サイズ・SHA-256・media typeを `manifest.json` に保存する。ディレクトリが既に存在すれば停止する。バックアップ先はnamed volumeと別の保存先にする。

アプリ全体の復旧にはPostgreSQLも必要になる。APIの新規保存と移行writer・削除処理を止め、PGの整合した読取り時点を確保したうえで、PG dumpと下記コピーを一組として保管する。参照される全manifest・ファイルがその組に含まれることは、アプリ側の整合検査で確認する。bucket単独の成功をアプリ全体のバックアップ完了とは扱わない。

```sh
python3 ax-local/object-storage/manage.py backup /absolute/path/to/new-backup/objects
python3 ax-local/object-storage/manage.py verify-backup /absolute/path/to/new-backup/objects
python3 ax-local/object-storage/manage.py restore /absolute/path/to/new-backup/objects
```

復元先を変更する場合は、専用の0600設定ファイルを `--config /absolute/path/to/restore.env` で渡す。`STORE_ID` とbucket名がmanifestと一致する必要がある。復元は全ローカルファイルのhashを検査してからPUTする。既存キーへの上書きは条件付きPUTで拒否し、同じbytesがあれば再送を成功扱いにする。異なるbytesがあれば停止する。既存データを削除して復元を通す処理や、自動rollbackは行わない。

コピー中にbucket一覧が変わった場合、完成manifestを作らず停止する。この確認はwriter停止の代わりにはならない。原本を不変キーで保存し、バックアップ中の削除を抑止する必要がある。付属CLIは1オブジェクト1MiBまでを扱う。スキルの現行上限を超える添付を導入する際は、この運用上限も見直す。

## 検証の範囲

`verify.py` はPUT/GET/HEADとSHA-256、匿名GET/LISTの拒否、各用途でのPUT/DELETE/LIST/IAM拒否、条件付きPUTの競合、バックアップ・復元・同じ復元の再送、破損バックアップの書込み前拒否を確認する。`--recreate` では原本とIAMの永続化も確認する。kind自体を削除する試験やPGとの対整合は含まない。

```sh
python3 -m unittest discover -s ax-local/object-storage -p 'test_*.py'
```

局所テストは破損・競合・manifest内の不正パス・コピー中の変更・秘密ファイル権限・HTTP例外を確認する。実RustFS上の権限と互換性は `verify.py` で確認する。いずれもモデルAPIは呼ばない。

## 固定版と根拠

2026-10-08に [RustFS 1.0.1の公式リリース](https://github.com/rustfs/rustfs/releases/tag/1.0.1) とDocker Registryのmanifestを確認した。Composeはmulti-platform index digest `sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c` に固定する。確認したLinux arm64 manifestは `sha256:3bc0a69f7636faf49cbddd38901bb688dc7fe3fa6d2e2f87cc56e71890f66bc8`、amd64 manifestは `sha256:7465b31993156ca5cc0eb4b3c59a01ff69651961be62bcfeb6ce569f22034a56`。既存snapshotサービスのbeta imageは再利用しない。

設定根拠は [公式Docker手順](https://docs.rustfs.com/en/installation/container/docker)、[秘密ファイルの注入](https://docs.rustfs.com/en/operations/credentials)、[IAMの権限評価](https://docs.rustfs.com/en/security-compliance/iam)、[ユーザーとpolicyの管理API](https://docs.rustfs.com/en/security-compliance/iam/policies)。named volumeはコンテナ再作成からデータを分離するが、Dockerデータ消去やPC故障へのバックアップにはならない。

quotaの設定APIと形式は [1.0.1のquota handler](https://github.com/rustfs/rustfs/blob/1.0.1/rustfs/src/admin/handlers/quota.rs) に対応する。実測結果と未確認の範囲は [検証記録](verification.md) を参照する。
