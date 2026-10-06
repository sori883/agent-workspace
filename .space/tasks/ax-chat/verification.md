# チャットの検証

2026-10-06。基準main159fa7a、codex/chat-workspaceの今回差分。環境はmacOS ARM64、Node24.15.0、既存のkind/AX固定イメージ。初期Web試験はPATHによりNode26になっていたため、最終の型検査・ビルド・Node試験・ブラウザ試験を24.15.0へ明示固定した。

| 条件 | 結果と証拠 |
| --- | --- |
| C1 会話画面 | 新規チャット、送信、利用者/エージェント発言、会話一覧をブラウザで確認。real-chat.jpgに実会話を記録 |
| C2 文脈と保存 | 実AXで2往復。最初に「青い灯台」を伝え、再読込後は合言葉を含めずに尋ね、返答が「青い灯台」になることを確認。Web/API再起動後にも同じ2往復が表示された |
| C3 再送と異常 | Pythonの原子的保存前後強制終了/同キー/古い親/競合/復旧、ブラウザの503→GET確認→同内容再送→1発言のまま→空の次フォームを確認 |
| C4 境界・費用 | Python100件、Node19件成功。費用guard、Host/Origin/CSRF/厳密schema/上限/旧API互換性を確認。実AX2件ともusage既知・通信deny・停止完了 |
| C5 操作と表示 | チャット5件、既存ブラウザ12件成功。日本語IME中は送信せず、Enter改行、Ctrl+Enter送信、320px/keyboard/axe、JSなし。CUAで実画面390px幅の横溢れなし、desktopの履歴文字省略とレイアウトを確認 |
| C6 引き渡し | typecheck/build/diff check成功、evidence/review.mdで独立レビュー済み。[PR #8](https://github.com/sori883/agent-workspace/pull/8)へ提出し、source b64e7c5のCI 2件成功 |

## 局所とブラウザ

Python担当の100件はevidence/python-verification.md、HTTP担当の19件はevidence/http-verification.md。親もNode24.15.0で19件成功を確認。

最初のブラウザ試験ではfixtureがtitle改行の正規化とcontext_fullの算出を契約通りに行っておらず、HTTP schemaで拒否された。fixtureを本物と同じ条件に修正。

次に503時はReact Routerがloader再取得を省略し、受付済み結果が自動表示されないことを試験が再現した。受付不明時にもGET pollingを行うよう修正。再試験でGET revalidateがactionDataを消して原フォームも消すことを検出したため、原送信をcomponent stateへ保持し、次のsubmittingで消すよう修正。新規チャット5件を再実行し全件成功（21.3秒）。その直前の全件実行では既存12件と他の新規4件が成功しており、関係しない範囲は再実行せずCIで全体を確認する。

初回表示で入力欄が下へ押し出される余白と、デスクトップの会話題名の横溢れを実画像で確認してCSSを調整。最終実画面はevidence/real-chat.jpg。

## 実モデルの確認

目的、上限、入力、返答、文脈、usage、cleanupはevidence/real-chat.json。モデル実行は2turnのみで自動再試行なし。各turnはSDK内部2モデル要求、既存最大3要求・入力6000/出力512トークン・90秒・API再試行0を変更していない。

- ax-run-169fa22d8b488714: 「覚えました。」、1395 total tokens、概算0.000375 USD。
- ax-run-02da68daad1271fe: 「青い灯台」、1462 total tokens、概算0.00039425 USD。
- 今回合計0.00076925 USD。既存記録と合わせた概算0.00241975 USDで、CLIの0.01 USD停止条件を維持。

receipt/request/成果物を照合し、2件ともsucceeded・resolved・usage既知・egress_denied/suspended=true・cleanup_errors空を確認。公開する試験入力は親が作った無害な合言葉のみで、利用者の既存本文は読んだり掲載したりしていない。

## 確認範囲

初版は短いテキスト会話で、履歴JSON4096バイトまたは32受付に達すると新規チャットを案内する。返答は完成後表示。入力途中の下書きの再読込保持、token streaming、会話編集/分岐、共有ログイン、本番K8s保存は今回の範囲外。Web/API停止後の実行継続は既存経路の性質として維持し、今回の実AX試験で途中停止を追加実施したとは扱わない。


## PRでの全体確認

source commit b64e7c59da14a24b05cbb106b50df0be2b085dbb。PR #8を作成・このチャットへ添付し、[offline-tests](https://github.com/sori883/agent-workspace/actions/runs/37419185116)と[web-tests](https://github.com/sori883/agent-workspace/actions/runs/37419185128)が成功。Web CIでは型検査、Node試験、ビルド、Playwright17件を一続きで確認した。ここからの追記は検証・台帳の納品記録だけで、product codeを変更しない。通常のPRマージは最終記録のCI後に進める。

OKFにはdecisions/systems/ax/chat-turnsを作成し、knowledge/ax-web-foundationを更新。本文の読戻し一致、strict/drift検証のerrors/warnings 0を確認した。
