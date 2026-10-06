# AXローカル基盤の検証結果

確認日：2026-10-05。実施者：Codex。環境：Mac ARM64、Docker Desktop、既存kind `ax-local`、Kubernetes 1.36.4。版は [versions.json](../../../ax-local/versions.json)。上流コードの変更なし。

## 結果

| 条件 | 結果 | 証拠・限界 |
| --- | --- | --- |
| U1 レジストリ | 合格 | kindのJobが `ax-local-registry-ok: linux/arm64` を出力してComplete。localhost:5001からpull |
| U2 Substrate | 合格 | 公式installer終了0。API/controller/router/egress/ateletがReady。Postgres/RustFSのPVCがBound |
| A1 AX Task起動 | 合格 | `ax-smoke` のReadyとWorkspaceReadyがTrue。gVisor Actor名 `ax-demo/ax-smoke` に紐づくログを確認 |
| A2 モデル処理 | 合格 | 修正版ax-model-smoke-v2でresult.txtの正確な内容・終了0・verified・正常終了ログを確認。実要求2件とも200、入力2396・出力61・思考0、概算0.0006905 USD。試験後はdeny-all |
| A3 状態・ログ・成果物 | 基本経路は合格 | 実Actorログの `AX_SMOKE_OK` と `task command completed successfully`、ax sshによるファイル取得を確認。モデル試験ではTaskがRunning/Readyでも子コマンドが終了1となることをexit-status・Actorログ・egressの404/402/200・使用量・保存済み応答で識別できた |
| A4 削除・再実行 | 合格 | CLIで削除後、TaskとActorの一覧が空。同名Taskを再作成してRunning/Readyと出力を確認。さらに停止・再開後も `/workspace/persistence-check.txt` の `AX_PERSISTENCE_OK` が残った |
| A5 通信 | HTTP/HTTPSの試験経路は合格 | 下表。任意のTCP/UDPや一般Podを含む全経路の隔離は未確認 |
| 観測 | 基本経路は合格 | Prometheusのup照会で6 targetが1。Jaegerにateom-gvisor / atenet-router / ateapi / ateletの4 serviceを確認。長期保管とアラートは未構築 |

## 実Actorからの通信

| 設定・試験 | 実測 |
| --- | --- |
| ポリシーなし、HTTP example.com | curlはreset。gatewayに `actor has no egress policy` と403を確認 |
| example.comだけ許可、HTTP example.com | 200 |
| 同じ設定、HTTP example.org | 403。gatewayに `no rule allows the destination` |
| 公式標準TLS passthrough、ホスト名だけ許可 | HTTPSはhandshake前に切断。公式E2Eの想定どおりで、成功とは扱わない |
| 公式sdsmint＋公開CA入りrunner、HTTPS example.com | 証明書検証を有効にして200 |
| 同じ設定、HTTPS example.org | 403。gatewayの `egress_tls_mitm` にpolicy拒否と送信先upstreamなしを確認 |
| Python httpx、HTTPS example.com | 200。runnerのSSL_CERT_FILEが有効 |
| Google genai Python SDK、models.list、意図的な無効テストキー | Google APIから400 `API key not valid`。APIまでのTLS疎通の確認であり、認証成功・モデル生成の確認ではない |
| 通信だけの試験後 | `ax-smoke` の許可リストを `[]` に戻した。この時点ではモデル用Secret未作成。後続のモデル試験で登録した |

通信試験で使った公開ドメインは `example.com`、`example.org`、`generativelanguage.googleapis.com`。イメージビルド・取得時には別途Docker Hub、Google/Chainguardのレジストリ、Go module proxy、Debian、PyPI、gVisor配布元へホスト・基盤から接続した。Actorの許可リストでこれらのビルド経路を制御したとは扱わない。

## 独立レビュー

実装担当とは別の `local_auth_review` が設定と上流コードを読み、クラスタを読み取り専用で確認した。

- AXのServiceAccountは `ax-demo/gemini-api-secret` のgetのみ可能。他のSecret、一覧、別namespaceの同名Secretは拒否。
- ServiceはClusterIP、Ingressなし。Docker公開はkind APIとレジストリの127.0.0.1のみ。
- set-egress helperは公開CAとServerNameでTLSを検証し、短命のaudience指定tokenをstdinで受け取る。自分が起動したport-forwardを終了する。ブロッカーなし。
- golden actorでworkspace goalが先に走り、失敗してもReadyになる経路を指摘。未実行のモデル例は開始合図を待つTask commandにし、通信許可後に通常Actorだけへ合図を出す。完了markerを確認して再開時の重複実行を避ける。修正版で通常Actorだけからのモデル要求、ファイル作成、正常終了を確認した。
- Secretのget権限と、キーがActorTemplateのenv・Postgresへ保存される経路は別。Substrateのatespace単位RBACは未実装。単一利用者のローカル試験という範囲を維持する。

## 実行証拠

モデル試験では、`runner/model-smoke.py` の設定を旧試験イメージ `dccb77d21d42ff35e560906bf6ebd26588ad04e6607b19ad4d4e819f5f973186` 上の `--network none --validate-only` で確認した。local_auth_reviewも独立に、SDKの上限と再試行0のprotobufへの反映、限定したツール、secretを除外するdockerignore、start合図の消費を確認した。実キーはレビュー担当へ渡していない。

課金試験のActorログ・egressログは `.state/model-smoke-trial-1.log`、`model-smoke-trial-1-egress.log`、`model-smoke-trial-2-guest.log`、`model-smoke-trial-2-egress.log`。2.5モデルは1件404、3.1モデルは1件402。3.1のSDK保存記録から前払い残高不足のメッセージを確認した。これらは入金前の履歴。利用者はその後、上限と前払いを各2,000円にしたと申告した。以前の10 USD条件は[新しい費用ルール](../../babel/rules/ax-model-spending.md)に置き換えた。課金画面と確定請求額は未確認。エージェントによる入金・自動チャージ・上限引上げはしていない。

生ログはGit対象外の `ax-local/.state/` に保存する。主要ファイルは `substrate-install.log`、`substrate-egress-install.log`、`runner-build.log`、`runner-local-trust-build.log`、`smoke-final-actor.log`、`smoke-final-status.txt`、`egress-verification.log`、`prometheus-up.json`。この文書はそこから確認した結果を記録したもの。

構文検査はBashの4スクリプト、Kubernetesのserver dry-runはAXとWorkerPoolの解決済みmanifestsで成功。構文検査・Pod Ready・SDKの認証エラーを、未実施のA2の代わりにはしない。

## 2,000円ルール適用後の試験

2026-10-05 09:23 UTCに試験を1回実行し、生成要求は1件（200）、再試行は0だった。入力1123・出力26・思考0・合計1149トークン。標準料金（入力0.25 USD/百万、出力1.50 USD/百万）による概算は0.00031975 USD。これは今回のAPI応答の使用量に基づく見積りで、過去分を含む請求額や円換算ではない。

保存済みtranscriptにはUSER_INPUTとPLANNER_RESPONSEだけがあり、モデルはresult.txtへのリンクとAX_AGENT_OKのコードブロックを返した。実ファイルは存在せず、検査がFileNotFoundErrorとなり終了1。モデルからの応答は確認したが、エージェントのファイル操作は成功していない。原因の観測は「ツールを呼ばなかった」であり、この時点では根本原因を未特定としていた。後述の通信なしの再現で設定の問題を確認した。追加送信なしで保存済み応答を調査した。

追加した再送防止と使用量記録はlocal_auth_reviewが独立確認した。最終イメージをネットワークなし・dummy keyで動かし、既存attemptedがある場合にAgent起動前に拒否することを確認。SDKのusage_metadataがturn内の累計であることも確認した。実試験後にはattempted・usage.jsonが存在し、start・result.txt・verifiedはない。外部通信許可は[]へ復帰した。

旧Taskへのimage変更はimmutableで拒否されたため、証拠保存済みの旧402 Taskを削除して新イメージで作成した。今回の失敗後はTaskの削除・再作成もmarker解除も行っていない。ライフサイクルのA4はモデルなしTaskでの既存検証を用い、有料の重複試験をしない。

証拠は `ax-local/.state/model-smoke-trial-3-meta.json`、`model-smoke-trial-3-result.txt`、`model-smoke-trial-3-guest.log`、`model-smoke-trial-3-egress.log`、`model-smoke-trial-3-transcript.jsonl`。ログはキーを伏せて保存した。料金根拠：[Gemini 3.1 Flash-Lite公式料金](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)。

記録更新後、OKFの全26文書に対するstrict・drift検査が通過した。エラー・警告・壊れたリンク・孤立・driftはいずれも0件。

## 修正版による完了確認

2026-10-05の追加指示により、API送信なしの調査後、根拠を得た少数回の低額試験が承認された。最終イメージは `6f4f48e64ae1eab1a9d1755d24675f676b0164e936d316d76ab64fa0246a2cad`、ソースのSHA256は `a5bc60016a5ed5017b4597536669bec8380f2e829af7a5282d9abee1e399b2f5`。Actor内のスクリプトとホストの一致を確認した。

原因調査は実キー・外部ネットワークを使わず、SDKとローカルHTTPスタブで行った。

- 出力形式retry=0だとGemini要求にfunctionCallingConfig.mode=NONEが入り、1に変えるとAUTOになった。behavior、tool budget、ツール一覧の変更ではNONEは解消しなかった。
- workspace_onlyだけではcreate_fileの許可規則がなく拒否された。明示allowだけでは/tmpの境界試験を満たさなかったため、TargetFileの絶対パス・実体パスを確認し、試験用result.txt以外を明示拒否した。policy経路のToolCall.canonical_pathはnullだったため、実際のツール引数を検査する。
- 回帰試験は通常作成、境界外、..、symlink、ツール上限2、モデル上限3、不正出力打切りの7ケース。修正前はNONEで失敗、修正後と最終イメージでは全件成功。上限ケースは終了理由も検査し、タイムアウトを成功に数えない。
- local_auth_reviewがコード・SDK・結果を独立確認し合格。API retry=0、output retry=1、総モデル呼び出し上限3を記録へ反映した。

10:27:18〜20 UTC（19:27日本時間）、ax-model-smoke-v2を1回実行。egressで生成POSTを正確に2件、両方200と確認した。入力2396・出力61・思考0・合計2457トークン、概算0.0006905 USD。result.txtは12バイトの `AX_AGENT_OK` と改行に一致し、終了0、verifiedあり、ログにMODEL_OUTPUT_VERIFIED・AX_AGENT_VERIFIED・task command completed successfullyを確認した。

試験後は通信許可[]、旧失敗TaskはSuspended。成功したTaskと成果物は保持した。モデルを使わないTaskでA4を検証済みのため、成功後の課金を伴う削除・再実行は重ねなかった。使用量を取得した試験3・4の概算合計は0.00101025 USD。確定請求額・円換算、過去の404/402分を含む請求総額は未確認。

証拠：ax-local/.state/model-tools-red.log、model-tools-green.log、model-tools-final-image.log、model-smoke-trial-4-meta.json、model-smoke-trial-4-result.txt、model-smoke-trial-4-usage.json、model-smoke-trial-4-guest.log、model-smoke-trial-4-egress.log、agent-result.txt。外部へのモデル要求は実試験の2件だけで、オフライン検証の人工使用量を実利用額へ加算していない。

完了記録反映後も、OKF全26文書のstrict・drift検査はエラー・警告・壊れたリンク・孤立・driftが0件で通過した。
