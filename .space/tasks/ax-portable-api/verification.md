# 共通API・PostgreSQL移行の検証記録

2026-10-06。`codex/portable-api-postgres`（base `0b6b4c8`）の検証記録。以下の追記が現在の状態で、初回確認は経過として残す。

## 移行と実行接続の確認（12:20 UTC）

- 旧Web/APIを停止し、外部コマンドが残っていないことを確認した。元の `.state/runs/.lock` のinodeを維持して排他取得し、`execution/managed` を作成した。以降、旧bridge/TaskCLI/通常AX wrapperは受付を拒否する。
- DB `app` のcustom dumpと旧run全体の非公開backupを保全した。最初の誤ったDB名による空dumpは有効backupと扱わず、正しいDBのdump成功を確認してから移行した。
- 15件の原本を全件transactionで取り込み、source hashを照合。DBの集計は15件・隔離0・未解決0・既存概算合計0.00322675 USD。receipt/request/result/manifest/artifactの原bytesも保持した。旧ownerなしの記録を利用者へ割り当てていない。
- API roleは内部ID参照とAPI関数だけ、execution roleは実行用関数だけへ限定。auth書込、他DB接続、PUBLIC関数実行・schema作成権限を与えない。独立担当が実DBの権限を確認した。
- AXはcontrollerと同Podのloopbackへ限定しServiceを削除。controllerは非root、read-only rootfs、1 replica/Recreate。既存router経路は暗黙resumeを起こすため使わず、Substrateの現在worker割当を取得し、Pod証明書とSPIFFEを検証したmTLSで直接接続する。
- 最初のoffline probe `ax-run-dffc75c9d9051e18` はcreate/resume後の準備確認で停止した。stage/start未送信。読み取り診断でTCP/TLS接続不成立を確認し、workerへのIngressがrouterだけを許可していたことを特定した。controller PodからworkerのTCP443だけを追加許可し、同じrunのstatusがwaitingであることを観測した。同runは再実行せず、管理者が通信deny→suspendを行い、実Actor停止・worker未割当を独立に確認した。
- 最終image `ax-execution@sha256:cbc21c779a2eaefe03f950519920852b841c744f9794e9d33fdd922a488c825d` を配備。新規offline probe `ax-run-e05aa4e58114d77e` はcreate/resume/stage/egress_prepare/start/collect/egress_deny/suspendの全段階が成功。成果物22bytes、SHA256 `cb7cdc28a69ad6f7ef634ce7fefb47a76ef3a9ed3d899a2fabae4a2bc50b3d67`、usage0、概算0 USD。
- 旧15件とprobe2件の全17 Actorを再観測し、すべてAX suspended、実Actor stopped、worker未割当、egress denyを確認した。probeはDB受付を試すものではなく独立の接続試験として区別する。残っていた旧AX/router port-forwardも終了した。
- その後にDB受付を開き、新しいWeb/APIを127.0.0.1:3100/3101で起動した。ブラウザからの全経路確認は次項へ追記する。新規受付後は旧file writerへ戻さない。

## 自動検証と独立レビュー

最終確認ではNode45件、Python114件、ブラウザ24件が全件成功した。型検査とproduction buildも成功。修正後の実workerd・DB障害試験を含む。Goは30件/race/vet/buildの担当結果を受け入れ、同じ検証を行うCIを追加した。

- TypeScriptは型検査、production build、Node試験44件が成功。その後、DB側隔離件数のimport wrapper回帰を追加し、data13件が成功。詳細は `data-verification.md`。
- 実Node・実workerd・試験用PostgreSQLの4件で同一契約、owner隔離、再起動後の再送、DB接続断時503と追加受付なしを確認した。Workerの非同期error listener欠損を失敗試験で再現し、修正後成功。workerd用条件を使ってpg-cloudflareの実接続を確認した。クラウドサービスへの配備ではない。
- Go30件、race、vet、controller/probe/inspectのbuildが成功。heartbeat終了時のcancel raceと安全なTLS診断分類は修正前失敗→修正後成功を確認。実行の応答不明ではclaimを自動奪取せず、start/resumeを再送しない。
- PythonはTaskCLI27件とchat15件が成功。全114件の初回実行で3件が実環境のmanaged markerを参照するfixture不備により失敗し、fixtureを専用rootへ修正した。残りは初回成功。最終全件再確認は追記する。
- ブラウザ24件の初回は23件成功。lifecycleだけが本番API設定を試験子プロセスへ使うfixture不備で失敗し、試験API設定を明示して同3件が成功した。AX/model backendはfixtureで、実AX結果とは区別する。
- root変更は独立担当、data/APIはexecution担当、executionとimportはdata担当が確認した（同じモデルの別担当、契約共同設計部分の独立性に限界あり）。指摘されたWorker DB例外、heartbeat race、未知の旧entry、DB隔離数の報告、artifact祖先symlink、移行marker不足、設定変更rolloutを修正し各担当が再確認した。未解決/invalidがある通常redeployも拒否する。
- npm auditは0件。モデルAPIへの追加送信0件。物理パスキー・本番配置・全基盤backup復旧・実paid経路は今回の確認対象外。

## 実ブラウザと保存・所有権（12:26 UTC）

実Keycloakでaliceがログインし、Webの「動作テスト」から `ax-run-899f4e9b9ba19301` を受け付けた。Web→Hono API→app PostgreSQL→Go controller→AX→Task内Python→結果回収→DB→Webの経路で完了し、日本語・改行・HTML文字を含む試験文字列とdownloadが一致した。同じキー・内容の再送は同じrun IDを返した。DBでphase=finished/resolved=true、job=doneを確認し、独立inspectでもActor停止・worker未割当・通信denyがすべてtrueだった。

Web/APIを終了して再起動し、保存した有効sessionで同じ成果物を読め、再送が同じrunへ戻ることを確認した。別ブラウザでbobが実Keycloakへログインし、aliceの詳細と成果物が404、一覧にも非表示であることを確認した。旧bridge・TaskCLI・AX wrapper・egress wrapperは通常呼出をすべて拒否した。API接続の設定やcookie・資格情報は公開記録へ含めていない。

稼働中APIを途中停止する実AX試験、実Kubernetes controller強制終了からの回復、旧router identityによるmTLS拒否の実通信試験は行っていない。対応するコード・権限の独立レビュー、局所障害試験と実停止readbackまでを証拠とする。新規受付は開いたまま、ローカルWebは127.0.0.1:3100で利用可能。今回の追加モデル要求は0件。

PR粒度のルールと現在の構成・採用理由をOKF CLIで更新し、33conceptのstrict/drift検証はエラー・警告0件。文書の意味はコード・上記実測・担当の説明と照合した。

## 初回確認の経過

## 既存データと外部状態

- 旧 `.state/runs` の公開runは15件。receipt上の未解決・開始済みpaid usage不明は0件、記録済み費用合計は0.00322675 USD。会話本文・秘密値は出力していない。
- `web/scripts/import-legacy.ts --dry-run` は15件を読み、原本同士・成果物サイズ/hashの事前検査で隔離対象0件。
- `execution/cmd/inspect` を実AX/Substrateへ接続し15件を読み取った。全件でAX suspended、Substrate Actor stopped、worker未割当、egress denyを独立に確認、exit 0。モデル・Taskの起動はしていない。現在の稼働状態の観測であり、旧receiptが当時同じ証明を持っていたとは扱わない。
- 接続は一時的なloopback port-forward。試験後に閉じ、通常運用の実行経路には用いない。

## 認証と配置境界

- APIからBFFのファイル設定と暗号化session storeへのimportを取り除いた。共有JWT検証へ移した直後、既存認証・HTTP境界の15テストが通過。
- 独立レビューでWorker `pg.Client` の非同期errorイベント未処理を指摘された。listenerで故障を記録し、その接続の後続queryを拒否する修正を反映。再接続・操作再送は追加していない。障害の実行試験は未完。
- Node/実workerd/実PostgreSQLの統合試験を追加中。初回は作成中schemaの構文エラーで停止、まだ合格していない。

## 実行接続で分かった制約

固定Substrateのatenet-routerはguestへの通信時に暗黙のResumeActorを送る。status/collectを副作用のない観測とみなせないため、この経路でのprobeを実行していない。実行担当がguest direct経路へ調整中。共有環境の書込み・移行切替・モデル呼出は未実施。
