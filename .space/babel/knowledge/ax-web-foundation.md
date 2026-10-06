---
type: knowledge
title: ローカルWeb土台W1の契約と理由
description: React Router SSR/BFFとHonoの模擬APIを分けた起動・セッション・通信境界と、W2へ進む際の維持条件
status: stable
tags: 
  - ax
  - web
  - w1
code_refs: 
  - web/
sources: 
  - resource: web/README.md
  - resource: .space/tasks/ax-web-foundation/task.md
  - resource: docs/web-architecture.md
  - resource: web/tests/boundaries.test.ts
  - resource: web/tests/browser/
generated: 
  by: agent:codex
  at: 2026-10-06T01:49:13.982Z
---
# ローカルWeb土台W1

2026-10-06、利用者の再開・実装指示を前回checkpointとW1〜W4の計画に照合してW1を実装した。[全体構想](ax-agent-platform-direction.md)のWeb入口に対応する。現在の画面は模擬メッセージの往復のみで、AX Task・モデルAPIには接続しない。

## 責務と起動

`web/app/` がReact Router Framework ModeのSSR/BFF、`web/api/` がHonoの共通API。ブラウザはWebにだけ接続する。`scripts/run.ts` はWeb/APIを別Nodeプロセスで起動し、`127.0.0.1:3100/3101` を既定にする。単一プロセス案と比較して、API単独障害の表示とW2の実行管理の分離を優先した。

起動管理は準備確認と自身の子の終了だけを行う。稼働後のAPI停止でWebを巻き込んで停止せず、APIの再起動・要求の自動再送もしない。準備確認はWeb応答の署名Cookieを起動時の鍵で検証し、ポートを使用中の別サービスが返す200を成功と誤認しない。起動途中の失敗とWebの終了は子全体を回収する。API・共通処理・設定を編集したらコマンド全体を再起動する。

## セッションと通信の境界

WebはHost、送信時のOrigin、署名Cookie、CSRFを検証する。Cookieはポート別の名前でHttpOnly・SameSite=Strict、絶対期限30分。起動ごとの鍵変更でも失効する。ローカルHTTPなのでSecureは付けない。これは同じPCの敵対プロセスを隔離する認証ではなく、公開・複数利用者への転用は対象外。

Referrer-Policyはsame-origin。no-referrerではJavaScriptなしの通常フォームPOSTがOrigin:nullとなり、React Router 8の要求元検証で拒否されたため変更した。フォーム構造とサイズを検証したら、セッション検証より前に表示用入力を保存する。これにより期限切れ・再起動後の拒否でも入力を保持し、API呼出しは検証成功後に限定する。

APIの全経路は固定Host・起動時Bearerを確認し、Origin付き要求を拒否する。秘密値や接続先URLをブラウザへ渡さない。要求・応答本文は16 KiB、メッセージはtrim後1〜200 UTF-16コード単位。BFFの通信は本文の受信まで3秒、redirectと自動再試行を禁止する。API不通時はactionの失敗を優先して、利用環境欄に古い接続成功を残さない。

## 確認範囲と次の単位

境界テスト5件とブラウザテスト7件で、正常往復、SSR、JavaScriptなし、Cookie消失時の入力保持、320px幅、キーボード、axe自動検査、実API停止、dev/startのポート競合と子回収を確認した。完全なアクセシビリティ適合や実AX接続の証明ではない。デザインはプロジェクト内の[参照スキル](project-design-skill.md)が保存したDADSの基本・フォーム・通知を参照した。

W2で既存Pythonを共通API内部から再利用し、非同期受付・実行ID・状態照会・永続台帳へ接続する。GET/SSRは実行を開始しない。費用不明時の停止、二重開始防止、外部通信遮断とTask停止の条件は[単発CLIの設計](../decisions/systems/ax/single-task-cli.md)と[費用ルール](../rules/ax-model-spending.md)を維持する。W1の200文字制限は疎通確認専用であり、既存Task入力の仕様は変えていない。
