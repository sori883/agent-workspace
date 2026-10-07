# agent-workspace

Google AXを使ったエージェント実行基盤のローカル検証環境です。

[ax-local](ax-local/README.md) に、ARM64のDocker・kind上でAXとSubstrateを動かす設定、実行例、再ビルド手順をまとめています。最初のマイルストーンとして、Antigravity SDKとGeminiによるファイル作成と正常終了を確認しました。

これは単一利用者向けの検証環境です。現在の確認範囲と制約は [検証要約](ax-local/verification.md) を参照してください。

[Webアプリ](web/README.md)から認証・ワークスペース・本人限定のチャットとAX上のエージェントを使えます。会話・実行・成果物はPostgreSQLに保存します。対話ランタイムの構成と拡張範囲は[設計書](docs/agent-runtime-design.md)を参照してください。

[概略設計](docs/web-architecture.md)と[ローカルWeb版の作業範囲・概算](docs/web-mvp-estimate.md)に全体像と次の作業をまとめています。
