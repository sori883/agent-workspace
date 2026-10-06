# Python単位の確認

2026-10-06。対象はtask_cli.py、web_bridge.py、tests/test_web_bridge.pyを含む未コミット差分。担当と親が `python3 -m unittest discover -s ax-local/tests -p 'test_*.py' -q` を実行し、全85件が成功した（親の実行6.104秒）。

原子的受付、同キー並行、異payload競合、旧CLIとWebの排他、重複worker、受理直後の停止、開始後の強制終了、残存transportコマンドのlock継承、未開始の復旧、未知usage・deny/suspend失敗、成果物のサイズ/ハッシュ/symlinkを確認した。get完了/list開始の状態観測競合2件は修正前失敗、観測contextによる修正後成功。

独立した実装未参加担当と、HTTP担当の担当外レビューでPythonの必須修正指摘なし。局所試験ではfake transportと隔離した一時領域・子プロセスを使い、モデルAPIを呼んでいない。実AX統合の証拠は別のreal-ax.json。
