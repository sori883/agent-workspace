# v7統合後の私有ファイル回帰

2026-10-07、親。registry用v7を共通migrationへ追加し、schema health版とAPI関数権限を7へ更新したため、受入済みfiles unitの移行入口を再確認した。v6 SQL本体・FileRepository・file共有型は変更していない。

専用DBでfiles 18件・file API 1件を含む58件のfile/definition/workspace/API試験が成功した（exec session94332）。ブラウザの私有ファイル2件も成功（session79771、同時実行したlibrary1件は別のselectラベル試験で失敗し後続修正）。89KiBの分割再送、全bytes再取得、本人境界、サイズ拒否、明示取消を再確認した。旧実装を稼働DBへ適用していない。

v7の最新変更は公開版summaryのname追加だけで、file保存・権限・移行入口には差分がない。file関連の合格結果をこの限定条件で再利用する。定義16件は最新v7で別途成功。
