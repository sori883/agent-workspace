---
type: decision
title: 共通APIと実行管理を分離しPostgreSQLへ保存する
governance: context
code_refs: 
  - web/api/
  - web/data/
  - web/scripts/deploy-execution.ts
  - execution/
  - ax-local/scripts/import-legacy.sh
sources: 
  - resource: .space/tasks/ax-portable-api/design.md
  - resource: .space/tasks/ax-portable-api/verification.md
  - resource: web/data/schema.sql
  - resource: execution/native/
  - resource: web/scripts/deploy-execution.ts
description: 共通APIのホストPython依存を外し、app PostgreSQLと独立した実行管理へ移行した境界・理由・復旧制約
generated: 
  by: agent:codex
  at: 2026-10-06T12:27:49.687Z
---
# 共通APIと実行管理を分離しPostgreSQLへ保存する

2026-10-06、利用者はAPI配置先にPythonやローカルファイルを要求する構成を見直し、受付・所有者確認を共通APIへ移し、会話・実行履歴・成果物をPostgreSQLへ保存するよう依頼した。Cloudflare Workersは移植性の確認基準で、配置先の決定ではない。Task内部のPythonは継続する。採用理由は利用者の指示と `.space/tasks/ax-portable-api/design.md` の比較に直接対応する。

## 採用した境界

Hono/TypeScriptの共通APIがJWTと内部利用者を照合し、会話・実行・成果物をapp PostgreSQLへ読み書きする。保存の不変条件はDB関数へまとめ、owner、会話の末尾、同一キーの再送、全体実行枠、費用・未知usageを一つのtransactionで確認する。既存Keycloak DBは認証基盤だけが使い、AX RedisはAX内部状態だけを持つ。

AXに隣接する常駐Go controllerがDBの確定受付を1件ずつ取得する。各外部操作のintentを先に保存し、応答と実観測を照合する。応答不明の操作を再送せず、期限切れclaimを自動で奪わない。DB世代番号だけでは外部RPCを遮断できないため、旧writerと残存RPCの停止を証明した管理者だけが復旧を許可する。利用者の復旧要求は再開始を許可しない。

APIはDB用のquery境界だけに依存する。Nodeはpg Pool、Workers用entryはHyperdrive binding経由のpg Clientを使う。業務処理はNode/fs/subprocessに依存しない。React Router BFFは現状Nodeのままで、APIのWorkers互換性をWeb全体の移植完了とは扱わない。

## 選ばなかった案と代償

APIがAX/guest/Substrateを直接操作する案では、HTTPの寿命と長い外部処理が結び付く。短命の実行環境から副作用の状態を確認し続ける必要もあるため、独立controller案を採用した。旧PythonをHTTP化するだけでは受付・保存をAPIへ移す要求が残るため採らなかった。

常駐controllerとDB運用が増え、応答不明時は人手の調査を要する。一方、API再起動や再送でモデル実行を増やさず、ホストの共有ファイルを必要としない。現在の成果物は1件64 KiBまでの小さなUTF-8データなのでbyteaへ保存する。大きなファイル用のobject storageは未導入であり、将来必要になれば別途設計する。

## 固定版の外部接続

固定Substrateのatenet-routerはguest要求のたびにResumeActorを呼ぶため、status/collectにも使わない。controllerはGetActorで現在のworker割当を確認し、worker443へPod証明書のmTLSで直接接続する。CA・ServerAuth・SPIFFE identityを検証する。workerはcontrollerのclient identityだけを受け付け、NetworkPolicyもcontroller Podから443だけを追加許可する。

AXのgRPCは認証interceptorを持たない版なのでcontrollerと同Podのloopbackへ限定し、旧Serviceを除く。AX内部のrouter readiness設定も削除する。配置は1 replica/Recreateとし、旧プロセスの停止を伴わない並行更新を避ける。これらはKubernetes管理者や侵害されたcontroller自体を隔離する仕組みではない。

## 移行と確認範囲

旧受付を止めて同じflock下でretirement markerを作り、DB dumpと旧run全体を保全した。15件を全件transactionで取り込み、ID・owner・順序・hash・原bytes・費用・未解決状態を保持した。ownerなしの記録を自動割当しない。旧file writerは通常実行を拒否し、新規DB受付後に古いファイルへ戻さない。

Nodeと実workerdの同じAPI契約、実PostgreSQLの保存と障害、実AXのoffline、実Keycloakからの無償実行と同一キー再送を確認した。最初の接続試験で不足していたNetworkPolicyを修正し、失敗したTaskは再実行せず停止を証明した。追加paid要求は0。実paid全経路、Cloudflareへの公開、全基盤の復元は未確認。詳細は `.space/tasks/ax-portable-api/verification.md`、運用は `web/README.md` と `execution/README.md`。

[現在のWeb構成](../../../knowledge/ax-web-foundation.md)と[旧CLIの設計経緯](single-task-cli.md)、[会話契約](chat-turns.md)を参照する。
