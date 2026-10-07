# Workbench API・画面の検証

2026-10-07、親担当。専用 app_auth_test DB と模擬 controller を使い、v8 SQL・共通API・BFF・画面を接続した。AX Actor・外部モデル・生成Pythonはこのブラウザ試験では動かしていない。

## 確認した利用経路

- 公開スキルと本人ファイルを選んで依頼を開始する。最初の受付応答を喪失させても同じpacket/keyを再送し、実行を重複させない。
- 依頼と質問を履歴に表示し、回答を次区間に引き継ぐ。fixtureが用意したCSVを本人が取得し、実bytesが一致する。
- 実モデル同意なしの送信は発生0件。待機中作業を停止し、回答フォームを閉じる。
- 他人ファイルの拒否、CSRF・owner偽装拒否、再読み込み、幅320pxの横溢れなし、axe WCAG2/2.1 AA違反0件。
- 詳細取得が一時503でも、入力中回答と不明な受付packetを保持する。成功時のrevision変更のみ初期化する。
- 履歴50件超でページ送りしても元の質問を開いたままにする。別の新規作業の作成後も、元の質問へ回答できる。

## 結果と修正

Nodeテスト177/177成功、型検査成功、production build成功。Playwrightは files 2 + library 2 + workbench 4 の8/8成功（13.3秒）。証拠は `evidence/web-tests-v8.log` と `evidence/workbench-result-mobile.png`。最終画像を親が目視し、テキスト・操作・結果取得が途切れないことを確認した。

Bの独立レビューで、ページ送りによる回答keyの新規利用と、一時取得失敗によるフォーム初期化を検出。root IDを画面identityにし、ページ送りでも維持した。rootを取得できない更新ではrevisionを変更しない。2件の回帰をブラウザで確認し、Bのコード再確認も完了。詳細は `workbench-web-review.md`。

最初のブラウザ試験はfixtureの受付初期値が閉じていたため503となり、fixture限定で受付を開いた。追加ページ送り試験のseedではcurrent_run_idをnullにして応答schemaと矛盾したため、試験用履歴seedを修正した。製品の応答schemaを緩めていない。

## 限界

`browser-fixture.csv` は試験用合成データ。CSV集計がAX上で成功した証拠ではない。新機能の稼働DB移行・配備は未実施。有料Gatewayは閉じたまま、追加課金0件。定期実行は未実装。

## 対象SHA-256

- `web/api/app.ts`: `e356a15e35a38636c4f7bbb4a1d3dee7a9eceaebe0994d6541f488e316d52a62`
- `web/api/runtime.ts`: `6ca8be6128b8725981a8b1f805591023bef09f867b10f4641780de11de355eb5`
- `web/api/workbench-service.ts`: `0dce47f5dd9f2b098cb03940224e3dc8255b551ca98f6ec4292580674d43b6c0`
- `web/app/routes/workbench.tsx`: `4a1e6be20a43537c35f94f86ac151af3ecd17a9ef220e4d7e02145add2869486`
- `web/app/routes/workbench-transfer.ts`: `c341249fa8e1d8cdbc0f8d9c34a041b6bc2f2196b99b02642e03b13b551a556a`
- `web/app/lib/workbench.server.ts`: `701c57ffb4eb82db0211e53b2936582903bf0fe44c6d585c67c7afa9d6163494`
- `web/app/lib/workbench-copy.ts`: `8374fc347512cd7ea6458a88f6e3fe955f97d4f3a0076a49f806416ff2538039`
- `web/app/components/file-download.tsx`: `e5bf767f5c49a4d319fa65bcf5d74befd9340e5a3c1798c2317a9f83e5fe198e`
- `web/shared/workbench-transfer.ts`: `c7987068ece06af9750f134536be48ee43e3e517031968058e37dc3c87cb3d71`
- `web/shared/file-transfer.ts`: `2082dea819b71f739aeb8e8d519afd7a940049e7aeddb789eb710983bb94ff7a`
- `web/app/routes/files-transfer.ts`: `7407dd4a8437e3774a7f7b2b00caf0b1f5bd0b107a581879e53040b6347b8957`
- `web/app/routes.ts`: `570506b66682bb13c581ceabc928821e75b33e013b371c7a1d01d53b97e702d1`
- `web/app/components/workspace.tsx`: `ec2af2446d60ea7ca6d62d9256ccfac67add40650454289447efa47b7e84a7ac`
- `web/tests/workbench-api.test.ts`: `c991fec01c7501c6e36d0f9875ed94fd960c94de44cd69addaa9a3c8c4202aa9`
- `web/tests/browser/workbench-fixture.ts`: `6700cfd479a04060f6e3828780f1230b2b7fbf7c74bf12275edb8f202f03fadb`
- `web/tests/browser/workbench.spec.ts`: `eefaaa1cb5e0645e9066e84433ef24fc366fc2368d482f15005a8237bbdba7ef`
- `web/tests/browser/serve.ts`: `883f7c1a5551f76b8a090ea92f7c15e23f3e05eb6dbcd6cc234ccc51c1ce9ebf`
- `web/data/db.ts`: `da0ee79db47c5274677ab180bf3dfc1ff8daaca0fd6b35604f0922e9fb8b570e`
- `web/data/permissions.ts`: `d7e3c5957b259121125465565d2c1c58ee27cd5b1987cccca670d1c8ddeed450`
- `web/server/data-migrate.ts`: `9685ae3765a80fb201b357abefb16edd5451466d4acdac6b6659e8e079e2a527`
- `web/tests/workspaces.test.ts`: `ec8287682a1bf2ea5aabc6a22184d9aa0e054b07183540a8260c27ef3dfd52d1`
