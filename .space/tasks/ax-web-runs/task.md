# WebからAXエージェントを実行する

2026-10-06。基準 `6ac723a`、ブランチ `codex/web-agent-runs`。進行状態の正本は [orch台帳](orch/)。

利用者はW1の往復と模擬応答を確認し、次のAX接続・操作画面・検証を1つのPRで作るよう依頼した。W2〜W4を同じPRへまとめ、内部では確認可能な単位で進める。既存Python CLIと費用・開始・回収の制御を再利用する。ローカル単一利用者、全体同時実行1件。共通認証・公開配置・新しいモデルサービスは範囲外。

## 受け入れ条件

| ID | 条件 | 証拠 | 状態 |
| --- | --- | --- | --- |
| R1 | ブラウザから指示・テキストを渡して非同期に受け付け、実行IDを取得する | 実AX offline2件、ブラウザ→BFF→API→Python→AX | 確認済み |
| R2 | 状態・結果・成果物・使用量・失敗理由を一覧/詳細から参照できる | 成果物63バイト完全一致、使用量0、通信遮断・停止。verification.md | 確認済み |
| R3 | 同じ受付キーの再送・二重送信で新しいTaskを作らない | 同キー実AX再送、並行受付・応答再送・永続記録の試験 | 確認済み |
| R4 | 再起動・途中停止・使用量不明・後片付け未確認で勝手に再実行しない | 子プロセス試験・既存guard・完了後の実サーバー再起動。実AX途中停止は未確認 | 確認済み |
| R5 | Host/Origin/session/CSRF・入力/出力上限と情報境界を維持する | Python85件・Node12件・ブラウザ12件、型/build成功 | 確認済み |
| R6 | テスト実行を既定とし、モデルを使う実行は料金と条件を明示して選べる | 既定offlineで実確認。model同意を試験、今回の有料送信0件 | 確認済み |
| R7 | 起動手順・復旧方法・現在地を残し、独立レビュー・CI後に1つのPRを反映する | PR #7、独立レビュー、両CI成功。反映結果は納品先の状態を参照 | PR引き渡し済み |

## 工程・担当

- 既存Webの配置・SSR・ローカル認証はW1から再利用。新しい非同期受付/データ所有/プロセス寿命はdevlowの独立設計A/Bと第三者比較で決める。
- Python/台帳、Web API/境界、画面/ブラウザ操作を単位に分ける。設計確定後に所有範囲を指定する。親が統合・実AX操作・レビュー受入・PRを担当。
- 比較/レビュー担当は読み取り専用。全員が共有checkoutで作業し、他者の変更を戻さない。外部モデル呼出・実AX操作は親だけが行う。
- 検証はPython既存テスト、非同期/重複/停止試験、型/build、HTTP、実ブラウザ、実AX offlineの順。必要な有料試験は目的・出力・回数制限を先に決め、既存上限とguardを維持する。

## 確認した制約

`.space/babel`の全rule/principle候補を確認。本文を読んだのは `rules/pr-delivery`、`rules/ax-model-spending`、`principles/{boundary-discipline,foundational-thinking,make-operations-idempotent,model-the-domain,separate-before-serializing-shared-state,experience-first,test-behavior-not-implementation,prove-it-works,type-system-discipline,laziness-protocol}`。CLIのパス検索で `decisions/systems/ax/single-task-cli`、`knowledge/ax-local-kind-environment` を読み、W1の `knowledge/ax-web-foundation` を引き継ぐ。

有料利用は2,000円上限、無駄な反復は禁止。CLIの概算累計0.01 USD停止、未知のusage・cleanup未完のguardを解除しない。TaskCLI.runは実行全体で既存flockを保持し、receiptを原子的に保存する。recoverは開始合図の送信やTaskのresumeを行わない。

## 設計・進捗

[設計と比較結果](design.md)、[境界契約](contracts.md)を採用し、実装へ進んだ。進捗・確認・受け入れはorchの3 unit（ax-web-runs / ax-web-python / ax-web-http）で追う。

## 根拠と納品準備

[検証](verification.md)・[レビュー](review.md)へ実結果と限界を記録した。実AX offlineの使用量は0。実行途中の実AX/API停止と、Webから有料モデルへの全経路は今回未検証。復旧直後の自動更新タイミングは手動更新で補う。

OKFは既存の `knowledge/ax-web-foundation`、`decisions/systems/ax/single-task-cli`、`knowledge/ax-agent-platform-direction` をCLIで更新し、現在の非同期受付と経緯、設計理由、確認範囲を反映した。読み返し一致、strict/driftのエラー・警告0。新しい重複conceptは作成していない。

## 納品先

[PR #7](https://github.com/sori883/agent-workspace/pull/7)へW2〜W4をまとめた。実装コミット `2e7f84cd146ecdeb0cc76986ee29250f51c3071c` のGitHub Actionsは、AX local CLI/offline-testsとWeb workspace/web-testsの両方が成功した。[CIの観測](evidence/ci.json)。この記録への追記はコードを変更しない。

このファイルは検証済みPRへの引き渡し時点の記録で、マージ操作前に保存する。反映の成功を先取りせず、マージコミットと最終チェックは上記PRの状態を正本とする。親は通常の承認方針に従い、PR最終版のチェック後にマージ・main反映を確認して利用者へ報告する。
