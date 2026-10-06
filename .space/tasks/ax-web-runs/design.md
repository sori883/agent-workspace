# 非同期実行の設計

基準6ac723a。独立担当A/Bの候補と、候補を作成していない担当の比較を2026-10-06に照合し、Bを採用した。設計の採用時点では実装・実AX検証は未実施。

## 候補と比較

Aは新Python bridgeの別受付ファイルでkey・run_id・workerの開始権を保持し、既存TaskCLI.run(request)をほぼそのまま再利用する案。CLIの改変は少ないが、受付ロック、workerロック、CLIの実行記録を整合させる必要がある。受付からCLIのguardまでの間は直接CLIが受付を認識できず、追加の協調が必要になる。

Bは既存receiptへ任意のsubmissionメタデータとaccepted phaseを追加し、既存runをprepareとexecuteへ分ける案。request・manifest・receiptを一時ディレクトリで完成させてから、親ディレクトリのfsyncを含むrenameで公開する。受付済みは未解決runとなり、CLIとWebの両方を既存guardで止められる。既存CLIの回帰確認が増えるが、受付・開始・費用・結果の正本を一つにできる。

評価は、単一の正本、二重実行防止、応答消失/強制終了/旧CLIとの競合、互換性、実装の複雑さ、利用者への不明状態の伝達で行った。親と独立比較担当はいずれもBを推奨。Aの独立受付台帳は採用しない。両案の有限workerと、同キーの再送でworkerを起動し直さない方針を引き継ぐ。

## 採用する境界

具体的な入出力は [contracts.md](contracts.md)。Pythonが受付・台帳・実行を所有し、HonoがローカルHTTP境界、React Routerが署名セッション付きBFFと画面を所有する。新しいPythonの待受portは追加しない。

1. submitはkeyの既存受付をlock前とlock内で照合する。同じ内容は同じID、異なる内容は競合。新規のみguardを通し、phase accepted・resolved falseで保存する。
2. 受付後に有限workerを独立sessionで起動する。workerはglobal lock取得後にacceptedかつ未解決を再確認し、外部操作より前にphaseを保存する。旧worker・同じkeyの再送・API起動時の自動dispatchは実行しない。
3. 既存CLIはprepare/executeを同じlock内で呼び、従来の同期動作、費用guard、start前永続記録、usage不明停止、cleanupを保つ。
4. APIやWebを閉じても受理済みworkerは継続する。画面にも説明する。HTTP切断と実行取消しを同一視しない。
5. recoverは開始・resumeを行わない。acceptedをlock内で再確認できた場合のみ、開始前終了へ終端遷移する。通信遮断やTask停止を実施済みと偽らない。外部操作を試みたrunは既存のdeny/collect/suspendへ渡す。
6. TaskCLIのglobal lock FDをTransportの子コマンドへ継承し、親のSIGKILL後にコマンドだけ残っても同時操作を許さない。2026-10-06、実際のwith-env.sh→mise→Pythonでpass_fdsが維持されることを、os.fstatで確認した。これはremote操作完了の保証ではない。強制終了後は開始合図を再送せず復旧する。
7. 旧receiptのsubmissionなしを許容し、既存runを移行・削除しない。成果物はサイズ・SHA256・UTF-8を照合して提供する。全体成功はresultだけでなくcleanup/usageを含むreceipt判定に従う。

## 実装と確認の分担

進行状態は [orch台帳](orch/) が正本。親はUI、統合、実AX確認、記録、PRを担当する。Python担当はax-localのCLI/bridge/局所テスト、HTTP担当はWebの公開schema/API/BFF接続/境界テストを所有する。共通契約成立後は別ファイルで進める。共有の実AXと有料呼出は親のみ。別担当の変更を戻さない。

最初にPython単位の冪等性・原子的公開・旧CLI回帰を確認して受け入れ、HTTPとUIをつないで確認する。最終的に独立レビュー、実ブラウザ、実AX offline、CIを通す。モデル利用は既定off、明示選択で既存antigravityへ接続し、既存上限と失敗後の制約を保つ。
