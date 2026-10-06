# data-api担当の引き渡し

2026-10-06、`codex/portable-api-postgres`。担当w1_design_b、親が報告と成果物を照合。

- PGにrun・会話・submission・job・effect・成果物原bytes・旧原本を保存。受付/再送/会話head/global guardを一つのトランザクションで確定する。
- API entryとcontroller entryをSECURITY DEFINERかつ固定search_pathにし、PUBLICの実行権限を取り除く。migration/review/retirementは管理者の操作へ限定する。
- Python互換canonical hash、所有者・ownerなし、unknown paid usage、failed fingerprint、32turn/context、NUL返答、旧import、並行受付を専用実PG schemaで検証した。最終data13件、canonical1件、HTTP/BFF10件が通過。型チェック成功。
- 親の追加検証ではNodeと実workerdから同じ実PostgreSQLへの受付・同key replay・所有者拒否・再起動保持が通過。実ローカル移行では旧15件、隔離0、未解決0をDB側で照合した。
- Aによる読み取りレビューに追加の確定P0–P2なし。AはDB↔controllerの契約作成に参加したため、その契約についての独立性には限界がある。実DB役割は別の読み取りレビュー担当が予定allowlistとの一致を確認した。

担当は実AX・モデルを呼んでいない。実AX結合と受付再開は親の継続作業であり、本引き渡しの合格に含めない。
