# Python 所有者境界の実装・検証

対象は `codex/auth-foundation`、基準 `42364ce` に対する未コミット差分。2026-10-06。契約は `implementation-plan.md` と `docs/auth-foundation.md`。担当は Python のみで、TypeScript、公開文書、OKF、認証DB、Keycloak構成は変更していない。

## 実装

- `ax-local/web_bridge.py`: 通常8操作は厳密な `{owner_user_id, input}` を必須とする。ownerはUUIDとして検証し小文字へ正規化。missing/null/不正値は `invalid_owner_user_id` / 400、余分なフィールドや不正inputは `invalid_request` / 400。旧stdin形へのフォールバックはない。WebBridge自体もownerを必須にした。
- `ax-local/task_cli.py`: ownerを `prepare` の最初のreceipt保存に含め、request/manifestとともに一時ディレクトリから原子的に公開する。再送キーはownerとkeyを組み合わせて計算し、lock前・lock内の検索でもreceiptのownerを照合する。実行fingerprintは変更していない。
- `ax-local/chat.py`: 全receiptの会話IDと所有者メタデータを確認する。他人またはownerなしのIDは404、自分のturnを含む所有者混在は409。他人の会話IDを新規会話として占有できない。再送やlock取得より前に所有権を確認し、lock内でも再確認する。
- 実行一覧と会話一覧はownerの絞り込み後に50件へ制限。詳細・成果物・復旧もownerを照合する。保存済み履歴が旧run詳細から漏れないよう、run一覧/詳細/成果物/復旧でも会話の所有者混在を拒否する。復旧の認可では成果物本文を読まず、破損した成果物があっても同一ownerの停止・後始末へ進める。
- 管理CLIはownerなしの実行・inspect・recoverを維持する。有限workerはreceiptに記録済みのownerを使う。ownerなしの過去データはWebに公開せず、自動移行しない。単一実行flock、未解決run、未知usage、失敗した有料実行の確認、同じ失敗fingerprint、累積 `.01 USD` の各guardは全ownerと過去データを対象とする。

## 検証

追加した `ax-local/tests/test_ownership.py` の13件が通過。tempディレクトリ、FakeTransport / ChatTransport、コピーしたCLIの実プロセスを使用した。

| 確認 | 結果 |
| --- | --- |
| 全8操作のowner必須、UUID、旧入力拒否 | 通過。拒否時のworker起動・保存なし |
| submit/chat双方の原子保存 | rename前のreceiptにownerがあることを確認 |
| 同じownerのlock中replay、他ownerとの同一キー | 通過。意図的に同じkey hashにしたreceiptもownerで排除 |
| 他人のrun、artifact、recover | 404。lock競合中も他人のrecoverは404で起動なし |
| 他人・旧ownerなし会話ID、同じkeyの再利用 | 404。別ownerが既存IDを新規受付できない |
| mixed owner | 一覧・会話詳細・送信・旧run経路が409。workerもtransport呼出前に拒否 |
| 50件制限 | 他人の新しい51件があっても自分の古い1件が見える |
| legacy CLI、全体guard、復旧時owner保持 | 通過。ownerなしの未開始receiptを実プロセスで安全に終端化 |

既存 `test_web_bridge.py` / `test_chat.py` はowner付き呼出しへ更新し、原子公開前後のSIGKILL試験でもowner保存を確認する。既存の同時受付、二重worker、残存command lock、親競合、破損リンク、start再送禁止、32turn制御文字最大応答の試験を引き続き実行した。

全suiteのコマンドは `python3 -m unittest discover -s ax-local/tests -v`。最終差分で **113件 / 8.081秒 / OK**。出力は `/tmp/ax-auth-python-tests-final.log`。`git diff --check -- ax-local/task_cli.py ax-local/chat.py ax-local/web_bridge.py ax-local/tests` は通過した。

途中の全suite再実行で、変更外の `test_timeout_kills_descendants` に一度だけ `failed != timed_out` が発生した。直前の全113件は通過しており、その後の `test_runtime.py` 単独27件も通過。原因は未確定で、runnerやそのテストは変更していない。

## 引き渡し

実AX・実モデル・外部有料通信は実行していない。モデル用adapterの試験はfake応答。実ログイン後にAPIが渡す内部UUIDとPython envelopeの統合、DB/Keycloak停止時の認証拒否、2利用者のブラウザ経路は親の統合検証範囲。新たなOKF更新は親へ委ねる。

根拠となる主な箇所は `task_cli.py` の `validate_owner` / `prepare` / `find_submission` / `accept` / `execute_accepted`、`chat.py` の `authorize` / `accept`、`web_bridge.py` の `list` / `require_owner` / `dispatch`。追加したowner認可は会話メタデータの整合確認であり、既存の成果物検証や費用guardを置き換えていない。
