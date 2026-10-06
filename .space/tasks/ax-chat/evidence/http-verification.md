# HTTP検証

2026-10-06、担当 /root/w1_design_a が Node試験を実行。既存12件＋chats.test.ts 7件＝19件成功、typecheckとgit diff --check成功。親は担当の報告、schema/bridge/API/BFFの差分、契約との対応を照合した。

UUID正規化、厳密JSON型、会話ID/head/state/件数の同一性、Host/Origin/Bearer、本文枠、timeout、会話応答1MiBと旧run512KiBを確認。最大32turnの制御文字を含む応答をloopback HTTPで通し512KiB超/1MiB未満を確認。Python/AX/modelは呼ばずNode子プロセスとfake serviceを注入した。

担当範囲: shared/chat-contracts.ts, api/chat-service.ts, api/app.ts, api/index.ts, api/run-service.ts, app/lib/chats.server.ts, tests/chats.test.ts。実Webと実モデルの確認は親の統合検証へ分ける。
