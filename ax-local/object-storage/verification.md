# アプリ用RustFSの検証

2026-10-08。Git基点 `498abb96d7405c78985a35a32f15262e75f15ba8`、branch `codex/skill-file-storage` に追加した `ax-local/object-storage/` が対象。Docker Desktop Linux arm64、RustFS 1.0.1、image index digest `sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c` を使用した。既存のPostgreSQL・Keycloak・kind snapshot用RustFSは変更していない。モデル呼出しは0。

## 実RustFSで確認した結果

`ax-local/with-env.sh python3 ax-local/object-storage/manage.py start` で専用コンテナ・named volume・非公開bucket・5用途のIAMを作成した。追加したquota設定は `manage.py provision` で適用し、設定値 `1073741824` bytesをGETで読戻した。Composeのhealthはhealthy、RustFS本体はPID 1・ユーザーrustfsで稼働した。

`ax-local/with-env.sh python3 ax-local/object-storage/verify.py --recreate` が以下の7項目に合格した。

| 条件 | 結果 |
| --- | --- |
| APIのPUTと、API/controller/backup/restoreのGET・HEAD | 本文のSHA-256とContent-Lengthが一致 |
| 非公開bucket | 匿名GETとLISTが403 |
| 用途別の拒否 | controller/backup/maintenanceのPUT、API/controller/backup/restoreのDELETE、API/controllerのLISTとIAM一覧が403 |
| 不変キーへの条件付きPUT | 既存キーへの `If-None-Match: *` が412 |
| コンテナ再作成 | 原本bytesとIAMが残り、controllerによるPUT拒否も保持 |
| バックアップ・復元 | 試験prefixをコピー後に試験キーを削除し、restore資格で復元。同じ復元の再実行も一致 |
| 破損バックアップ | ローカルblob改変を検出し、PUT前に停止。対象の原本は変化なし |

初回の検証では、レスポンスheader名の大文字小文字に依存して `KeyError` となった。CLIでheader名を小文字へ正規化し、再実行で上記を確認した。最終確認では試験キーを削除し、bucketのobject数は0だった。

## kind内からの到達性

`ax-system` namespaceに、資格情報なし・ServiceAccount tokenのmountなしの一時Pod `object-storage-connectivity` を作った。既存Redis Podと同じ固定image `docker.io/library/redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499` のwgetで `http://host.docker.internal:19000/health` を取得した。

2026-10-08 13:22:17 UTCに `192.168.65.254:19000` へ接続し、HTTP 200、service `rustfs-endpoint`、version `1.0.1` を確認。PodはSucceeded・exit 0となった。検証後に一時Podを削除した。現在の `ax-system` にはNetworkPolicyがなく、将来のpolicy追加後の到達性は再検証が必要。

## ファイルと局所検証

root秘密ファイル2件と用途別env5件のmodeがすべて0600、Git ignore対象であることを確認。Compose形式、シェル構文、Python構文の確認に合格した。`python3 -m unittest discover -s ax-local/object-storage -p 'test_*.py'` の7ケースが合格し、破損・復元競合・manifest不正パス・コピー中の変更・秘密ファイル権限・HTTP制限を確認した。

バックアップ検査を補強した後に `verify.py` を再実行し、再作成を除く6項目にも合格した。コンテナ設定の内部照合ではrootのaccess key・secret keyの実値を含まないことを確認した。秘密値自体は出力していない。

## 未確認の範囲

Go controllerによる署名付き取得と権限設定の配備、アプリ保存・公開・移行、PGと原本の対整合復元は統合側で確認する。この一時Pod試験は同namespace内のHTTP到達性を示すもので、アプリ資格による認証の証明ではない。kind全削除やDockerデータ消去は実行していない。1GiBを実際に使い切る試験は行わず、quotaは設定と読戻しを確認した。PC障害からの復旧、本番HTTPS、外部S3との互換性は未確認。
