# Python所有者境界の実装前照合

対象: `42364ce`、`codex/auth-foundation`。2026-10-06。`implementation-plan.md` と `docs/auth-foundation.md` を既存Pythonへ照合した。方針は実装可能。以下を実装契約へ補足すれば、構造の再設計は不要である。製品コード・既存データは変更していない。

## 補足する契約

- **受付の保存箇所は単発・チャットの両方。** 計画の「TaskCLI.acceptで最初の保存」だけではチャットを覆わない。現状 `ChatService.accept` は `TaskCLI.accept` を通らず `prepare` を直接呼ぶ。両経路から `prepare(..., owner_user_id=...)` へ渡し、receiptの最初の保存・rename前に含める。workerの更新でもownerを保持し、request/モデル入力へは入れない。根拠: `ax-local/chat.py:184`、`ax-local/task_cli.py:434`、`:536`。
- **公開入口の型と拒否を固定する。** 通常8操作のstdinは厳密な `{owner_user_id: UUID, input: object}`。owner欠落/null/不正は400 `invalid_owner_user_id`、外側の余分な項目や入力形式不正は400 `invalid_request` とする案。UUIDは小文字へ正規化し、旧形式へのfallbackを置かない。64 KiBは外側JSON全体の上限とする。WebBridgeの公開操作は必須ownerのスコープを持ち、run本文・artifactを読む前、recoverのresolved判定・worker起動前に照合する。他人/ownerなしは既存 `run_not_found` または `conversation_not_found` の404。根拠: `ax-local/web_bridge.py:155`、`:171`、`:189`、`:201`、`:213`。
- **再送キーの分離は読取条件にも適用する。** `find_submission` は現在全receiptからkeyを探し、owner確認前に再生/競合を返せる。新形式のkey hashは正規化ownerと送信keyから作り、lock前・lock内ともreceiptのowner一致を要求してからpayloadを照合する。旧ownerなしの同keyを返さない。既存の実行fingerprintへownerを混ぜず、有料失敗の全体guardを維持する。根拠: `ax-local/task_cli.py:508`、`:522`、`:284`、`ax-local/chat.py:158`。
- **一覧用のowner絞込みと会話IDの存在確認を分ける。** 他人のreceiptを除いてから会話を組み立てるだけだと、混在ownerの後半が消え、自分の正常な会話に見える。また他人/旧ownerなしの会話IDを「未使用」と判断して新規turnを作れる。全receiptの会話ID/ownerというメタデータでIDの占有とowner整合を確認する。外部所有の既存IDへのchatも404で拒否し、同じIDを再利用しない。自分のturnを含むmixed owner会話は409 `invalid_conversation_state` で拒否する。本文は許可されたownerだけを読む。表示件数50件はowner絞込み後。根拠: `ax-local/chat.py:35`、`:60`、`:134`、`:167`。
- **ローカルworkerの権限を公開スコープと区別する。** `_execute`/`_recover` と管理CLIは信頼されたローカル経路を維持する。workerは対象receiptのownerを基準に会話全体のowner一致を確認する。旧ownerなしreceiptの管理処理は明示的な内部経路に限定し、公開WebBridgeのowner省略で管理権限になる設計は避ける。復旧で所有者を変更しない。根拠: `ax-local/web_bridge.py:228`、`ax-local/task_cli.py:539`、`:552`、`:557`。
- **認可用検索をglobal guardへ流用しない。** `guard` と `locked` は引き続き全利用者・旧ownerなしを対象にする。別利用者の未解決/未知費用で止まる場合も、公開エラーにはrun IDやownerを含めず既存safe codeだけを返す。旧receiptの自動割当・書換えは行わない。根拠: `ax-local/task_cli.py:221`、`:284`、`ax-local/web_bridge.py:24`。

## 実装で必要な確認

2利用者＋ownerなしを使い、全8操作、同key再送、同key異body、件数上限前の絞込み、他人の会話IDへの新規受付、mixed owner、原子的公開前後の停止、ownerなし管理CLI、全体費用/未解決guardを確認する。モデル呼出は使わず、fakeTransportと一時ディレクトリで実施する。

参照したOKF: `decisions/systems/ax/auth-foundation`、`decisions/systems/ax/chat-turns`、`decisions/systems/ax/single-task-cli`、`knowledge/ax-web-foundation`、`rules/ax-model-spending`、`principles/boundary-discipline`。3対象ファイルの `code_refs` 検索を実施し、既読の実行・費用制約を引き継いだ。今回の成果判定は契約の実装可能性のみ。実装・認証・隔離の実行検証は未実施。
