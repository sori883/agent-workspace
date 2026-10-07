# 私有ファイル経路の統合確認

2026-10-07、Node24.15.0、試験用OIDCと専用PostgreSQL schema、ブラウザ3210/3211。稼働DB・モデル・AXは変更していない。

型検査、Webビルド、File API契約1件、ブラウザ2件が成功。一括取消の接続確認を加えた最終ブラウザ結果は2件成功（5.3秒）。

- 約89KiBのCSVを32KiBずつ送信。最初のchunkを受付後に503を返す試験から再送し、一件だけ完成。再読込後のダウンロードは元の全byteと一致。
- BobからAliceのfile取得は404。CSRF不一致403、owner偽造payload400。APIでWorkspace必須、canonical base64と64KiB本文上限を検査。
- 空・8MiB超を送信前に拒否。未完了送信の個別取消と、退出Workspaceの一括取消操作（該当なし0件）をUI→BFF→API→DBで確認。
- 失効Workspaceに実draftがある場合の回復、他owner/ready/現在所属の保持、再加入・後発draft・chunk/seal競合は[専用DB試験](files-verification.md)で確認。
- 320 CSS pxで横方向のはみ出しなし。axeでWCAG 2A/2AA/2.1AAタグの違反0件。完全適合を示すものではない。

初回ブラウザ2件はSQL初稿の変数修飾不具合により受付503で失敗し、保存担当が修正後に上記の再試験を通した。現時点のschema-v6 SHA-256は`cd2380231128fc573373213e33b3a8e5fb954877a1313553ee932c18b8c2f186`。

この確認は保存・再取得の利用経路まで。ファイルをAXへ搬送して集計する経路、定義登録と定期実行は後続。
