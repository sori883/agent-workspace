# 保存証拠の最終統合レビュー

2026-10-08 / 担当C / 保存証拠の読み取りと本報告の新規作成のみ。

## 判定と範囲

第4回実モデル試験のCSV集計成功は、UI、PG台帳、正式Actor inspectの保存証拠で整合している。追加の必須実装修正は見つからなかった。今回確認できた範囲は、登録・公開版固定、本人用ファイル、Runtime→Python→Runtimeの逐次実行、実モデルによる小さいCSV集計、固定提案によるExcel・8MiB搬送・隔離境界である。定期実行は未実装で、版・入力を固定するか最新に追従するかの利用者回答待ちを維持する。依頼全体の完了判定を代行しない。

実測者は親。Cは保存済みファイルを照合した別担当であり、ブラウザ、DB、AX、モデル送信を再実行していない。CはPG v8と実行統合契約の作者でもあるため、全体設計から独立したレビューではない。同じモデルによる分担レビューであり、異なるモデル・人間による監査ではない。

## 第4回実モデル試験

根拠は [paid-trial4.json](evidence/paid-trial4.json)。同ファイルに列挙されたUI結果、server.json、runtime-inspect.jsonl、python-inspect.jsonlの4原本SHA-256を照合し、抜粋内容も原本と一致した。

- root `bee233e5-d345-4bd2-91c4-5b863afcbd8a`。Runtime image `9eb481dc…`、code image `8485abc6…`、code profile `host-quota-8m-v1`。
- runは `ax-run-2eed047d79c9d71d` → `ax-run-662ae88128434a51` → `ax-run-b49254dc76b24db2` のRuntime/Python/Runtime。順序・前区間ID・rootの束縛が一致し、3件ともresolved、finished、job done、結果succeeded。モデル2、tool2、Python1、active 72,281ms。
- UIはstart 1回、answer/stop/recover 0回。15bytesの合成CSVを読み、14bytesの結果CSVから合計300を確認し、reload後も同rootを確認している。記録された結果SHAは `b31792907d72d269a67776498cac94ddcd5f3fd825258518bf705dad94829fd4` で、`total\r\n300.0\r\n` の14bytesと一致する。Cがファイルを再ダウンロードした証拠ではなく、実測時のメモリ内bytes検査・CSV解析と保存された結果記録の照合である。
- Bobの同じWorkspaceへの所属確認が先行し、rootと入力・出力ファイルへの本人境界で拒否されている。入力・出力のget/readはいずれも404。Workspace未所属による拒否を本人境界の証明に代用していない。
- 4 operationはすべてsettled、既知の費用が保存されている。generation_startedはモデル2件だけ。21 effectはすべてconfirmed。global slotは空、holdなし、公開スコープの未解決run/invalidは0。
- 正式inspectの3件はActor停止、AX Suspended、egress deny、worker未割当を示す。code cleanupのactor、actor UID、worker UID、generation、image、profile、cleanedの7項目はPG保存値と完全一致する。単にSuspendedをhost cleanup済みと読み替えていない。

UI結果内のserver countersやcleanup検証は未観測のまま記録されている。この値を成功へ書き換えず、別採取したPG/inspect証拠で補っている点も適切である。

## 費用と過去の失敗

生成1は入力1,393・出力249・思考0でUSD 0.00072175、生成2は入力1,634・出力43・思考0でUSD 0.000473。保存単価による再計算、operation合計、run合計、root合計はUSD **0.00119475**で一致する。各呼出しの入力6,000・出力512の範囲内である。settled operationに残る予約額の履歴を未精算残高として二重加算せず、rootと全体の予約込み合計が既知費用と一致することを確認した。

[第1回](evidence/paid-trial1.json)、[第2回](evidence/paid-trial2.json)、[第3回](evidence/paid-trial3.json)の不達結果は残っている。第3回はプロトコル上succeededでも集計未達として区別されている。4 root・生成5回の費用はUSD **0.002571**、従来分USD 0.004226を含む累計はUSD **0.006797**。途中で累計をリセットした値ではない。自動再試行の証拠はなく、今回以降の有料試験を追加しないという親の終了条件を引き継ぐ。

スキーマのkey順修正後に成功したことは確認できるが、key順だけが以前の不達の唯一原因だったとは証明しない。公開単価とusageによる概算であり、Googleの全請求項目を独立監査した値ではない。

## 既存証拠との接続

| 範囲 | 照合結果 | 限界 |
| --- | --- | --- |
| 登録・共有権限・私有定義 | [public-v8-regression.json](evidence/public-v8-regression.json)の12原本SHAと全抜粋が一致。member登録、creator/admin編集、同Workspace別利用者への私有定義非表示、公開agent/skill版固定・再読込が記録されている | 登録済みagentの継続は無料previewでの確認 |
| 旧経路 | 同資料のofflineとv1 preview、保存結果・停止inspectが一致 | 旧経路の確認は記録されたfa9版。後続のRuntime/Gateway限定差分は既存局所レビューを再利用 |
| CSV/XLSX・1ファイル8MiB・4非整列ファイル合計8MiB・隔離境界 | [actual-ax-fixtures.json](evidence/actual-ax-fixtures.json)の4試験、各5原本SHAが一致。checksの相違は順序を保った重複除去のみ。各3runの停止inspectとPG code cleanupが一致 | モデル判断は固定提案、外部モデル送信なし。Excelを実モデルで集計した証拠ではない |
| Excelとrootfs | CSV/XLSX試験の別セル確認、実Actor rootfs 0700・UID/GID 0の観測と既存dirfdレビューが対応 | 一般的な全Excel形式、任意ファイルへの網羅的保証ではない |
| 隔離・異常系 | 既存direct runsc・局所回帰と実Actor固定boundaryの証拠を再利用 | 実Actorで全資源枯渇・symlink・host障害を注入したわけではない。capability=0/NNP=1はtrusted bootstrap検査を含む。無監督の定期実行の安全性へ拡張しない |

8MiB試験では生bytesを保存していないため、Cが再取得・再hashしたとは扱わない。実測checkerのbytes/hash照合結果とその原本を確認した。固定probeの別owner検査は未存在UUIDであり、今回の実ログイン済みBobによる同Workspace検査と区別した。

## 試験後の状態と残件

paid-trial4の親確認欄に加え、親が18:22:58 UTCに採取した `ax-local/.state/workbench-build-arg973la/public-v8/final-closure.json` を照合した。controller generation/observed generationは38で一致しready、execution imageは `81ad9e83…`。モデル鍵mountは一覧にもなく、Gateway/workbench modelは無効、Secret不存在。PGはtrial閉・無料受付有効・未解決/invalid 0、既知費用と予約込み費用はともにUSD 0.006797で、試験結果と一致する。これは保存readbackの確認であり、Cによるlive状態照会ではない。

verification.md末尾の「実モデルによる最終確認」とtask.mdの現在地も、成功した範囲・費用・定期実行の回答待ちと一致する。以前の失敗や修正中の段落は時系列として残し、最終節で更新したことを確認した。

定期実行の版・入力方針は未決で、実装・自動有効化とも未実施。実モデルの一般的な集計品質、長い依頼、実モデルによるExcel全経路は未確認として残す。今回の成功を理由にこれらの受入条件を合格へ変更しない。

最終証拠snapshot（本レビュー時点）:

- paid-trial4.json: `483ee0d723277fcca5caac57b1fbe3ca66e7e9e9e808c880854a43482e9206aa`
- actual-ax-fixtures.json: `79bd3d236c1c70b6ba32f04aefc2fd4033ed1f10cab2dcf2766379fc15528acb`
- public-v8-regression.json: `635251b4600c4e5e1397c70b6165ec48dc2657a811a4f7b35b0d20ba87c6b81e`
- final-closure.json: `8f7528c441f08cdfc4c53a54db25e2324b2a20d9a1154ae22114c7d94e20c808`

保存は本報告のみ。既存の受理済みレビュー、製品、原private証拠、OKFは変更していない。全体の記録更新と引き渡し判断は親へ返す。
