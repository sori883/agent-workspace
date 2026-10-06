# AXで指示を変えて1件ずつ実行するCLI

2026-10-05。担当・記録更新: root。状態: 完了。利用者はCLIで次の指示を実行する方針と実装を承認し、通常のPR作成・マージまで承認済み。基点はPR #1のmain 7d023e85。既存スキル・内部記録は未追跡のまま保持する。

## 範囲と工程

小さなUTF-8指示・入力を受け、成果物1件と終了結果・使用量を保存する。標準規模として調査・独立2案と比較・実装・オフライン/実AX検証・独立レビュー・PRマージを行う。費用は既存の2,000円ルールを維持し、通信なしの根拠を揃えてから実モデル1件を最小単位で確認する。Web・他社接続・並列実行は含めない。

## 設計比較

候補A（task_cli_design_a）はホストCLIが1実行=1新規AX Taskを管理し、ゲストは開始合図後に一度だけ処理する。候補B（task_cli_design_b）は永続Taskのワーカーへジョブを送る。双方は同じ要件を独立に検討した。

評価基準は課金開始と失敗復旧の追いやすさ、状態の分離、実装/運用負担、将来Webへ接続できる入口。比較担当local_auth_reviewもAを推奨。Aを採用し、Bのジョブキュー/常駐受付は採用しない。起動遅延は許容し、実行IDで分離された台帳と結果確認入口を保つ。

## 契約と不変条件

- ホスト保存先: ax-local/.state/runs/<run-id>/。run-idは `ax-run-` + 小文字hex16字。プロセスロックと未解決台帳で同時・曖昧な実行を拒否する。
- request.json: schema_version=1、run_id、adapter（antigravity / offline）、instruction（UTF-8最大2048bytes）、inputs（名前:本文の辞書、最大4件・合計4096bytes）、output_name（英数から始まる英数/underscore/dot/hyphenの最大64字）。outputとinputは別領域。adapter offlineはインフラ検証用でモデルを呼ばない。
- result.json: schema_version=1、run_id、adapter、status（succeeded/failed/timed_out）、exit_code、stop_reason、usage（数値の辞書またはnull）、estimated_usd（概算またはnull）、error_type（型/識別子のみ）、artifact（name,size_bytes,sha256またはnull）。成果物上限64KiB。成功には通常終了・既知使用量・成果物を要する。offline使用量は明示的に人工値0として別扱い。
- ゲスト `/opt/ax-task/runner.py` は `wait`、`stage BASE64_JSON`、`start RUN_ID`、`status RUN_ID`、`collect RUN_ID` を提供。固定保存先 `/workspace/task`。テスト用のみ `--root` を受け付ける。stage/start/attemptedは排他、collectは結果JSONとartifact_base64を返し、実行を開始しない。
- Task commandはwaitのみ。golden snapshotではモデル実行なし。CLIが通常Actorを確認、入力配置、egress設定/読戻し後、startを一度だけ送る。呼び出し前にホストの段階を保存し、曖昧な返答で再送しない。
- 既存のモデル3回・ツール2回・入力6000/出力512/合計6512・APIretry0/出力retry1・90秒を維持。モデルは3.1 Flash-Lite固定。コアとSDK依存のアダプターを分離する。
- 結果を回収して通信を空へ戻し、Taskを停止する。途中の失敗でもcloseを試す。SIGKILL/ホスト停止時は次の起動で未解決台帳を拒否し、明示的なrecoverで回収・遮断・停止だけを行う。新規作成/start再送/attempted解除はしない。

実装前の境界確認で、recoverによる自動resumeは採用しないことにした。開始合図だけが残る状態やSDKプロセスの途中状態を再開すると、回収操作からモデル処理が進み得るため。ActorがRunningなら既存結果を回収できる。Suspendedで未回収ならunknownを保持して調査対象とし、新しい有料実行を拒否する。ホストCLIが観測した概算累計には0.01 USDの保守的な試用停止閾値を設けるが、プロバイダー請求総額や円建て上限の保証とはしない。

## 所有範囲と順序

1. runtime担当: task_runtime/protocol.py、runner.py、adapters/、tests/test_runtime.py。モデルAPI送信・実環境操作は禁止。
2. host担当: taskラッパー、task_cli.py、tests/test_task_cli.py、scripts/set-egress.goの設定読戻し。runtimeとの契約は上記に合わせる。モデルAPI送信・実環境操作は禁止。
3. root: Dockerfile/ignore/versions、examples、公開README、ビルド、統合検証と実環境操作、共有記録、PR。初期成功Taskと費用制約を維持。

## 受け入れ条件

- A1: 指示と少量UTF-8入力から成果物1件を作り、状態・使用量をCLIで取り出せる。
- A2: モデルなしの連続2実行で混在せず、同じ実行は二重に開始されない。
- A3: 未知入力、パス逸脱、symlink、サイズ超過を実行前に拒否する。
- A4: 失敗・timeout・使用量不明・通信遮断失敗を成功とせず、曖昧な実行の再送を防ぐ。
- A5: 中断後のrecover/inspectでモデルを再実行せず、結果とcleanup状態を照合できる。
- A6: 独立レビューとネットワークなしの実SDK検証後、実AXのoffline確認と最小の実モデル1件を確認する。費用と成果を見て追加送信は止める。
- A7: 公開差分を検査し、PR作成・レビュー・マージとmain反映まで確認する。

## 統合検証中の記録

2026-10-05。実AXのoffline 2件（ax-run-8bc0cb50cc85eec6 / ax-run-3eda01d4e534c2ca）で入力・出力の分離、全件通信遮断とSuspendedを確認。2件目はstart応答後にホストCLIをSIGKILLし、recoverだけで既存成果物を回収した。API呼出しなし。証拠は ax-local/.state/task-e2e-offline-1.json と task-e2e-offline-2-recovered.json。

独立レビューで、SDK累計usageは後段APIエラー・usage欠損時に部分値を既知に見せる問題を確認した（task-sdk-usage-red.log）。公開SDKの累計APIだけでは要求ごとの完全性を確認できない。単一モデル要求に縮小する案、内部protobufへ依存する案、Gemini専用監視を追加する案を比較し、機能と費用ルールを維持できる最後の案を採用。アダプター内のloopback HTTP、固定上流、要求ごとのSSE検証と不明後の送信停止に限定する。汎用proxy化はしない。実装・追加レビュー完了まで有料試験は行わない。

2026-10-05の監視修正後、共通/CLI/meterの58テストとnetwork none実SDK12ケースが成功。途中usage欠損とAPIエラーではunknownになり、usageが全欠損/zeroなら上流1要求で後続を止めた。監視の終了競合とConnection: close応答のsocket所有についてレビュー指摘を修正し、待機中通信の終了・再送拒否をunitで確認した。ソース検証の証拠はtask-unittest-final.logとtask-sdk-meter-development.log。最終イメージ・実モデル試験は次に確認する。

## 実モデル試験1と原因調査

12:22 UTC、最終image001f6451でax-run-95edd726055e2fa1を1件実行。2 model requests、2666 input /131 output /0 thought、概算0.000863 USD。MAX_TOOL_CALLS_EXCEEDEDで失敗、cleanupは通信deny・Suspendedとも成功。未解決usageではなく既知の失敗として次のpaidを止めた。dry-runでさえ同fingerprint再送拒否を確認した。

通信denyのまま、結果とattemptedを確認済みの終了Taskを手動resumeして保存履歴だけを取得し、再suspend。新たなstart/モデル送信はしていない。transcriptでは最初のwrite_to_fileがArtifactMetadataを指定し、SDKのbrain以外では不正として失敗。次のwrite_to_fileでその属性がなくなり、AX_INPUT_OK改行の12bytesが作成されたが、tool2枠を消費して全体失敗になった。失敗を成功に読み替えず保持する。証拠は task-model-diagnosis-files.json / task-model-diagnosis-transcript.log。

上限を増やさず、公開ツールschemaから不要なArtifactMetadataを除外する方法または固定出力のcustomtoolを調査する。次の実送信は修正とオフライン再現・レビューの後に判断する。

公開SDK設定ではArtifactMetadata単独の除外ができないことを調査。標準custom tool write_output(content)を採用し、パス引数・builtin/FINISHを出さず、固定出力の1回作成だけにする。runtime担当がadapter/helper/unitを変更、rootがSDKスタブ・docs・imageを変更する。費用と呼出し上限は変更しない。

## 受け入れ結果

最終imageは1bce740d1ab5a5f7f051d67a7c36c24f7c9a21ffeebd1bb38a77c7d2b95939a5。65tests、実SDK12ケース、image内7source SHA一致、独立レビュー指摘0を確認した。失敗原因と修正証拠をacknowledge-failureで記録し、上限を増やさず変更後試験を1件だけ行った。ax-run-42a5505a34e292abが成功し、成果物AX_INPUT_OK改行12bytes、終了0/UNSPECIFIED、usage1403/34/0、model_call_count2、概算0.00040175 USD、egress denyとSuspendedを確認。試験2件の合計0.00126475 USD、以後追加モデル送信はしない。証拠task-e2e-model-fixed.json、task-model-failure-review.json。

| 条件 | 判定 | 根拠 |
| --- | --- | --- |
| A1 | 合格 | 最終image実AXで指示・入力→成果物と使用量を回収 |
| A2 | 合格 | offline2実行の分離とstart排他テスト |
| A3 | 合格 | protocol・host・固定出力の境界試験 |
| A4 | 合格 | 途中API/usage欠損・timeout・cleanup失敗・未知使用量・失敗レビューgate試験 |
| A5 | 合格 | 実CLIをstart後SIGKILL、recoverだけで回収し再送せず停止 |
| A6 | 合格 | network none SDK12/65 tests・独立レビュー・実AX試験。途中失敗は保持し原因を修正した上で1件再試験 |
| A7 | 合格 | PR #2のCI成功、レビュー指摘0、21:35 JSTにmergeしlocal mainへ反映 |

## 引き渡し

PR #2 https://github.com/sori883/agent-workspace/pull/2 を2026-10-05T12:35:30Zにsquash merge、main=0766234ce3306743da0e1f4df8e33ac38c1f59ef。GitHub CI65件+shell構文成功。local main fast-forward済み、追跡ファイルの未反映差分なし。既存の.agents/.codex/.space/AGENTS.mdは未追跡のまま保存。

知識は decisions/systems/ax/single-task-cli、knowledge/ax-local-kind-environment、knowledge/ax-agent-platform-direction を作成/更新し、意味のある関連を接続した。28conceptのstrict/drift検査はerrors/warnings/リンク不足0件。

今回の受け入れ条件A1〜A7は全て合格。Web/他プロバイダー/並列化/本番運用の耐久性は今回対象外。使用手順ax-local/task-cli.md、公開検証ax-local/verification.md。モデルの追加送信は成功後に停止した。
