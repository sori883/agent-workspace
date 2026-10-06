---
governance: context
code_refs: 
  - ax-local/task_cli.py
  - ax-local/task_runtime/
  - ax-local/tests/
tags: 
  - ax
  - task-cli
  - cost
  - recovery
sources: 
  - resource: ax-local/task_cli.py
  - resource: ax-local/task_runtime/adapters/gemini_meter.py
  - resource: ax-local/tests/verify_task_sdk.py
  - resource: .space/tasks/ax-task-cli/task.md
  - resource: https://github.com/sori883/agent-workspace/pull/2
type: decision
title: AXの単発CLIで開始・成果物・使用量を分離して管理する
description: 1実行1Taskと固定出力アダプターを採用し、再送・不明な使用量・失敗後の無調査送信を止める設計と検証結果
generated: 
  by: agent:codex
  at: 2026-10-05T12:36:22.659Z
---
# AXの単発タスクと費用不明時の停止設計

2026-10-05に採用。小さなUTF-8の指示・入力から成果物1件を作り、1件ずつ次のタスクを実行するCLIを対象とする。

## 責務と状態の分離

ホストCLIが実行IDとローカル台帳を持ち、1実行ごとに新しいAX Taskを作る。常駐ワーカーへジョブを渡す案と独立に比較し、課金開始・成果物・失敗の対応を追いやすいこの形を採用した。起動の遅延を許容し、ジョブキューは導入しない。

共通処理はtask_cli.py、task_runtime/protocol.pyとrunner.py、SDK依存はadapters/antigravity.pyへ分ける。offlineアダプターはモデルなしのインフラ試験用である。他のサービスやWeb接続は未実装。

AXはgolden snapshot作成時もTask commandを起動するため、commandは開始合図を待つだけにする。ホストが通常Actorと通信設定を確認し、startを一度だけ送る。ゲストとホストの両方で開始済み状態を保存し、曖昧な返答でも再送しない。

## 成功・失敗と復旧

成果物、正常終了、既知の使用量、通信遮断とTask停止が揃って成功とする。AXのRunning/Readyは実行環境の状態であり、子処理の成否とは別である。

recoverは既存結果の回収・通信遮断・停止だけを行い、Taskをresumeしない。SDK実行途中や未消費の開始合図をresumeすると、復旧操作から有料処理が進む可能性があるため。Suspendedで結果未回収の実行は未解決として止め、個別調査へ回す。

使用量不明やcleanup未完了は次の実行を拒否する。使用量とcleanupを確認できても、有料の失敗後は原因・修正のローカル記録を必要とする。acknowledge-failureは調査メモを保存するだけで実行しない。同一指示・入力・imageの失敗は記録後も再送を拒否する。

## Gemini使用量の完全性

Antigravity SDK 0.1.20の公開usageは累計で、後段のHTTP失敗やusage欠損があっても前段の数値が残る。ネットワークなしの実SDK試験で確認した。累計だけを既知とすると、使用量不明時の停止条件をすり抜ける。

公開APIの利用だけでは解決できず、単一モデル要求に機能を縮小する案、SDK内部protobufへ依存する案、各HTTP応答を確認する案を比較した。現在の機能と費用条件を維持するため、Gemini専用の小さな監視をアダプター内へ置く案を採用した。

監視は同一ゲスト内のloopbackに一時起動し、本番上流・モデル・パスを固定する。実キーは上流だけへ渡し、SDKには仮のキーを渡す。再試行やredirectは行わず、回数・時間・サイズを制限する。SSEの正常終了と要求ごとのusageを確認し、SDK累計と一致する場合だけ概算を作る。不明を検出すると、その実行の後続送信も拒否する。これは汎用のHTTP proxyや全通信隔離を提供するものではない。

CLI観測の概算累計0.01 USDで追加の有料実行を止めるが、請求総額や円建ての厳密上限ではない。利用者の費用条件と別の小さな試用停止閾値である。

## 根拠

実装と再実行可能な試験はax-local/task_cli.py、task_runtime/、tests/。利用手順はax-local/task-cli.md、検証要約はax-local/verification.md。実装時の比較・受け入れ証拠は.space/tasks/ax-task-cli/task.mdに保持する。

## 出力ツールを固定する理由

最初の実モデル試験ではSDK builtinのwrite_to_fileにArtifactMetadataが付いた。通常の出力先はSDK brainディレクトリではないためinvalid_argsとなり、モデルの修正でファイルは作成されたがtool2枠を使い切って失敗した。上限を増やす案や予算停止を成功扱いにする案は採らない。

SDK0.1.20にはbuiltinのArtifactMetadataだけを除く公開設定がないため、標準custom toolのwrite_output(content)へ置き換える。本文以外の引数を公開せず、指定名の通常ファイルを1回だけ作る。SDK専用の成果物属性とFINISH builtinをモデルへ渡さず、作成後の短い最終応答で終了する。SDKは引き続きエージェント実行とツール呼出しを担い、独自ループには置き換えない。

## 実装確認

2026-10-05、65テスト、ネットワークなしの実SDK12ケース、最終イメージと7sourceのSHA256一致、独立レビュー指摘0を確認した。実AXのoffline2件とstart後のCLI強制終了からの回収を確認し、修正後の実モデル試験ax-run-42a5505a34e292abも通常終了した。成果物はAX_INPUT_OK改行の12bytes。使用量1403input/34output/0thought、2要求、概算0.00040175 USD。最初の失敗を含む今回の実試験2件の概算合計は0.00126475 USD。全Taskは通信deny・Suspended。

実装は[PR #2](https://github.com/sori883/agent-workspace/pull/2)、head be96ad79e8f94412dbcf17fd2b6e5f65a889f5ea。公開検証はax-local/verification.mdにあり、詳細な根拠は前掲タスク記録へ戻れる。

# Related Concepts
- [AXのモデル利用費を2,000円以内に抑え、成果のない大量送信を禁止する](../../../rules/ax-model-spending.md): 使用量不明や成果のない反復送信を止める設計の制約

- [AXローカル実行基盤の構成と確認方法](../../../knowledge/ax-local-kind-environment.md): このCLIを実行し検証したローカル基盤と初回導入の記録
2026-10-05 21:35日本時間、PR #2をsquash mergeした。マージコミット0766234ce3306743da0e1f4df8e33ac38c1f59efへローカルmainもfast-forward済み。GitHub Actionsの65testsとshell構文確認は成功。秘密値・個人用スキル・内部記録は公開していない。

