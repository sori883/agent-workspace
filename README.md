# agent-workspace

Google AXを使ったエージェント実行基盤のローカル検証環境です。

[ax-local](ax-local/README.md) に、ARM64のDocker・kind上でAXとSubstrateを動かす設定、実行例、再ビルド手順をまとめています。最初のマイルストーンとして、Antigravity SDKとGeminiによるファイル作成と正常終了を確認しました。

これは単一利用者向けの検証環境です。現在の確認範囲と制約は [検証要約](ax-local/verification.md) を参照してください。

Webの最初の段階として、[React Router＋Honoの接続確認画面](web/README.md)を追加しています。ブラウザから模擬応答を確認でき、AXやモデルAPIには接続しません。実AXへの接続と共通認証は後続です。

[概略設計](docs/web-architecture.md)と[ローカルWeb版の作業範囲・概算](docs/web-mvp-estimate.md)に全体像と次の作業をまとめています。
