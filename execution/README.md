# AX execution controller

Goの常駐プロセスがPostgreSQLのジョブを取得し、AX・Substrate・Task内runnerを操作します。HTTP/APIのプロセスやローカルファイル台帳に依存せず、受付から結果回収までを管理します。APIは受付と取得、controllerは外部操作を担当します。

実環境の切替・native接続試験は[検証記録](../.space/tasks/ax-portable-api/verification.md)で管理します。このREADMEは操作条件と実装上の制約を示すもので、現在のローカル環境の合格証拠ではありません。

## 配置と接続

ローカル配置ではAXと同じPodにcontrollerを置き、AXは`127.0.0.1:8080`で待ち受けます。公開AX Serviceを削除し、Taskへの経路はworkerの直接mTLS接続に限定します。固定版のatenet-routerは接続時に暗黙の再開を行うため、statusや成果物回収には使いません。

workerはcontrollerのPod identityだけを許可する固定イメージを使います。controllerもCA・サーバーのSPIFFE identity・SubstrateのActor割当を検証します。NetworkPolicyはcontrollerからworkerへの443番通信を許可します。Substrate APIはTLSと短命Bearerを使い、PostgreSQLはCA・ホスト名を検証して接続します。

主な設定は`settings/settings.go`、ローカル生成元は`web/scripts/deploy-execution.ts`です。

| 設定 | 内容 |
| --- | --- |
| `ax` | AXのaddress。平文は明示したloopbackだけ |
| `direct_guest` | CA、クライアント証明書bundle、期待するSPIFFE identity |
| `substrate` | address、TLS server_name、CA、Bearerファイル |
| `database` | host、port、database、user、password_path、ca_path、server_name、schema |
| `image` | Task用runnerのdigest固定イメージ |
| `controller_id` | claimを所有するcontrollerの識別子 |
| `allowed_hosts` | モデル接続時だけ許可するホスト |
| `model_gateway` | 対話実モデル用enabledとapi_key_path。未設定/falseは実モデル送信禁止 |
| `workbench` | enabled、model_enabled、python_enabled、code_image。code用固定イメージと開始許可 |

DBは外部配置できます。設定にKubernetes内のDBを必須としません。ローカル配備スクリプトだけはDockerの`localhost:55432`を対象とし、Podからは`host.docker.internal`へ接続します。外部DBでは環境に合う設定・資格情報の配備を別途用意してください。

## ファイル処理の配備条件

v8のworkbenchは、`ax-runtime`のモデル判断と`ax-code`のPython実行を交互に使います。同じPG実行枠を共有し、前のTaskの実停止を確認してから次を作ります。生成コードをモデル鍵のあるプロセスへ渡しません。

配備前に、固定AX/Substrateソースへ `ax-local/patches/prepare-code-runtime.sh` でpatchを適用し、code image、AX、ateapi、atelet、worker、controllerを対応する固定digestで揃えます。code imageの固定 `server-task.json` は制御サービスを起動する設定で、利用者のTask commandや資格情報を含みません。コード実行の開始はGoが保存した送信権に基づく一回の操作です。

`versions.json` の `runner_code`、`ateapi_code`、`atelet_code` を追加し、`runner_task`、`execution`、`ax_server_runtime`、`worker_controlled` も確認したdigestへ更新します。ateapi/ateletを先に配備し、旧Podが退役して全対象がReadyになったことを確認します。deploy helperはこの前提を検査しますが、基盤のpatch適用やビルドは行いません。

管理者は受付を閉じ、Web/APIと旧controllerを停止し、DBを保全してから `prepare-execution.ts` でv8と限定関数権限を適用します。続けて `ax_workbench_control` に確認済みのruntime/code image、`code_profile='host-quota-8m-v1'`、`python_enabled=true`、`trial_enabled=false` を設定します。既存の未解決runがある場合は先に回収します。Python許可は実Actorでの隔離・入出力・cleanup確認後に限ります。

`deploy-execution.ts --deploy` はDB設定と固定digestを照合し、両atespaceへのモデル鍵注入を禁止し、モデルGatewayを閉じて配備します。限定した有料検証では、承認済み費用枠の範囲でDBのtrial gateと `--enable-model` を同時に有効にし、終了後に両方を閉じます。既存の2,000円総上限、今回の0.05 USD停止条件を自動で引き上げません。

codeの完了には通常のdeny・停止に加え、正式Actor APIの `code_cleanup` が必要です。actor UID・worker UID・worker起動世代・image・profileを検査し、host上のrunsc、残存process、quota mountの回収証拠をPGへ保存します。workerを失った場合や証拠が欠けた場合は成功にせず保留します。`inspect -code` で正式な停止・cleanupを読み戻せます。

初回結合確認は専用schema/roleと `workbench-probe` を使い、通常受付・モデル送信を閉じたまま行います。これは固定fixtureの診断用で、通常controllerの代わりに常用しません。実測と未完事項は[作業記録](../.space/tasks/ax-agent-workbench/task.md)を参照してください。

## 初回準備と旧台帳からの移行

[Web初回準備](../web/README.md#初回準備)で認証・アプリスキーマを作成してから進めます。これらは管理者向け操作です。Web/API・旧CLI・旧workerの書き込みを止め、実行中の外部操作がないことを先に確認します。既存データと秘密ファイルを保全し、受付を閉じたまま作業します。

1. 管理接続で`ax_control.accepting=false`を確認します。初回スキーマはこの値で作成されます。
2. `web/`から限定ロールを準備します。

   ```sh
   cd web
   node --import tsx scripts/prepare-execution.ts
   ```

   `ax_api`は利用者対応のSELECTとAPI用関数、`ax_execution`はcontroller用関数だけを使います。PUBLICにはアプリ関数の実行権を与えません。パスワードは`.state/postgres/secrets/`、API設定は`.state/auth/api.json`へ保存します。既存ロールの資格情報が欠けていれば停止し、勝手に再生成しません。管理用`ax_app`をAPI/controllerへ渡さないでください。
3. 旧writerと残存する子コマンドの停止、旧`.state/runs/.lock`の取得可能性、全対象Actorの実停止・worker未割当・egress denyを確認します。AXのTask phaseだけでは停止証明になりません。旧`.lock`を削除・作り直してはいけません。
4. 閉鎖確認後、管理者が`ax-local/.state/execution/managed`を通常ファイルとして作成します。これは旧CLI・bridge・直接AX/egress操作を拒否する切替印です。自動の引退判定スクリプトはありません。印の作成だけで稼働中プロセスを止めたことにはなりません。
5. 旧台帳がある場合、リポジトリルートで検査し、取り込みます。

   ```sh
   bash ax-local/scripts/import-legacy.sh --dry-run
   bash ax-local/scripts/import-legacy.sh
   ```

   wrapperは既存`.lock`の同じinodeをflockし、FDを引き継いで取り込みます。旧writerがロックを保持していれば停止します。新規環境で旧台帳が存在しない場合、この操作は不要です。
6. 返却される`count`、`quarantined`、`unresolved`をDBと照合します。run/conversation ID、owner、順序、元hash、usage、費用、原bytesを保ちます。ownerなし記録は非公開のまま全体ガードへ算入し、pendingを新規ジョブに変換しません。隔離・未解決があれば受付は開きません。
7. controller・worker・runnerのイメージを固定し、配置します。必要なビルド元は`execution/Dockerfile`、`ax-local/worker-controller.Dockerfile`、`ax-local/runner/Dockerfile.task`です。配備は`ax-local/versions.json`の`execution`、`worker_controlled`、`runner_task`のdigestを読みます。controllerのローカルビルドはGo 1.27.1を使います。

   ```sh
   cd web
   node --import tsx scripts/deploy-execution.ts --deploy
   ```

   これはローカルkind専用です。managed印、閉じた受付、未解決・隔離0件を要求し、AXをloopback化してServiceを削除し、controller・秘密のマウント・限定NetworkPolicyを配置します。完了メッセージだけで実経路を合格にはしません。
8. 新旧両方の直接書込経路が閉じていること、DB限定ロールの権限、native接続、offlineの回収・egress deny・Substrate実停止、再起動後の保持を検証します。結果を検証記録へ残し、条件を満たした後にだけ管理者が受付を開きます。受付の開閉を代行するCLIはありません。最後に[Webを起動](../web/README.md#起動して使う)します。

取り込みは切替時に一度行います。同じ原本の再実行は照合できますが、DBで新規受付を始めた後の同期機能ではありません。取り込み前に`ax-local/.state/migration-backup-<UTC>/runs`を作り、旧原本も残します。DB内の`ax_imports`はreceipt/request/result/manifest/artifactの原bytesを保持します。別のresult.jsonがreceiptより新しくても、勝手に成功へ昇格しません。未知の台帳entry、symlink、原本の不整合は停止または隔離します。dry-runはファイル側の検査だけで、SQLが追加で見つける隔離件数は本取り込みの結果で確認します。

新規受付前に戻す場合も、controller停止・外部操作なし・DBへの新規書込なしを確認し、保存した旧構成と照合する管理作業が必要です。DBで新規受付を始めた後は、旧ファイルへ単純に戻せません。受付を閉じ、現DBと原本を保全して復旧してください。managed印を外して二重writerにする手順や、自動rollbackはありません。

## 実行権と結果の確定

受付はDB transactionで実行・会話・ジョブを保存します。controllerは30秒のleaseを取得し、10秒ごとに更新します。各操作の送信前に一意のintentを確定し、既存intentに対する送信権は返しません。DB応答が不明、lease更新が失敗、RPC結果が不明の場合は処理を止め、全体の実行枠を保持します。lease期限切れを理由に開始を再送しません。

offlineの開始前にはegress denyを確認し、有料処理だけ限定allowを使います。成功には成果物のサイズ/hash、既知の使用量、egress denyの読戻し、Substrate Actorの`SUSPENDED`かつworker未割当が必要です。AXの`Suspended`だけでは実停止を確定しません。DBはcontrollerから任意の`resolved=true`を受け取らず、証拠から結果を判定します。

開始につながる各操作の送信権を保存するときに、有効な利用者と現在のワークスペース所属を再確認します。DBが資格の失効を確定して返した場合は新たな開始を止めます。外部操作前なら `ax_cancel_unstarted` が送信権0件・開始未試行を検査して終了し、外部操作後なら同じclaimで通信遮断・停止へ進みます。DBの通信断など、結果が分からないエラーはこの扱いに変えず、従来どおり保留します。

開始済みの処理は、所属が失われても結果回収と後片付けを継続します。メンバー削除は実行中のモデル通信を即時に取り消す機能ではありません。停止・回収の権限まで取り上げてActorを残さないよう、開始側の権限と後片付けの権限を分けています。

## 停止と復旧

Webの停止はcontrollerを停止しません。controller更新時は新規受付を閉じ、現在の処理が結果回収・通信遮断・停止まで完了するのを確認します。SIGTERMやPod終了で途中になった場合は未解決として扱い、期限切れだけで次のworkerを動かしません。

通常の復旧要求は共通APIから行います。未着手なら`not_started`へ確定できます。外部操作済みの場合は管理者が旧controllerと送信経路を調べ、以下を証明してから管理権限の`ax_authorize_recovery(run, retirement)`を呼びます。

- 元の`controller_id`と`generation`が対象claimに一致する。
- `process_stopped`：旧プロセスが停止した。
- `transport_fenced`：旧プロセスから副作用を送れない。
- `inflight_settled`：送信途中の操作が確定した。

この関数は証拠JSONの条件を検査しますが、現実の停止・遮断を自動実施するものではありません。確認していない値をtrueとして渡さないでください。専用の管理CLI・画面は未実装です。旧`task recover`を代用しません。

復旧ジョブはcreate/resume/stage/startを送らず、保存済み結果を保ち、必要なら稼働中Taskから回収します。deny/suspendも過去のintentがあれば読戻しだけです。応答不明の操作を別attemptとして再送する仕組みは未実装なので、実体がまだ動いていても自動では解決できません。停止中Taskから結果を得るための再開もしません。未知usage、未回収結果、停止未確認を成功に置き換えず、全体を保留します。

有料失敗の確認記録は管理権限の`ax_review_failure(run, note)`で残せます。解決済み・既知usage・後片付け完了を必要とし、同じ失敗fingerprintの再送禁止は解除しません。API/controllerロールにはこの関数を許可しません。

## モデルを呼ばない検証

```sh
cd execution
go test ./...
go test -race ./...
go vet ./...
```

これらはfake transport等の局所試験です。実AXの試験は別に隔離したoffline probeを使います。`offline-probe -config <設定> -isolated-offline-probe`はモデルを呼びませんが、実際にTaskを作成・実行します。受付閉鎖、既存処理なし、診断runの記録と失敗時の管理者清掃を準備してから実施してください。DBの通常ジョブを使わない診断なので、成功してもDB/API経路の検証は別途必要です。

`inspect -config <設定>`はstdinのrun ID配列を受け取り、Task・Actor・egressを読み戻します。`-guest`は直接TLSと固定runner statusの診断です。再開は行いません。`ax-controller -healthcheck`は同居controllerのloopback healthを確認しますが、個別Taskの成功を保証しません。

有料経路をこの構成変更の確認に使わず、offlineと模擬障害で検証します。実環境の未確認事項・失敗・清掃結果は[検証記録](../.space/tasks/ax-portable-api/verification.md)を参照してください。

## 無課金の対話preview

`interactive`区間は`ax-runtime`の別Adapterへ振り分ける。旧`ax-demo`のadapterと同じGoプロセス・PGの実行枠を使い、復旧ではmailboxを処理しない。次の任意設定を加える場合、imageは新しい固定runner digestを指定する。

Taskの領域は`ax-runtime`、実行workerは既存の`ax-demo/ax-local` WorkerPoolを共有する。固定Substrateのschedulerはatespaceでworkerを分けないため、接続時に検証するSPIFFE identityも実workerの`ax-demo`に固定する。独立した`ax-runtime` WorkerPoolは配置しない。共有基盤は信頼済みで、workerのnamespaceをTask間の隔離保証とは扱わない。previewは固定toolだけを許可し、鍵を入れないtemplate・TaskごとのgVisor・egress denyを維持する。

```json
{
  "interactive": {
    "atespace": "ax-runtime",
    "image": "localhost:5001/ax-task-runner@sha256:<実digest>",
    "guest_identity": "spiffe://cluster.local/ns/ax-demo/sa/default"
  }
}
```

以前の専用worker構成から移す場合は、受付を閉じて対象Actorの実停止・worker未割当と未解決runを確認し、専用poolとそのworkerの退役を完了してから共有worker設定を配置する。旧poolを残したままidentityだけを変えると、schedulerの割当先によって接続できなくなる。別のworker poolを加えるときは、この配置前提とselectorの設計を見直す。

TaskのSDKはloopback proxyへ要求し、固定mailboxに保存する。controllerは既存mTLS guest RPCで元bytes/hashを受け取り、`ax_agent_reserve`でroot予算・権限と一度限りの処理権を取得する。previewはGo内部の固定模擬providerで応答し、外部へ送信しない。`ax_agent_settle`で応答・usageを保存し、DBの確定応答を読み戻してからguestへ返す。

応答投入ACK喪失ではPGの確定済み応答を照合し、同じ応答を一度だけ再投入する。予約・確定の応答が不明ならモデル処理を再送せずholdする。確定した失効・停止・予算拒否はdeny/suspendへ進める。root累積3モデル・2tool・token・90秒の正本はPGで、Goも区間の残時間を期限にする。

`mailbox`と`reply`は各64KiBまで。JSON重複キー、不正UTF-8、hash・run・sequence不一致を拒否する。Task側usageの自己申告だけで成功にせず、PGが保存済みGateway usage・許可したtool提案・成果物・cleanupと照合する。

AXには[管理対象領域の注入禁止patch](../ax-local/patches/README.md)が必要。新規Actor不存在、専用templateの固定image/command、`AX_TASK_YAML`以外のenv無し、単一workspace、gVisor、resume前のworker未割当を検査する。生成コード、live provider、任意URL転送はこのpreviewに含まない。

## 対話ランタイムの実モデル接続

本人の明示同意で受付したmodel rootだけ、Gatewayから固定の `gemini-3.1-flash-lite` へ接続する。rootのmodeと料金profileはDBへ固定し、回答時に変更しない。Task内のSDKは実鍵を持たず、Taskのegress denyも維持する。秘密はexecutionコンテナだけへマウントする。

```json
{"model_gateway":{"enabled":true,"api_key_path":"/etc/gateway/GEMINI_API_KEY"}}
```

未設定またはenabled=falseなら実モデル区間を送信前に失敗として確定し、previewは継続できる。設定は起動時に読み込むので変更後は受付と実行状態を確認してcontrollerを更新する。秘密ファイルは通常0600、Podの信頼group読取を明示する場合は0440と所有groupを検証し、送信時に毎回読む。URLやモデル名は設定から変更できない。最終イメージは固定Go build imageのCA storeを同梱し、HTTPS検証を無効化しない。

送信順序は費用予約→countTokens一度→現在の権限・stop・期限をDBで再確認→generateContent一度→usage精算→DB確定応答の読戻し。SDKの大きい既定出力値を引き継がず、GatewayがJSON Schema・text限定・minimal thinking・min(256,残output)へ組み直す。最終payload hashはTask mailbox hashとは別に保存する。再認可ACK、生成結果、精算ACKが不明なら再送しない。

入力はsystem instructionsと固定schemaを含む同じ生成要求をcountし、残入力から128を引いた範囲に収まる場合だけ生成する。countと生成usageの完全一致を保証するものではなく、実usageの超過は費用とともに保存して停止する。出力512の累積枠には思考tokenも含める。SDKの修正用追加生成は許可しない。生成応答がMAX_TOKENS・提案JSON不正でもusageが確認できれば精算して失敗にし、成功へ変換しない。

実usageが欠けるHTTP失敗、timeout、不完全な本文は予約を残して保留する。HTTP処理が終了しstartが確認済みのinteractive区間に限り、同じ有効claimでdeny/suspendを行うが、未知usageの予約・全体枠は解放しない。create/resumeの不明結果やlease失効・プロセス取消はこの停止分岐へ入れず、管理者の復旧確認を必要とする。失敗HTTPを無課金とは見なさない。レスポンス本文込み64KiB、各HTTP最大25秒かつroot残時間内、redirectと環境proxyなし、再試行なし。秘密、エラー本文、思考内容をログへ出さない。生成に必要な本文はGoogleへ送信される。

概算は標準テキスト入力0.25 USD、思考込み出力1.50 USD/100万tokenで、cache割引は見込まない。countTokens自体の無料明記は未確認であり、0.01 USDの概算停止ガードを全請求保証とは扱わない。[共有契約と公式根拠](../.space/tasks/ax-agent-model/contract.md)に条件を記載する。検証後はmodel gateを閉じる。実モデル接続の稼働証拠は親の[検証記録](../.space/tasks/ax-agent-model/verification.md)で別途管理する。
