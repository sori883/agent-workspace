# 旧タスクCLIと台帳

通常の実行入口は[Web・共通API](../web/README.md)です。会話・受付・結果はPostgreSQLへ保存し、Go controllerがAXを操作します。`ax-local/.state/execution/managed`がある環境では、旧`ax-local/task`はrun・dry-run・inspect・recover・acknowledge-failureを含めて`legacy_writer_retired`で拒否します。Python bridgeも全操作を拒否します。

この文書は旧原本の見方と保つべき制約を説明します。移行済み環境で旧CLIの実行例を使わず、managed印や開始済みの印を削除しないでください。移行と管理者復旧は[実行管理の手順](../execution/README.md)を参照します。

## 入力とTask内の処理

旧CLIと現在の共通APIは、同じTask内runnerプロトコルを使います。1回の実行につき新しいAX Taskを作り、指定した成果物1件を回収します。Webの単発作業では入力テキストをrequestの`inputs["input.txt"]`として渡します。Task内に独立したinput.txtを作るという意味ではありません。

| 項目 | 制限 |
| --- | --- |
| 指示 | UTF-8で2048バイト。空白だけは不可 |
| Taskプロトコルの入力 | 最大4ファイル相当、本文合計4096バイト。Webはテキスト1件 |
| ファイル名 | 英数字で始まり、英数字・`_`・`.`・`-`の最大64文字 |
| 成果物 | 1ファイル、最大64 KiB。サイズとSHA256を照合 |
| 旧原本のパス | 通常ファイル。symlink・特殊ファイルを拒否 |

エージェントには本文だけを受け取る`write_output`ツールを渡し、固定した出力先へ1回だけ作成させます。自由なシェル実行・ファイル読み取りは許可しません。TaskのRunning/Readyと処理成功は別で、正常終了・成果物・既知usage・通信遮断・実停止を合わせて判定します。

## 旧原本の保存先

移行前の記録は`ax-local/.state/runs/<run_id>/`です。移行後も原本とバックアップを保持し、通常の新規受付では更新しません。

| ファイル | 内容 |
| --- | --- |
| `request.json` | 指示、入力、adapter、出力名 |
| `manifest.json` | 固定digestのAX Task定義 |
| `receipt.json` | 受付・進行、owner、会話連鎖、cleanup、費用・結果の台帳 |
| `result.json` | 別ファイルで回収した終了状態・usage・成果物情報 |
| `artifacts/<出力名>` | 回収した成果物bytes |

DBへの取り込みではrun ID・会話ID・owner・順序・hash・usage・原bytesを保ちます。result.jsonだけが新しくreceiptに反映されていない場合、成功へ補完せず隔離します。ownerなしの旧記録はWebへ公開しませんが、費用・未解決判定には含めます。取り込み済み記録を実行キューへ戻しません。

旧台帳の取り込みは[ロック付き移行手順](../execution/README.md#初回準備と旧台帳からの移行)で一度だけ行います。DBで新しい受付を始めた後、旧ファイル台帳へ単純に戻すことはできません。

## 失敗・中断した場合

現在の復旧要求は共通APIから行います。外部操作を一度も試みていない受付は`not_started`にできます。外部操作済みのrunは管理者が旧controllerの停止・接続遮断・送信中操作の確定を確認してから復旧を許可します。画面操作だけではこの確認を代行しません。

復旧で新しいTaskを作成せず、開始合図や再開を送りません。稼働中の既存Taskから回収できる結果を保存し、通信遮断・Substrate実停止を観測します。過去の送信権を再利用した再送は禁止です。停止中Taskの未回収結果、未知usage、未確定の後片付けがあれば保留を維持します。

旧`task recover`や`acknowledge-failure`は使いません。管理用DB関数・証明の条件と未実装の復旧範囲は[停止と復旧](../execution/README.md#停止と復旧)を参照してください。失敗記録を削除したり、別の受付キーに変えたりしてガードを避けないでください。

## 費用と接続先

Task内のモデルアダプターはAntigravity SDK 0.1.20とGemini 3.1 Flash-Liteです。モデル呼出3回、ツール2回、入力6000・出力512・合計6512トークン、API再試行0、出力形式の再処理1、実行90秒の制限を使います。接続先は`generativelanguage.googleapis.com`に限定します。

各API応答のusageを確認し、応答欠損・usage欠落・途中エラーがあれば費用不明として後続送信と新規受付を止めます。有料失敗は原因と修正を確認するまで次の有料実行を止め、同じ指示・入力・イメージの失敗を自動再送しません。

DBが観測した概算の累計0.01 USDで追加の有料実行を止めます。旧ownerなしの費用も含めます。この試用閾値はプロバイダー請求総額ではなく、上限2,000円の方針を置き換えません。SDK予算・概算単価・プロバイダー側上限には集計や見積りの限界があり、請求額の厳密な保証ではありません。上限引上げ・追加購入・高額モデルへの自動切替は行いません。

新しい実行管理への移行確認はofflineと模擬障害で行い、有料モデルを呼びません。過去のモデル成功は[初期検証記録](verification.md)、現構成の結果は[移行検証記録](../.space/tasks/ax-portable-api/verification.md)で区別します。

## モデルを使わずに確認する

Webの「動作テスト」はAXのTask内で入力を結合して成果物へ保存します。モデル判断を含まず、egressはdeny、usageはofflineの0です。実AX経路の検証・受付再開が完了した環境で使います。

Pythonの局所試験は旧契約互換、移行後の拒否、Task内プロトコルを確認します。モデルAPIへ送信しません。

```sh
python3 -m unittest discover -s ax-local/tests -p 'test_*.py' -v
```

共通API・DBとcontrollerの試験は[Webの検証](../web/README.md#検証する)、[Goの検証](../execution/README.md#モデルを呼ばない検証)を参照してください。実SDKの通信なし検証は[再ビルド手順](rebuild.md#タスクcli用イメージ)にあります。旧ローカルCLIを再有効化する必要はありません。
