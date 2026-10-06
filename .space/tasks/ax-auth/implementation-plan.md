# 認証基盤の実装契約

基準は main `42364ce`、作業は `codex/auth-foundation`。2026-10-06に利用者が実装を指示した。既存の比較済み設計 `docs/auth-foundation.md` を再利用する。構造を変えず詳細を固定するため候補探索を繰り返さない。進行と受け入れの正本は `implementation-orch/` のCLI台帳。

## 境界

- Keycloakの初期realmは `ax`、confidential OIDC clientは `ax-web`、API audienceは `ax-api`。認可コード＋S256 PKCE、state、nonce、完全一致redirect URIを使う。ブラウザへトークンを出さない。
- BFFはPostgreSQLのapp DBにusers、identities、sessions、login_flowsを保存する。内部IDはUUID、外部IDはissuer＋subject。メール一致で統合しない。CookieにはランダムなセッションIDのみ、DBにはIDのSHA-256。トークンは永続ローカル鍵によるAES-256-GCM暗号化。ログイン処理は5分・一度限り・ブラウザCookieに結び付ける。
- 初期セッションは絶対30分以内かつアクセストークンの有効期限以内。自動refreshは加えず、期限後に再ログインする。Keycloakも30分のaccess tokenを発行する。セッション失効とDB停止は必ず拒否する。ログアウトはDB失効とCookie削除を先に行い、その後IdPのログアウトへ進む。
- APIは既存の内部Bearerに加え `X-AX-Access-Token` を検証する。issuer、署名、RS256、audience=ax-api、azp=ax-web、typ=Bearer、期限、subjectを検証し、有効なidentities/users対応をDBから引く。任意のownerヘッダーを使わない。`/v1/status` だけは起動確認用の内部Bearerのみ。認証器は依存注入可能だが、実運用の匿名・検証無効モードは設けない。
- RunService / ChatServiceの全操作は最初の引数に `ownerUserId: string` を必須とする。APIだけが検証済みIDを渡す。Python bridgeの通常stdinは `{owner_user_id: UUID, input: <従来の入力>}`。dispatchが厳密に検証し、WebBridgeの操作はowner付きスコープを必要とする。`_execute` / `_recover` は受付済みreceiptを処理する信頼されたローカルworkerのまま。
- 新規receiptのownerはTaskCLI.acceptとChatService.acceptの両方からprepareへ渡し、最初の原子的保存に含める。所有者ごとに再送キーを分離し、lock前の再送読取もownerを照合する。実行fingerprintと費用guardは全体のまま維持する。一覧は件数制限前にownerを絞る。run、artifact、recover、conversation、chatの他人・ownerなしは404。全receiptの会話ID/ownerメタデータで占有と整合を確認し、他人の会話IDへの新規受付も404、自分のturnを含むmixed ownerは409で拒否する。費用guardと単一実行lockは全利用者・旧receiptを含む。
- CLIからのownerなし実行は引き続き管理者用として許可し、Webへ公開しない。既存ファイルの自動移行・既存DBの置換は行わない。

## 担当と順序

親は契約、TypeScript BFF/API、UI、統合確認、公開文書とOKF、PRを所有する。最初の子はPython境界契約を読み取りで点検し、親が報告を照合・受け入れてから実装分担を広げる。その後、Python側とKeycloakローカル構成を独立に分担する。同じファイルを並行編集しない。

1. Python所有者境界契約の照合。
2. Python receipt所有者分離と局所テスト、Keycloak Docker・初期設定と永続保存、BFF/API・UIを接続。
3. PostgreSQLを使う認証試験、2利用者の隔離、コールバック不正・再利用、JWT不正、失効・停止、ownerなし保存と全体guardを確認。
4. 実Keycloakのメール/パスワード、仮想認証器によるパスキー登録/ログイン/削除とパスワード復旧、再起動・バックアップ復元を確認。実機の生体認証は自動試験と区別する。
5. 独立した認証レビューと既存機能レビュー、必要な修正・CI、資料更新・PRマージ。

モデルを呼ぶ有料実行は行わない。UIの会話試験はfixture、実基盤の新規受付試験はofflineのみ。自己登録、メール送信、本番公開ドメイン、Entra/Cognito接続は対象外。DBの配置先は環境設定で渡し、Kubernetes内を前提にしない。
