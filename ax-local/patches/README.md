# AXの鍵を持たない実行領域

対象上流は `ac2332829f22360ff97b0ba34d94dd0dd782f17e`。このpatchは管理者が `AX_DISABLE_CREDENTIAL_ATESPACES=ax-runtime` と指定した領域だけを変更する。Taskから設定を解除することはできない。

- Secret参照とAXサーバー環境からのモデル鍵取得を行わない。
- Taskによる環境変数指定とWorkspace bindingを拒否する。初期Runtimeは固定image・command・明示入力だけを使う。
- 専用ActorTemplateの作成失敗時にdefault templateへ戻らず、既存templateのcontainer・env・volume・sandbox・snapshot設定を生成予定と照合する。
- 既存Actorのtemplate参照と状態を照合し、CRASHED Actorからsnapshotを自動復旧しない。
- 停止要求は既存Actorを直接停止できる。template不一致を理由に清掃を妨げない。
- 指定していない`ax-demo`の既存動作とSecretは変更しない。

これは保存済みsnapshotから秘密を消す処理ではない。Go controllerは新規受付に新Task IDを使い、create前のActor不存在とresume前のtemplate・worker未割当を検査する。旧Taskやsnapshotを新経路で流用しない。

固定SubstrateはActorTemplateの保存時に未指定のreadiness timeoutを30秒へ補う。比較する期待値にもこの既知の値を反映する。timeout自体や他の設定を比較対象から外すことはしない。実APIと同じ補完を模擬側へ追加すると、修正前は`credential-free template mismatch`になり、修正後は作成に成功する。31秒への改変は引き続き拒否する。

## 局所検証

```sh
ax-local/patches/verify-credential-free.sh
```

固定revisionを一時ディレクトリへarchiveし、patchと専用テストを適用する。共有`.sources/ax`・DB・Kubernetesは変更しない。模擬gRPCで鍵注入・Task鍵指定・fallback・template改変・snapshot復旧の拒否、清掃、旧領域の互換性を確認し、upstream controller/substrateのraceテストとAX server buildを実行する。使用する鍵文字列は合成値だけである。

## ビルドと配置への引き渡し

```sh
ax-local/patches/prepare-credential-free.sh /tmp/ax-runtime-build-unique

docker build --platform linux/arm64 \
  -t localhost:5001/ax-server-credential-free:runtime \
  /tmp/ax-runtime-build-unique
```

出力先は存在しないディレクトリを指定する。固定上流だけを取り出してpatchを適用し、digest固定のGo builderを使うDockerfileを置く。共有上流のcheckoutや稼働imageは更新しない。

registryへのpush、実digestの記録、受付閉鎖、未解決runと実停止の確認、AX Deployment更新、共有worker・identity設定、実Actorの無課金検証は配置担当が行う。AXのloopback管理口を公開しない。Taskのegressはdenyを維持する。

注入禁止の対象atespaceは`ax-runtime`だが、実行先は信頼済みの既存`ax-demo/ax-local` WorkerPoolを共有し、guestのSPIFFE identityは`spiffe://cluster.local/ns/ax-demo/sa/default`に固定する。atespaceとworker namespaceは別の設定であり、固定Substrateはatespaceによるworker選別を行わない。専用`ax-runtime` WorkerPoolを残さず、移行前にActorの実停止・worker未割当を確認する。鍵なしの保証はこのpatchと厳密なActorTemplate検査で維持し、pool名を隔離境界にしない。初期previewの任意コードは許可しない。

配置後は実Taskのenv値をログへ出さず、鍵変数がないことを判定値で確認する。Runtimeの起動時要求0、質問→停止→新Task回答、SDK/PG使用量一致、mailbox応答喪失、成果物hash、通信遮断・worker未割当を確認してから受付を開く。局所テスト成功を実Actorの隔離確認とは扱わない。

## Create途中で失敗したTaskの復旧条件

固定AXのCreateはTaskを保存してから同期でReconcileし、失敗するとphaseをFailedとして残す。サーバー起動時に保存済みTaskを再調停する処理はなく、Get/Watchも再開しない。修正版への更新だけでは不足Actorは作成されない。

Actor不存在、保存Taskあり、start未送信の組合せでは、通常のcleanupが先に作るdeny policyがActorへの外部キーで拒否される。この場合は管理者が次の順序を守る。

1. 受付を閉じ、旧controllerプロセスの退役・送信経路の遮断・途中RPCの終結を個別に確認する。
2. 対象Taskの名前とatespace、保存image digest、command、envなし、Workspace bindingなしを台帳と照合する。env値は出力せず、読取結果から判定値だけを記録する。
3. 修正後AXへ対象TaskのSuspendだけを明示する。固定実装はphaseをSuspendedとしてからReconcileするため、不足Actorを作成して停止する。Create/Resume/runner startは再送しない。
4. ActorのSUSPENDEDとworker未割当を読み戻し、事実に対応した退役証拠で管理用`ax_authorize_recovery`へ渡す。通常controllerがdeny/suspendの実証を保存し、失敗として終結する。以前のCreate evidenceを成功へ書き換えない。
5. `inspect --interactive -config <設定>`へrun ID配列を渡し、対象領域のdeny・実停止を確認する。`--interactive`未指定は従来のax-demo、interactive設定欠落時は拒否する。

これは修正版の静的照合と模擬gRPC試験で確認した復旧経路であり、稼働対象での成功証拠は配置担当が別途記録する。Actor不存在だけを成功やcleanup完了の証拠にしない。
