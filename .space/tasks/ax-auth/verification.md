# 認証基盤の統合検証

2026-10-06。対象は `codex/auth-foundation`、開始時のmainは `42364cedd66409ac8f3953ea3755c25dc38484fe`。ローカルのKeycloak 26.8.0、PostgreSQL 18.4、Node 24.15.0とChromiumで確認した。認証と本人の記録へのアクセスを接続し、公開配置・メール送信・自己登録・Entra/Cognito連携は含めない。

## 自動検証

| 対象 | 結果と範囲 |
| --- | --- |
| Python | 113件成功。原子的なowner保存、他人・ownerなしの拒否、本人で絞ってから50件、利用者ごとの再送キー、会話の混在拒否、既存CLI・費用・排他・復旧を含む |
| Keycloak初期化 | 4件成功。秘密情報の再生成を防ぎ、既存DBと設定の不整合では停止する |
| Node | 29件成功。実PostgreSQLでID対応・暗号化・認証フロー・セッション、JWTの署名と各claim、API/BFF/Python境界を確認 |
| ブラウザ | 24件成功。既存17件と認証7件。ログアウト修正後は認証7件を再実行し成功 |
| 型・ビルド | typecheckとbuild成功。独自のWeb起動経路もブラウザ試験と実サービスで使用 |
| 構文 | Keycloak管理・検証スクリプトのPythonコンパイルとstart.shのshell構文確認が成功 |

ブラウザの自動試験は通常のOIDC callbackとアプリDBを通す。署名・PKCE・nonceを扱う認証fixtureと、利用者別の実行fixtureを使い、製品コードに認証バイパスを追加していない。期限切れ・無効な利用者・認証フロー再利用・DB接続失敗・IdPのログアウト503も確認する。共有PostgreSQLそのものを停止する障害試験は実施していない。

途中の全Python試験で既存のruntime timeout試験が一度 `failed != timed_out` になった。runtime 27件の再確認と最終全113件は成功し、実装変更で隠していない。詳細は [Python担当報告](python-verification.md)、[Web試験報告](web-tests-verification.md)。

## 実Keycloakとパスキー

- Aliceのメールアドレス・パスワードでログインし、チャットとアカウント画面へ到達した。
- Chromiumの仮想CTAP2認証器（resident key、user verification有効）でパスキーを登録した。新しいブラウザコンテキストでパスワードを入力せずログインし、WebAuthn assertionを確認した。
- Keycloakのアカウント管理からパスキーを削除し、削除確認を経てパスワードで再ログインできた。試験用の仮想認証情報は残していない。
- アプリのログアウトでDBセッションを先に失効させ、Keycloakの確認画面を押す前でもコピー済みCookieが拒否された。Keycloakで確認後、再ログインできた。
- ログアウトURLにはclient IDと戻り先だけを含め、ID/access tokenを入れない。Webの通常アクセスログもcallbackのcodeを記録しない起動経路にした。

証拠は [パスキーとログアウト](evidence/passkey-and-logout.json)、[ログイン画面](evidence/login.png)、[アカウント画面](evidence/account.png)。実物のTouch ID・スマートフォン・セキュリティキーは未確認。仮想認証器による確認を実機の確認とは扱わない。

## 実AXでの所有権と既存データ

モデルを使わないoffline実行を各利用者で1件ずつ受け付けた。

| 利用者 | 実行 | 成果物 |
| --- | --- | --- |
| Alice | `ax-run-c787f426caee1db3` | `AUTH verification alice` |
| Bob | `ax-run-0aea715619a143ed` | `AUTH verification bob` |

2件は同じ送信キーでも別の実行になり、Aliceの同内容再送では元の実行を返した。BobからAliceの詳細・成果物・復旧は404、一覧も本人分だけになった。AliceからBobの記録も見えない。ownerなしの旧実行 `ax-run-c2f7488061946da9` はWebから404になる。各receiptは異なる内部利用者UUIDを持つ。

2件とも期待した出力、usage 0、resolved、通信遮断、Task停止を確認した。今回の有料モデル呼び出しは0件。既存のownerなし13受付・65ファイルは、作業前後のSHA256がすべて一致した。旧データの削除・ownerの自動割当はしていない。

証拠は [実環境の所有権確認](evidence/real-ownership.json)。全利用者と旧データを含む費用guard・未解決判定・同時実行1件は既存のまま維持し、Python試験でも確認した。

## 永続保存と復元

Keycloakの検証では、実OIDC・TLSの14条件、再作成後の2利用者のIDとパスワードログインを確認した。バックアップを隔離した一時DBへ復元し、101テーブル・0シーケンスの比較が一致した。詳細は [Keycloak担当報告](keycloak-verification.md)。

アプリDBはWeb/APIを止めてバックアップし、隔離した一時DBへ復元した。5テーブルの全行照合が一致し、新しい2件のreceiptのownerが復元したusers/identitiesへ対応することを確認した。暗号鍵とクライアント設定も同じ非公開バックアップに保持した。一時DBは削除し、通常のapp DBには書き戻していない。証拠は [アプリDB復元](evidence/app-restore.json)。

その後Web/APIを起動し直し、有効期限内の保存済みCookieで本人の成果物を取得できた。秘密鍵・DB・receiptを同じ対応で維持するとログイン状態を再利用できる。証拠は [再起動後の確認](evidence/web-restart.json)。

パスワード・トークン・ブラウザ保存状態・バックアップはGit対象外の `.state/auth/` にのみ保存する。一時的なブラウザ状態と仮想パスキーの書き出しは確認後に削除した。公開する証拠に秘密値を入れない。

## 影響範囲と独立レビュー

| 境界 | 変更と確認 |
| --- | --- |
| ブラウザ→BFF | 未ログインではloginへ移動。Host・Origin・CSRFを維持し、tokenをブラウザへ渡さない |
| BFF→共通API | 内部資格情報に加えJWTを要求し、有効な内部利用者へ対応付ける。障害時に匿名へ戻らない |
| 共通API→Python | 検証済みUUIDと入力を別フィールドで渡し、全8操作で所有権を確認 |
| 保存データ | 新しいownerを受付と原子的に保存。旧データは保持・非公開。別DBへの会話本文の二重登録はない |
| 費用と実行 | 新しい利用者も同じ全体guardを通す。CLIの旧経路・有限worker・再開始しない復旧を維持 |
| DB配置 | 接続先・TLS・秘密情報を外部設定化。今回のDocker配置をKubernetesや本番の前提にしない |

非作成者による [BFF/APIレビュー](review-bff.md) と [所有権レビュー](review-ownership.md) を実施した。ログアウトURLへID tokenを渡す指摘を採用し、client IDだけを使う方式へ修正、再レビューと実Keycloak操作まで確認した。Keycloak構成・CIの独立レビュー結果は [構成レビュー](review-config.md) に記録する。担当は同一モデル系統であり、モデル多様性は主張しない。

構成レビューでは、先にWeb試験を動かすと試験設定だけが通常の認証ディレクトリにでき、初回Keycloak初期化が秘密欠損として止まる問題を指摘された。試験設定とCIの保存先を `.state/auth-test/app.json` へ分離し、製品の秘密欠損時に停止する条件は維持した。新しいパスでNode 29件・認証ブラウザ7件が成功し、非作成者も修正を確認した。独立レビュー3件の未解消P0〜P2指摘は0件。

OKFの既存4文書をCLIで更新し、本文の読み返しとstrict/driftでエラー・警告0件を確認した。公開文書・コードの空白検査も成功した。OKFのYAMLマッピング行末の空白はCLI出力を維持する。

コード・ローカル検証とGitHub上の納品状態は分けて扱う。PR・CIの結果はタスク記録へ追記する。
