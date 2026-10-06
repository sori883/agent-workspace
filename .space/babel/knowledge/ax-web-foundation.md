---
type: knowledge
title: ローカルWebの境界と非同期実行
description: SSR/BFFとHonoの境界、既存receiptへ統合したAX非同期実行、再送・復旧・費用制御の理由と確認範囲
status: stable
tags: 
  - ax
  - web
  - execution
code_refs: 
  - web/
  - ax-local/web_bridge.py
  - ax-local/task_cli.py
sources: 
  - resource: web/README.md
  - resource: .space/tasks/ax-web-foundation/task.md
  - resource: docs/web-architecture.md
  - resource: web/tests/boundaries.test.ts
  - resource: web/tests/browser/
  - resource: .space/tasks/ax-web-runs/design.md
  - resource: .space/tasks/ax-web-runs/verification.md
  - resource: .space/tasks/ax-web-runs/review.md
  - resource: ax-local/web_bridge.py
  - resource: web/tests/runs.test.ts
generated: 
  by: agent:codex
  at: 2026-10-06T03:06:21.098Z
---
# ローカルWebの境界と非同期実行

2026-10-06、W1の接続確認に続き、W2〜W4の受付・実AX実行・結果画面を実装した。`web/` が入口、既存Python CLIが実行と費用の所有者である。[全体構想](ax-agent-platform-direction.md)のローカル単一利用者向け段階に対応する。旧模擬応答は `/connection` に残す。

## 責務と起動

`web/app/` はReact Router Framework ModeのSSR/BFF、`web/api/` はHonoの共通API。ブラウザはWebにだけ接続する。`scripts/run.ts` はWeb/APIを別Nodeプロセスで起動し、`127.0.0.1:3100/3101` を既定にする。W1では単一プロセス案と比較し、API単独障害の表示と実行管理の分離を優先した。

起動管理は準備確認と自身の子の終了だけを行う。稼働後のAPI停止でWebを巻き込んで停止せず、APIの再起動・要求の自動再送もしない。準備確認はWeb応答の署名Cookieを起動時の鍵で検証し、ポートを使用中の別サービスの200を成功と誤認しない。起動途中の失敗とWebの終了は子全体を回収する。API・共通処理・設定の変更は全体を再起動する。

## セッションと通信の境界

WebはHost、送信時のOrigin、署名Cookie、CSRFを検証する。Cookieはポート別名でHttpOnly・SameSite=Strict、絶対期限30分。起動ごとの鍵変更でも失効する。ローカルHTTPなのでSecureは付けない。同じPCの敵対プロセスを隔離する認証ではなく、公開・複数利用者への転用は対象外。

Referrer-Policyはsame-origin。no-referrerではJavaScriptなしの通常フォームPOSTがOrigin:nullとなり、React Router 8の要求元検証で拒否されたため。フォーム構造とサイズを検証したら、セッション検証より前に表示用入力を保存し、期限切れ・再起動後の拒否でも入力を保持する。API呼出しは検証成功後に限定する。

API全経路で固定Host・起動時Bearerを確認し、Origin付き要求を拒否する。秘密値や内部接続先をブラウザへ渡さない。実行APIは要求64 KiB・応答512 KiB、短命Python bridgeの待ち時間5秒、BFFは本文まで8秒。redirectと自動再試行は禁止。旧接続確認は16 KiB・3秒、trim後1〜200 UTF-16コード単位を維持する。

React DOM 19.2.8はtextareaのhydrationで非空の既定値をvalueへ代入する。読み込み完了前の入力を失わないよう、初回stateで既存DOMの値を取得してdefaultValueへ渡す。SSRでは既定値かaction入力を使い、カウンターもSSRと同じ値で初期化してeffectでDOM値へ同期する。JavaScript取得を保留した実ブラウザ試験で保持を確認した。

## 受付台帳とworker

独立設計ではWeb専用台帳と既存receiptへの統合を比較し、後者を採用した。台帳を分けるとCLI/Webの排他と受け付け済み状態の整合が二重になる。既存CLIをprepare/executeに分け、request・manifest・receiptを一時ディレクトリへ書いてfsync後、renameで一括公開する。

受付キーと入力のfingerprintをreceiptへ保存する。同じキー・内容の再送は既存IDを返し、異なる内容は409。同一キーの照合をロック前後で行い、新規受付は既存の全体flockと費用guardを通す。acceptedも未解決としてWeb/CLI両方の追加実行を止める。GETとSSRはTaskやworkerを起動しない。

新規受付だけが有限workerを1回起動する。workerはAPIの寿命から独立し、既存ロック下でaccepted・未着手の記録だけを実行する。外部コマンドへロックFDを渡し、worker強制終了時にコマンドだけが残っても並行操作を防ぐ。観測時も同じロックを利用して、receiptと実行中状態のずれによる誤った復旧表示を抑える。Python変更は実行中worker終了後に行う。

復旧は既存の結果回収・通信遮断・停止に限定し、開始合図を再送せずTaskをresumeしない。外部操作前の受付はnot_startedで解決し、未実施の通信遮断・停止を成功扱いにしない。復旧直後はworker開始とのタイミングで自動更新が始まらない場合があり、手動更新で確認できる。詳細は[単発CLI設計](../decisions/systems/ax/single-task-cli.md)。

## 操作と入力

受付キーはフォームURLのdraftに保持する。再読込やセッション更新で消さず、別の作業は「新しい実行」で新規キーにする。通常フォームのCRLFとJavaScriptのLFが別内容にならないよう、BFFで指示・テキストの改行をLFにそろえる。一覧更新は同じdraftを送る通常GETフォームでactionを `/` とする。同一queryにfragmentだけを付けたactionではページ内遷移となり、GETが起きなかった。

既定offlineは実AX内で入力を成果物に保存し、モデルを使わない。modelの明示選択と外部送信・料金への同意がある場合だけ、設定済みAntigravity/Geminiを選ぶ。指示2048バイト・入力4096バイト、成果物1件64 KiBまで。成果物はサイズ・SHA256・UTF-8を再確認して表示・取得する。未知usage、cleanup未完、有料失敗のguardと[費用ルール](../rules/ax-model-spending.md)を維持する。

## 確認と経緯

W1は境界5件・ブラウザ8件で模擬往復を確認した。W2〜W4の最終確認はPython85件、Node12件、ブラウザ12件、型検査、buildが成功。ブラウザ試験の実行バックエンドはfixtureである。

実ブラウザからAX offlineを2件実行し、期待成果物・使用量0・通信遮断・Task停止を確認した。同じキーの再送で実行が増えず、完了後のWeb/API再起動でも結果を再表示できた。実行途中の実AX/API停止は停止前に完了したため未確認。worker寿命・強制終了時の排他は隔離した子プロセス試験で確認した。今回の有料API送信は0件で、Webからの有料モデル全経路は実機未検証。

デザインはプロジェクト内の[参照スキル](project-design-skill.md)が保存したDADSの基本・フォーム・通知に基づく。320px・キーボード・axeは確認したが完全適合の証明ではない。根拠は `.space/tasks/ax-web-runs/{design,verification,review}.md`、利用手順は `web/README.md`。
