# 固定SDK・Python実装の確認

2026-10-07。実装担当は w1_design_a、独立した読取り確認は親。対象は `ax-local/task_runtime` のinteractive追加と `ax-local/tests/test_interactive.py`。Go/PG/AXの統合合格を示す記録ではない。

担当の検証：host全135件は130成功、SDK依存5件skip。固定SDK imageを外部通信なしで動かした新21件はすべて成功。質問→回答は別SDK subprocess、各1モデル要求・1固定操作、通常終了、reply.txt一致。JSON重複・不正/再質問・model/tool拒否・usage欠落・functionCall拒否・ACK再投入を含む。既存timeout試験が初回のみ失敗、その後は成功して再現条件は未特定。

親はproposal/context検証、root/run/sequence/hash照合、ファイル固定とno-follow、排他的な書込み、同一応答だけの再投入、1区間1モデル要求、固定skill digest、loopback宛先、SDKのtools無し/deny_all、tool許可前の成果物書込み禁止、残時間、失敗時usage不明を含む実装を確認した。現時点で追加の必須指摘なし。

SDKそのもののusage復元を正本にせず、PGのGateway台帳と照合する必要がある。初期化前失敗でPython receiptが無い場合も、PGが実停止と未確定operationの有無から判断する。これは保存側の受け入れ条件で、Pythonだけの成功として扱わない。

有料要求、実AX操作、共有DB変更は担当の局所試験では行っていない。
