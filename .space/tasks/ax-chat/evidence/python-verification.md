# Python検証

2026-10-06、担当 /root/w1_design_b が ax-local/tests 全体を実行。既存85件＋新規test_chat.py 15件＝100件成功（7.073秒）。親は担当の報告、4ファイルの差分、契約との対応を照合した。

2往復の履歴、同key（JSON順/UUID大小差含む）、古い親と並行送信、atomic公開前後の強制終了、未開始復旧、cleanup未確定返答非公開、費用/unknownusage/失敗fingerprint guard、4096B境界、32turn最大応答、破損連鎖と成果物を確認。最大制御文字応答は実CLIプロセスで旧512KiBを超え新1MiB以内。AX/モデルは呼ばずfake transportを使った。

担当範囲: ax-local/chat.py, task_cli.py, web_bridge.py, tests/test_chat.py。git diff --check成功。実Webと実モデルの確認は親の統合検証へ分ける。
