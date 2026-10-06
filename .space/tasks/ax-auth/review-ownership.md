# 所有者分離と API/BFF 境界の独立レビュー

2026-10-06、担当 `review-ownership`。基準 main `42364ce` から `codex/auth-foundation` の現在の未コミット差分を対象にした。確認した範囲では、実際の入力・操作経路で成立する P0–P2 の必須修正は見つからなかった。

今回の所有者分離・認証変更を書いていない担当による、同一モデルの部分的な独立レビュー。過去の HTTP 基盤の一部はこの担当が実装したが、今回の認証変更は別担当が実装している。自作の `ax-local/keycloak/` は独立レビュー対象から除外した。他担当の先行指摘や採否は参照していない。

## 範囲と根拠

契約は `docs/auth-foundation.md` と `implementation-plan.md`。`ax-local/task_cli.py`、`web_bridge.py`、`chat.py`、`web/api/`、`web/server/`、`web/app/lib/` を読み、必要な route 呼び出し元と所有者・認証テストも照合した。行番号はレビュー時点の作業ツリー。

| 確認した条件 | 根拠と判定 |
| --- | --- |
| 共通 API の信頼境界 | `web/api/app.ts:16` は Host、Origin、内部 Bearer を先に確認し、`/v1/status` 以外はアクセストークンから所有者を確定する。`web/server/auth.ts:14` は検証済み issuer＋subject を DB の有効な内部 ID に解決する。任意 owner ヘッダーや匿名代替経路を確認しなかった |
| JWT の発行元・署名・用途 | `web/server/oidc.ts:35` は RS256、issuer、audience、azp、typ=Bearer、exp/iat/sub などを検査する。OIDC の ID token と API access token を混同せず、交換後の issuer/subject も照合する。JWKS の origin は issuer と一致を要求する |
| 全 8 経路の owner 伝達 | `web/api/app.ts:99` 以降の run 5 操作と conversation 3 操作が、認証器の内部 ID を service の第一引数へ渡す。各 service が UUID を正規化し、`web_bridge.py:234` が厳密な `{owner_user_id,input}` envelope を要求する。旧 envelope や所有者欠落を受け付けない |
| 受付時の原子保存 | `task_cli.py:445` の prepare は owner を receipt に入れたあと、request・manifest・receipt を保存し、pending directory を公開する。単発と会話の accept の両方が owner を渡す |
| 所有者単位の再送 | `task_cli.py:523` は hash 一致前に owner を照合する。lock 前後とも同じ owner で検索する。`submission_key` は owner と送信 key を含み、`chat.py:178` は会話の所有者確認も再送前に行う。会話 replay は連鎖も再検査する |
| 他人・owner なしの非公開 | `web_bridge.py:156` は 50 件へ絞る前に owner を適用する。get/artifact は本文読取前に owner を確認し、recover は lock 前後で照合する。`chat.py:68` は本人の turn がなければ 404。新規送信でも、他人・owner なしの既存会話 ID を占有できない |
| mixed owner の拒否 | `chat.py:68` は同一会話の全 receipt を照合し、一部だけ本人なら 409 で拒否する。`web_bridge.py:224` は旧 run の一覧・詳細・成果物・復旧にも同じ会話照合を適用する。worker の開始前も `task_cli.py:571` で会話連鎖を検証する |
| CLI と全体 guard の維持 | `task_cli.py:512` の通常 CLI は owner なしで保持される。`guard:295` は owner を絞らず、旧データを含む未解決実行・未知使用量・失敗 fingerprint・費用上限を確認する。accept/実行/復旧は既存 global flock を使う |
| ログインと失効 | `auth-store.ts:47` の flow 消費は browser hash＋state hash＋期限を条件に一度だけ DELETE RETURNING。`auth.server.ts:44` で callback URL、state、PKCE、nonce の検証を通し、新セッションを作って旧セッションを失効させる。DB の active 状態と期限は session 読取時にも確認する |
| DB/IdP 失敗時の動作 | `auth.server.ts:19` は DB 読取失敗を 503 にし、セッションを返さない。API も DB 解決失敗時は service を呼ばない。`auth.server.ts:76` はローカル失効後に IdP logout へ進み、IdP の失敗で旧セッションを復活させない |
| 秘密とブラウザの境界 | Cookie は不透明 ID、DB はその hash と AES-256-GCM の token 暗号文。暗号文は session/flow ID に AAD で結び付く。route は token を API client にだけ渡し、loader/action の公開データへ含めない。callback のログも段階と制限されたコードのみで、例外本文を出さない |

## 見送った懸念と限界

ログアウト後の発行済み access token を API が即時に無効化しない点は、設計が明示した有効期間と役割の分離に一致する。通常のブラウザは token を保持せず、失効した BFF Cookie は DB 検査で拒否される。この点を今回の契約違反とは扱わない。

CLI と `_execute` / `_recover` は信頼されたローカル運用経路で、Web の認証回避用入口として公開されていない。同一 PC 上で任意ファイルを変更できる敵対プロセスの隔離は今回の要件に含まれない。receipt や ID 対応を管理者が別操作で書き換える競合を、通常の Web 入力から起きる脆弱性とは判定していない。

破損した receipt が一覧を拒否させる可能性はあるが、所有者情報が矛盾する保存状態を fail closed にする契約と整合する。他人の本文を読み出す経路は確認しなかった。

親から提供された実測材料は、旧 13 records 保持、Python 113 tests、Web 28 unit / 24 browser（fixture OIDC＋実 PostgreSQL）、実 Keycloak のパスワードと仮想認証器によるパスキー登録・ログイン成功。レビューでは対応するテストコードを読んだが、これらの試験は再実行していない。DB・サービス・ユーザーデータ・秘密ファイルに対する操作や読取は追加していない。静的確認と親の実測を区別する。

## 適用した知識

bundle は `/Users/const/sori883/agent-workspace/.space/babel`。引き継いだ `decisions/systems/ax/auth-foundation`、`principles/boundary-discipline`、`knowledge/ax-web-foundation`、`rules/ax-model-spending` と、既読の `decisions/systems/ax/single-task-cli`、`knowledge/ax-local-kind-environment` を再利用した。

不足分は OKF CLI の path search で `ax-local/task_cli.py`、`ax-local/chat.py`、`ax-local/web_bridge.py`、`web/server/`、`web/api/`、`web/app/lib/` を検索した。追加で `decisions/systems/ax/chat-turns` の本文を取得し、会話 receipt の正本、再送優先、連鎖検査、global guard 維持を照合した。認証の OKF は設計段階の記述なので、現在の実装契約・作業ツリーを対象に判定した。知識の編集は行っていない。

担当範囲のレビュー報告は完了。親の統合判定と他の独立レビューは代行しない。
