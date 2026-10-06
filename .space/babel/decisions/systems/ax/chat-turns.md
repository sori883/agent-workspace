---
tags: 
  - ax
  - chat
  - web
  - idempotency
code_refs: 
  - ax-local/chat.py
  - ax-local/web_bridge.py
  - ax-local/task_cli.py
  - web/shared/chat-contracts.ts
  - web/app/routes/chat.tsx
sources: 
  - resource: .space/tasks/ax-chat/design.md
  - resource: .space/tasks/ax-chat/contracts.md
  - resource: .space/tasks/ax-chat/verification.md
  - resource: ax-local/chat.py
  - resource: web/app/routes/chat.tsx
type: decision
title: 会話の各往復を既存receipt付きAX実行として保存する
description: 旧ファイル構成での設計理由を保持し、現在の共通API・PostgreSQL移行と維持する契約を示す
generated: 
  by: agent:codex
  at: 2026-10-06T12:27:49.928Z
---
# 会話の各往復を有限AX実行へ対応させる

## 現在の適用範囲（2026-10-06）

受付・所有権・会話・費用と実行記録の正本はapp PostgreSQLへ移り、共通APIとGo実行管理が担当する。旧ホストCLI/bridgeは通常操作を拒否する。Task内部Python、1実行1Task、同一キー再送、成功文脈だけの継続、未知usageと再開始禁止の条件は維持する。[移行の決定](portable-api-postgres.md)を現在の配置と保存方式の正本とする。以下は旧ファイル構成を採用した時点の理由・検証の記録である。

## 当時の設計

2026-10-06採用・実装。利用者は本番配置より先に、前の会話を踏まえて質問・相談を続けられる画面を希望した。短いテキスト会話を対象とし、各往復を[既存の有限Task](single-task-cli.md)として動かす。

## 決定と代替案

PythonのreceiptへconversationのID・親run・1始まりの順序を持たせる。会話順序はreceipt、利用者本文はrequest.instruction、返答は検証済みartifacts/reply.txtが正本。別の会話DBへ本文を複製しない。UI/API/BFFは保存形式やAX操作を所有しない。[Webの共通境界](../../../knowledge/ax-web-foundation.md)を通して読む。

会話専用SQLite案も検討した。空会話・編集・分岐には向くが、会話保存→AX受付→run関連付け→成功返答コピーの各停止点と照合が増える。今回必要な会話継続にはreceipt連鎖を採用し、SDK常駐状態の復元も追加しない。独立候補A/Bが同じ構造へ収束したため、別所有のA2を追加探索し、非作成者と親が比較して決めた。

## 再送・文脈・停止

元のPOST本文と会話IDで冪等性hashを作り、現在の履歴から作り直さない。同keyはhead・上限の判定前に照合する。新規受付では既存global flock内で親が現在headと一致するか、先行全runが解決済みか、文脈容量と既存費用guardを確認し、request/manifest/receiptを一度に公開する。worker開始前にも連鎖を検証する。GET・同key再生・再起動はworkerを増やさない。

headには失敗/未開始も含む。モデルへ渡す過去文脈には成功・usage既知・cleanup完了・hash/サイズ/UTF-8を検証済みのuser/assistantペアだけを含め、request.inputs["conversation.json"]へcompactなrole/content JSONとして固定する。欠損・分岐・順序不正・保存文脈改変はfail closed。失敗を文脈から外しても、使用量不明や失敗レビューの既存guardは解除しない。

最新発言は2048バイト、過去文脈は4096バイト、受付は最大32回。上限では新しい会話を案内し、無言の切り捨てや有料要約は行わない。モデル/呼出回数/トークン/90秒/API再試行0/0.01 USD停止を変更しない。通常応答は完成後に表示する。

## Webと境界

ルートはチャット、単発作業は/tasks、接続確認は/connection。会話UUIDをURLへ持ち、会話UUIDと末尾runから決定的に次の送信UUIDを作る。503では元のkey/text/parentを保持し、readonlyの同内容再送とGET確認を提供する。React RouterのGET revalidateでactionDataが消えるため、送信状態はcomponent stateでも保持し、次のsubmittingで消す。textarea初回DOM値の保持はdraft一致時だけにし、前の送信本文を次の空欄へ復活させない。

会話APIはlist/get/turnsの3操作。会話応答は1MiB、既存runは512KiB。32turnの失敗本文と最後の64KiB成果物はJSONエスケープで512KiBを超え得るため、符号化後上限と最大制御文字試験を設けた。Host/Origin/Bearer/session/CSRF、5秒bridge/8秒BFF、自動再試行なしは維持。

## 確認と限界

Python100件・Node19件、チャットブラウザ5件と既存12件を確認。実AXは2往復で、最初の合言葉を再読込後の質問に含めずに尋ね、正答した。2件ともusage既知と通信deny/停止を確認し、今回概算0.00076925 USD。詳細は.space/tasks/ax-chat/verification.mdとevidence/real-chat.json。

単一利用者のローカル版。本番DB/PVC/認証、会話編集・分岐、token streaming、入力途中の下書き保存は追加していない。会話のreadは保存済み連鎖の検証を含むため、大量会話での性能は別途設計する。
