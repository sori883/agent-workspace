# 実行管理 attempt 2：ActorTemplate既定値の補正

2026-10-07。実装担当は `w1_design_review`、独立レビュー担当は `w1_design_a`。初回実AX previewのCreate失敗を受けて、受理済み単位をこの修正のために再開した。以前の確認は [execution-implementation.md](execution-implementation.md) に残し、この記録で上書きしない。

## 原因と変更

対象run `ax-run-5d4af8d3dc67a9a6` はCreateで保留となった。AXログの2026-10-07T07:12:56.388Zに `credential-free template mismatch` を確認した。実ActorTemplateにはreadiness timeoutが30秒で保存され、Actorの取得はNotFoundだった。DBのcreate intent、start未送信、model/tool 0件は親が確認した。

固定Substrate `944abe3278b895ccbf5d45555a49dd0f2f6ceae7` の `cmd/ateapi/internal/controlapi/defaults.go:55–62` は、未指定のtimeoutを30秒へ補う。AX `ac2332829f22360ff97b0ba34d94dd0dd782f17e` の `internal/substrate/client.go:248–253` はこの値を未指定にしていた。patchが補完前の期待値と保存後の値を比較したことが原因だった。

- `ax-local/patches/credential-free-atespace.patch`：期待templateのreadiness timeoutを30秒にする1行を追加。他のcontainer・env・volume・sandbox・snapshot設定の厳密比較は維持する。
- `ax-local/patches/credential_free_test.go.txt`：模擬APIに実APIと同じ0→30秒の補完を追加。既定値の受理、31秒への変更拒否、保存済みFailed Taskの明示Suspendを追加した。
- `execution/cmd/inspect/main.go`：`--interactive`で既存の `InteractiveNative()` を選ぶ。指定がなければ従来設定、専用設定が欠けていれば拒否する。任意atespaceや接続先の上書きは追加していない。
- `execution/cmd/inspect/main_test.go`：専用設定の必須条件、image・identityの選択、allowedHostsが空であること、従来設定を変更しないことを確認する。
- `ax-local/patches/README.md`：既知の既定値と、Create途中で失敗したTaskの復旧条件を記録した。

## Red → Greenと局所検証

先に模擬APIへ30秒の補完を追加し、製品patchを直す前に `TestCredentialFreeAcceptsDefaultedReadiness` が `credential-free template mismatch` で失敗することを確認した。同じ原因で既存の鍵なし作成・清掃試験も失敗した。期待値の補正後は成功し、31秒への改変は拒否した。

Go 1.27.1で次を実行し、成功した。件数はトップレベルの `Test...` 関数数であり、subtestを重複計上していない。

| 確認 | 結果 |
| --- | --- |
| `mise exec go@1.27.1 -- bash ax-local/patches/verify-credential-free.sh` | AX controller 7件＋substrate 4件＋専用10件、計21件のrace試験とAX server build成功 |
| executionで `go test -race ./cmd/inspect ./settings ./native` | inspect 2件＋settings 2件＋native 22件、計26件成功 |
| executionで `go vet ./cmd/inspect` | 成功 |
| executionで `go build ./cmd/...` | 成功 |
| executionで `go run ./cmd/inspect -help` | `-interactive`表示を確認、終了0 |
| 対象差分の `git diff --check` | 成功 |

AX試験は固定上流を一時ディレクトリへarchiveして実行した。共有上流ソース、DB、Kubernetesを変更していない。模擬鍵だけを使用し、モデルを呼んでいない。このattemptではexecution全体のrace試験を再実行したとは扱わない。

## 独立レビュー

`w1_design_a` は作成に参加せず、timeout=30が固定Substrateの既定値と一致すること、他fieldの厳密比較、inspectの専用identity・allowedHosts・従来設定の維持を確認し、静的レビューの追加必須指摘なしと報告した。追加のFailed→Suspend試験とREADMEを含む最終版も同担当へ渡した。最終版の独立再実行結果は、この記録作成時点では受領待ちであり、実装担当の実行結果と区別する。同じモデルによる別担当レビューである。

## 復旧経路とlive検証の区分

固定AXはCreate時にTaskを保存してから同期Reconcileし、失敗をFailedとして保存する。起動時の再調停ループはなく、Get/Watchも再開しない。更新だけでは不足Actorは作成されない。

通常cleanupのdeny policyはActorへの外部キーがあるため、Actor不存在のままでは作成できない。局所試験では、保存済みFailed TaskのGetが無作用であること、明示SuspendがActorを1件作成して停止し、Resume/Revertを一度も呼ばないことを確認した。

親へは、受付閉鎖・旧controller退役／送信経路遮断／途中RPC終結の確認、保存Taskのscope・image・command・env／Workspace bindingの照合、修正版AXへの対象Suspend、SUSPENDEDとworker未割当の観測、事実に基づく `ax_authorize_recovery`、通常controllerによるdeny/suspendと終結の順序を引き渡した。以前のCreateを再送せず、create evidenceを成功へ書き換えない。

親からv2 imageのbuild/pushとDeployment Recreate rollout成功を受領した。read→Suspend→recoveryは親が実施中であり、この記録は実対象の復旧成功、新previewの成功、全体受け入れを保証しない。実装担当はlive変更を行っていない。

## 対象のSHA256

| ファイル | SHA256 |
| --- | --- |
| `ax-local/patches/credential-free-atespace.patch` | `866b3342b13db166206ddd4f51e3898e6bd7a79d750a30a2cacbb184db17a767` |
| `ax-local/patches/credential_free_test.go.txt` | `6c91810ee5544cb3a948c78085c9aecdd4a63d6e3587c567baebe058a1eae610` |
| `ax-local/patches/README.md` | `c0c4022bf44e1fc719efc85b44206e1c90401df03217ca03e38dc0e9bf836ac6` |
| `execution/cmd/inspect/main.go` | `d011654501628a05fe39f8dd1896e8449d2be08b0dd4dbb0593c24a1beb7be03` |
| `execution/cmd/inspect/main_test.go` | `74f68c874fae338d37b6b7a4413bc9487827ae27c96c9f2d40c4a2ca8bf0739d` |

## 追補：共有workerへの接続条件

質問run `ax-run-85c1708b1f1a279b` の成功後、回答run `ax-run-063623052db6c137` が既存`ax-demo` workerへ割り当たった。専用`ax-runtime` identityを期待する接続条件と実割当が一致しなかった。親はstart未送信・create/resume確定・needs_recoveryを確認し、対象Actorを明示Suspendした。

固定Substrateのschedulerはatespaceでworkerを分けない。ActorとActorTemplateのworker selectorは両方ともworkerラベルとの照合で、WorkerPoolに逆向きのTask選別機能はない。空selectorのTaskは既存poolと追加poolのどちらにも割り当て得る。根拠は `cmd/ateapi/internal/scheduling/scheduling.go` と `cmd/ateapi/internal/controlapi/workflow_resume.go`。Workerのラベルは `cmd/atecontroller/internal/workersync/syncer.go` がWorkerPoolのmetadataから同期する。

親と独立担当Aは、両領域の新旧templateへselectorを導入する案と、既存の信頼済みworkerを共有する案を比較し、後者を採用した。初期previewは固定toolだけを許可し、namespace別workerをTask隔離の保証とは扱わない。鍵なしの`ax-runtime` atespace、専用ActorTemplate、TaskごとのgVisor、egress deny、厳密なmTLSとActor割当の検査は維持する。AX patchは変更しない。

- `execution/settings/settings.go` は `InteractiveNative` の期待guest identityを `spiffe://cluster.local/ns/ax-demo/sa/default` に固定した。atespaceは`ax-runtime`のまま。
- `execution/cmd/inspect/main_test.go` は共有identityでの選択に加え、旧専用identity・任意identity・空値の拒否を確認する。従来設定の不変、固定image、allowedHostsなしの確認を維持した。
- `execution/README.md` と `ax-local/patches/README.md` は共有pool、旧専用poolの退役条件、別poolを追加する場合の再検討を記した。配置スクリプトとlive切替は親の所有である。

先にfixtureを共有identityへ変更すると `TestInteractiveSelectionUsesPinnedIdentityAndImage` は `interactive_config_required` で失敗した。settingsの期待値変更後に、Go 1.27.1の `go test -race ./cmd/inspect ./settings ./native` は26件成功、`go vet ./cmd/inspect ./settings`、`go build ./cmd/...` と差分checkも成功した。許可するidentityは引き続き一つに固定し、任意identityを受け付けない。この試験は実workerへの接続成功を保証しない。

前節で受領待ちだったAの独立再実行は成功報告を受領した。AX patchのrace試験・buildとinspect/settings/nativeのrace試験を同担当が実行し、追加指摘なしだった。共有worker変更も同担当が下記4ファイルのhash一致、固定identity、atespace、allowedHosts、従来設定と文書を確認し、追加必須指摘なしと報告した。同担当の `go test -race ./cmd/inspect ./settings ./native` も成功した（cache使用）。live接続はこのレビューの対象外である。

| 共有worker変更後のファイル | SHA256 |
| --- | --- |
| `execution/settings/settings.go` | `5907e5567948a292a9f32b6ec3c28e16597dfa581481b63b38b2de181442fe81` |
| `execution/cmd/inspect/main_test.go` | `3d81a4c6655f4d8516960c663142554d7958838b6e2a59f774c6e216cd8719ae` |
| `execution/README.md` | `8197d68c842582470314afe4d6a005249ecc1f3b1e0f681f99b1246b3dd5f79e` |
| `ax-local/patches/README.md` | `52da3d745aaa211bf4c30b697b158b92c3169b16c610f153922eb8370c0a5860` |

この追補時点で実装担当はDB・Kubernetes・モデルを操作していない。専用poolとworkerの退役、v3 controllerの配置、失敗runの通常cleanup、新しい質問・回答のlive成功は親が別途確認する。ここでは合格としていない。
