# WebからAX実行の検証

2026-10-06。基準6ac723aからの `codex/web-agent-runs` の実装差分を確認した。入力受付から成果物・使用量・終了処理までを対象にする。テスト用fixtureと実AXの観測を分けて記録する。

## 自動検証

| 確認 | 結果 | 対象 |
| --- | --- | --- |
| Python unittest | 85件成功 | 既存CLI、原子的受付、並行再送、worker、強制終了、復旧、費用guard、成果物照合 |
| Node tests | 12件成功 | 認証、入出力schema、UTF-8上限、HTTP、Python bridgeの時間・出力制限 |
| TypeScript | 成功 | React Routerの型生成と型検査 |
| 本番ビルド | 成功 | WebとAPIの起動用成果物 |
| Playwright | 12件成功、19.5秒 | SSR、実HTTP、送信・結果・成果物、再送、同意、CSRF、JavaScriptなし、320px、キーボード、axe、起動・停止 |
| 差分の空白検査 | 成功 | git diff --check |

実行コマンドは `web/README.md` に記載した。Python・HTTPの詳細は [Python証拠](evidence/python-verification.md) と [HTTP証拠](evidence/http-verification.md)。ブラウザの実行処理は専用fixtureを使い、AXやモデルの課金APIを呼ばない。axeの自動検査は完全なアクセシビリティ適合の証明ではない。

通常フォームのCRLFとJavaScript送信のLFで同じ内容の再送が409になる回帰、同じqueryとfragmentへの履歴更新でGETが発生しない回帰は、修正前の失敗を確認してから修正し、同じ期待値で成功を確認した。最終12件にはこの2件を含む。

## 実AX・実ブラウザ

Docker/kind上の既存AXと固定済みrunnerイメージを使用した。モデルを使わないoffline実行を2件行い、どちらも正常終了、使用量0、概算0 USD、通信遮断とTask停止を確認した。

1. ブラウザから `ax-run-da7fe9c039631b36` を受け付け、完了画面と成果物 `web-check.txt` を確認した。成果物は期待した日本語を含む63バイトと完全一致し、SHA256は `bf9f58e0e594af0c5000707a458943b07db2c0127a3ffcd1a1abb21183874041`。同じ受付キー・内容で再送しても同じ実行IDが返り、新しいTaskを作らなかった。[機械的照合](evidence/real-ax.json)、[画面](evidence/real-ax-result.jpg)。
2. `ax-run-c6eb4df778149a38` の完了後にWeb/APIを終了・再起動し、同じ実行の結果と成果物を再表示できた。[観測記録](evidence/restart-before.json)。当初は実行中のAPI停止を予定したが、停止前に実行が完了した。実AXの実行途中でのAPI停止を確認したことにはしない。

受付プロセスの終了後に有限workerが動き続けること、worker強制終了時にも残存transportコマンドが全体ロックを保持することは、隔離したPython子プロセス試験で確認した。実際の `with-env.sh` 経由でも渡したロックFDが継承されることを検査した。実行途中の実AX/API停止については上記の限界が残る。

モデル経路は明示選択・同意を必要とし、既存Antigravity/Gemini設定と費用guardを再利用する。今回のモデルAPI送信は0件。Webから有料モデルへ至る全経路の実動作は未検証で、今回の実AX成功はoffline経路に限る。過去のCLI実モデル成功を今回のWeb検証結果へ加算しない。

## レビューと残る範囲

[独立レビュー](review.md)で必須の2指摘を修正した。復旧要求直後の観測タイミングによって自動更新が始まらないことがあるというP3改善案は残した。結果画面の「状態を更新する」で確認でき、復旧の二重開始防止・費用制御には影響しない。

認証基盤、複数利用者、公開配置、RAG、新しいモデル接続先は今回の対象外。PRのCIと反映結果はタスク・GitHubの記録で追う。
