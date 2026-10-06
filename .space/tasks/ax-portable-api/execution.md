# Native実行管理の実装と検証

2026-10-06。担当execution、基準 `0b6b4c8`、対象は `execution/` の未コミット差分。親が採用した[設計](design.md)と[計画](plan.md)のP1/P3を実装する。モデル呼び出しは0件。実環境の変更、DB/Kubernetes操作は親へ集約する。

## 実装した境界

- `native/` は公開生成protoだけでAX、Substrate Control、guest ProcessServiceを呼ぶ。ホストのPython、AX CLI、shell、kubectlを起動しない。
- `controller/` はPGのclaimと一意なeffect intentを使い、開始、回収、通信遮断、実Actorの停止を進める。費用・owner・会話順序の判断はSQLの責務。
- `settings/` は明示された設定・秘密のファイルを読む。秘密値とgRPC/PGの生エラーをログへ出さない。
- `cmd/ax-controller` は永続ジョブを処理する。`cmd/inspect` は状態の読み取りだけ、`cmd/offline-probe` は受付を隔離したP1の実接続試験用。
- `Dockerfile` は3つの静的binaryをscratch imageへ入れる。Go builderは親が公式registryで確認したGo 1.27.1 Alpineのdigestを既定値に固定した。生成proto・Go moduleは固定版を使用する。

AXは `ac2332829f22360ff97b0ba34d94dd0dd782f17e`、Substrateは `944abe3278b895ccbf5d45555a49dd0f2f6ceae7`。`execution/go.mod` と `go.sum` が依存版を固定する。

## Routerを使わない理由

Substrateの通常 `atenet-router` は、guestのstatus/collectにも `ResumeActor` を送る。`internal/router/ingress/ingress.go:110` と `resumer.go:216–228` では、呼び出し元のキャンセルから切り離した再開を行う。復旧時の「観測だけ」と両立しないため、この経路は使用しない。

各guest操作は次の順に実施する。

1. Substrate `GetActor` で対象のatespace/name、RUNNING、worker割当IPを確認する。
2. worker IPの443へ直接mTLS接続する。通常のDNS名検証の代わりに、CAチェーン・有効期限・ServerAuth用途と設定した完全一致のSPIFFE URIを検証する。
3. `ate-target-actor=<atespace>/<run_id>` を付け、固定runnerコマンドだけを実行する。

固定Substrateの `internal/atunnel/ingress.go:476–502` は、現在のworker割当とactorヘッダーが一致する要求だけを転送する。停止や別Actorへの再割当は拒否する。この経路はResumeを呼ばない。workerの80番は旧経路で、同版の `internal/e2e/suites/networking/networking_test.go:474–492` は接続拒否を期待する。

既定workerはrouterのSPIFFE identityだけを許可する。親の配置案では、workerの許可identityをcontroller sidecarが持つAX Podのidentityへ変更し、従来のrouter経由guest操作を閉じる。配置変更と実接続は親による確認対象。

AX内部のworkspace準備確認にも `ATENET_ROUTER_ADDR` によるrouter fallbackがある（AX `reconciler.go:248–259`）。親の新配置ではこの変数も削除する。AXのworkspace Ready表示がfalseでも、controllerはdirect guest statusで準備を確認する。

## 操作とDB契約

| 項目 | 契約 |
| --- | --- |
| claim | `ax_claim(controller_id,30)` → run_id / generation / kind / request / image / result / effects。kindはexecuteまたはrecovery |
| 継続 | `ax_heartbeat(run_id,generation,controller_id,30)` を10秒ごとに実施。DB要求は5秒以内。失敗すると進行中のRPCをキャンセルし、次の外部操作を送らない |
| 送信権 | `ax_intent(run_id,generation,controller_id,operation)` → operation_id。既存intentを新しい送信権と扱わない |
| 観測 | `ax_evidence(run_id,generation,controller_id,operation_id,evidence)` |
| 回収 | `ax_collect(run_id,generation,controller_id,result,artifact_bytes)`。JSONと成果物サイズ・SHA256をGoとSQLで確認 |
| 完了 | `ax_finish(run_id,generation,controller_id)` → resolved / outcome。resolved=falseはholdとして返す |
| 不明 | `ax_fail(run_id,generation,controller_id,safe_code)`。slotを開放しない。書き込み応答も不明なら停止し、DBのclaim/intentを残す |

正常offlineのoperation順は `create → resume → stage → egress_prepare → start → egress_deny → suspend`。paidでは `egress_prepare` を `egress_allow` に置き換える。前者は開始前のdeny確認、後者は既定の許可hostだけを使う。cleanupのdenyは別の一度だけの送信権を持つ。

証拠の形は以下で固定した。

```json
{"confirmed":true,"actor":"ax-run-0123456789abcdef"}
{"egress_denied":true,"actor":"ax-run-0123456789abcdef"}
{"phase":"SUSPENDED","worker_assignment":null,"actor":"ax-run-0123456789abcdef"}
```

最後の証拠はAXのphaseから作らず、Substrate GetActorでSUSPENDEDかつworker_assignmentが無いことを確認してから保存する。AX Suspendの成功応答だけでは停止証拠にならない。

Create/Resume/Stage/Start等の応答喪失は `unknown`。同じ操作を自動再送せず、cleanupも送らずholdにする。SQLの既存intent、期限切れclaimから自動で送信を引き継がない。再起動後のrecoveryは、親が旧プロセスと送信済みRPCの終結を確認して許可したjobだけを処理する。

recoveryはCreate/Resume/Stage/Startを呼ばない。稼働中なら結果を観測して回収できる。既存cleanup intentは読み返して証拠を付けるだけで、再送しない。未停止・usage不明が残ればholdのままにする。停止済みActorを回収目的で再開しない。

## 設定と起動

JSON設定の例。パスとimageは配置に合わせて親が設定する。これは秘密値を含まない書式例で、保存済みの稼働設定ではない。

```json
{
  "secret_group_read":true,
  "ax":{"address":"127.0.0.1:8080","plaintext_loopback":true},
  "substrate":{
    "address":"api.ate-system.svc:443",
    "server_name":"api.ate-system.svc",
    "ca_path":"/run/servicedns-ca/trust-bundle.pem",
    "bearer_path":"/run/ax-credentials/token"
  },
  "direct_guest":{
    "ca_path":"/run/podidentity.podcert.ate.dev/trust-bundle.pem",
    "client_bundle_path":"/run/podidentity.podcert.ate.dev/credential-bundle.pem",
    "server_identity":"spiffe://cluster.local/ns/ax-demo/sa/default"
  },
  "atespace":"ax-demo",
  "image":"registry.example/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "allowed_hosts":["generativelanguage.googleapis.com"],
  "call_timeout_seconds":15,
  "lifecycle_timeout_seconds":180,
  "controller_id":"ax-controller-1",
  "database":{
    "host":"host.docker.internal","port":55432,"database":"app","user":"ax_executor",
    "password_path":"/run/database/password","server_name":"host.docker.internal",
    "ca_path":"/run/database/ca.crt","schema":"public"
  }
}
```

`server_identity` は実worker証明書のURI SANに完全一致させる。guest router用の旧 `guest` 設定は一時のinspect設定との互換のため読み込めるが、接続先として使用しない。

Bearer tokenはRPCごとにファイルを読み、client bundleはTLS handshakeごとに読み直す。ローカル秘密ファイルは既定で0600等のgroup/other権限が無い通常ファイルを要求する。Podの `secret_group_read:true` では、実ファイルgidがcontrollerのeffective gidと一致する場合だけ0440/0640を許可する。group write/execとother権限は拒否する。親はrunAsUser/runAsGroup/fsGroupを65532へそろえ、資格情報volumeをcontrollerだけへmountする。

CA bundleは起動時に読み、CA変更時はcontrollerを計画的に再起動する。再起動自体は古いclaimを引き継ぐ許可にならない。

```sh
cd execution
go test -race ./...
go vet ./...
go build ./cmd/ax-controller ./cmd/offline-probe ./cmd/inspect
go run ./cmd/ax-controller -config /absolute/ignored/config.json
```

`AX_EXECUTION_CONFIG` に設定ファイルのパスを渡すこともできる。`-once` は最大1件のclaimを処理する。通常はDBのready jobを1秒ごとに確認する。`/ax-controller -healthcheck` は稼働中プロセスのloopback 9092 `/healthz` を確認し、このhandlerは設定したAXの `/healthz` を1秒以内に読む。AXが利用不能なら503にする。healthcheckは外部実行の成否やDBのslot解放を保証しない。

## 親が行う実接続試験

1. 旧受付を止め、既存flockを保持し、未解決実行が無いことを確認する。必要な証明書・token・接続先を秘密を出さずに用意する。
2. `inspect -config <path>` の標準入力へrun IDのJSON配列を渡す。AX GetTask、Substrate GetActorとegressの読取だけを行い、run_idとboolのみを出力する。全件が `verified_stopped_and_denied=true` ならexit 0。
3. native image内の `offline-probe -config <path> -isolated-offline-probe` をcontrollerと同じ許可identityで実行する。これはDB受付を使わない隔離試験で、実サービスのジョブ処理には使わない。
4. `probe_succeeded`、成果物hash/size、usage=0、deny証拠、SUSPENDED/割当なしの証拠を保存する。本文は出力しない。
5. `probe_needs_recovery` や応答不明なら新しいprobeを実行しない。出力run_idの実状態と送信済み操作の終結を親が照合する。
6. PG schemaを試験DBへ適用し、APIでofflineを受付、同じcontrollerを `-once` で動かしてDB保存・所有者隔離・状態公開を確認する。

Resume後の読み取り接続を診断するときは `inspect -config <path> -guest` と同じrun ID配列を使う。GetActor、workerへのmTLS handshake、固定の存在しないprocess IDへのGetProcess、固定runnerの `status` だけを行う。停止中のActorは接続前に終了し、Resume/Stage/Start/egress/停止操作を呼ばない。返すのは各段階のbool、既知のrunner state、安全なcodeだけで、証明書、資格情報、生のRPCエラー、会話や成果物本文は返さない。

実Podの最初のprobeはCreate/Resumeの確認後、Stage/Startのintentを作る前に停止した。親の診断実測ではActorとworker取得は成功し、TLS接続で失敗していた。担当の読取では既存NetworkPolicyがatenet-routerからのIngressだけを許可していた。親がcontroller PodからworkerのTCP 443への許可を別policyで追加すると、同じrunの診断が全段階成功し、runnerは `waiting` を返した。原因はNetworkPolicyで、45秒のReadyTimeoutや証明書設定は変更していない。失敗したrunの再開始はせず、cleanupと実停止の確認は親が担当する。

診断の接続エラーは、TCP timeout/refused/unreachable/reset、TLS timeout、client証明書/CA拒否等の固定codeへ分類する。アドレスや生のメッセージは出力しない。分類の回帰は変更前に失敗、変更後に成功した。停止Actorを再開しないこと、割当欠落を拒否すること、生のgRPCエラーを隠すことも局所試験で確認した。

診断追加後のGo 30件、race、vet、既存3コマンドのbuildが成功した。担当の実環境操作はkubectl get/logと既存inspectの読取のみで、NetworkPolicy変更・実guest診断・cleanup・再配備は親の実測として区別している。

親から既存15件のinspectが全てtrueだったと報告あり。これは親の実測であり、担当による再実行とは区別する。担当はAX/モデル実行、DB変更、サービス停止を実施していない。

## 局所確認と残件

`go test -race ./...` と `go vet ./...` が成功。テストは開始応答喪失時に送信1回、intent/evidence応答喪失、heartbeat停止、既存intentの拒否、recovery時の再開禁止、成果物改ざん、JSONの重複キー/null/不正Unicode、出力上限、AXだけSuspended、実worker割当残存、SPIFFE完全一致/CA拒否、投影token更新を確認する。

Goの局所試験は実Pod mTLSやDB接続の証明にはならない。Docker build、worker identity設定、実offline、PG結合、旧経路遮断の実測は親の記録を待つ。CAローテーション時の計画再起動、未知RPCの運用回復、復旧用の再送権を新設しないためのholdは制約として残る。

独立レビューのP2対応として、正常終了で進行中heartbeatをキャンセルした際に、その終了処理をDB障害と扱う競合を修正した。heartbeatが停止中のまま全証拠の保存を完了させる回帰試験を追加し、修正前は `finished=false / failed=true` で失敗、修正後はFinish成功を確認した。work contextが既に終了しているheartbeatの応答は障害通知へ流さず、稼働中の本当のheartbeat障害は引き続き処理を止める。修正後の27件、race、vet、3コマンドbuildが成功した。

知識化候補は、router観測が暗黙Resumeすること、direct atunnelのactor一致検査、AX phaseと実停止証拠の分離、投影資格情報の読取タイミング。OKF編集は親に委譲し、この担当では保存していない。
