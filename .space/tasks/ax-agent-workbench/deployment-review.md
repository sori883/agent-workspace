# Workbench配備helperの限定レビュー

2026-10-08。Cによる独立読取りレビュー。対象は親作成の `web/scripts/deploy-execution.ts`、基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6` から19行の差分（15追加・4削除）。確認時SHA256は `c55a3a166e5e8b26162f2881a0e0d8405ee3ab98bd8008b403fd184c2125e818`。helper実行、live read、DB/Kubernetes操作、製品コード変更は行っていない。既存のdevlow/use-principles/OKF検索範囲と、親の同時作業・所有制約を引き継いだ。

## D1 / P2: 基盤imageの希望値だけでは導入完了を確認できない

場所: `web/scripts/deploy-execution.ts:31–36`。

新しいateapi/ateletの必須条件は、Deployment/DaemonSetの `spec.template.spec.containers[].image` だけを照合している。対象imageをapply済みでも、rollout途中・新Pod失敗・旧Pod稼働・Deployment replicas=0の状態で条件を通過する。後続でWorkbench/Pythonを有効にしたcontrollerを配備できるため、実際の基盤が旧版のままという不整合を事前拒否できない。終端メッセージの一般的なreadiness確認やAX healthだけでは、このimage世代の混在まで確認したことにならない。

必要な補正: 最初のSecret/apply等より前に、両resourceについて最新generationのrollout完了、稼働が必要なreplica/node数が正数、updated/ready/available数の一致、旧世代Podの退役を確認する。又は同等の事前検証を明示した外部gateとしてhelperが検査する。Deployment/DaemonSetの新templateだけを「導入済み」の証拠にしない。親へ共有済み。

## その他の照合

- imageは追加3種もdigest付きlocal registry参照に限定する。versions値の未追加・不正、v8未導入、control行の欠落/不一致ではmutation前に停止する。
- DBのruntime/code image・profile・Python gate・trial gateと生成するconfigの対応は一致する。`--enable-model`がない場合はtrial/Go model送信を閉じ、model keyの取得/mountを行わない既存構造を維持する。
- AXのcredential禁止対象へax-codeを追加し、`AX_CODE_IMAGE`を固定する。旧値を除去してから単一値を入れるため、envの重複は残らない。
- execution containerを丸ごと置換し、`workbench-probe-config` volumeも除去する。標準executionのmountへprobe用設定を引き継がない。旧Service削除、loopback AX、Recreate、設定hash annotationは維持する。
- 現在のpublic root内訳、waiting=0、未解決run=0、runner_taskの後方互換性、APIとcontrollerのimage一致、最終code/基盤digestの対応は親の配備前確認・更新予定として引き継いだ。本レビューではlive照合やbuildをしていない。

**判定:** D1の補正又は同等の配備前gate確認が必要。その他の19行差分に追加の確定指摘はない。最終versions値と実Podのimage/readinessを照合したことにはしない。Cはv8保存層の作者でもあり、今回の独立性は親作成の配備helper差分に限定する。

## D1修正版の再確認（2026-10-08）

**D1は解消。追加の必須指摘なし。** 修正版SHA256は `7ff5a3a0aac3c36ae6614f1e71b5ad138e63fa95e5280017dcb0c491c570d107`。

`deploy-execution.ts:31–45` は最初のmutation前に、DeploymentとDaemonSetをそれぞれのstatus項目で検査する。desiredが正数、observedGenerationが現generationと一致、total/current・updated・ready・available数がdesiredと一致することを要求する。selectorで取得したPodについてもdesired数、terminating無し、expected image、対象container Readyを確認する。templateだけ更新された状態、replicas=0、旧Podと新Podの混在では後続applyへ進まない。

Cはソースと実行順を読取り確認し、差分のwhitespace checkを行った。helper実行、Kubernetes/DBの読取りや変更は行っていない。最終imageのbuild・versions更新・実Podの世代確認と通常機能復帰は親の配備検証に残す。
