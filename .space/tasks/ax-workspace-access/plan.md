# ワークスペース基盤の実装計画

2026-10-06、利用者が「それで作って」と実装を依頼した。既存設計を採用し、作成・所属・招待・グループ・業務ロール・管理権限とチャット境界を実装する。ソースと検証を一つの変更単位にまとめ、設計単位のPRは作らない。

進行状態の正本は `.space/tasks/ax-workspace-access/orch/`。親が全体の受け入れと統合を担当する。既存の調査・独立候補・レビューは同じ基準版に適合するため再利用する。

## 今回の具体化

- 有効なユーザー全員が最大3個作成可能。作成者IDを固定し、所属数・招待先数と区別する。初期はworkspace削除・移譲機能を提供せず、作成枠は自動返却しない。
- 管理権限はadmin/member、業務ロールはgeneral/developer。初期値は作成者admin+general、招待参加member+general。各所属に業務ロール1つ。
- 名前変更、メンバーの役割変更・除名・脱退、グループ作成/名前変更/削除/所属変更を提供。最後の有効adminを失う通常変更を拒否。同一workspace内の名簿はメンバーに表示する。
- 招待は有効期限7日の宛先メール指定リンクを管理者が作成し、コピーして渡す。実メール送信は追加しない。受諾にはログインと検証済み宛先メールを必要とし、期限・取消・再送・招待元の現在adminを確認する。メール一致でUserを統合しない。
- OIDCから検証済みメールを保持する。自己登録・メール確認を公開環境で利用するための認証提供元/SMTP設定は別の運用設定。メール未確認では招待受諾を拒否し、対処を表示する。テストは検証済みメールの独立fixtureを使用する。
- 既存のworkspace未設定会話/実行は本人限定の旧履歴として保持し、閲覧と安全な回収のみ許す。新しい会話・実行は明示したworkspaceへ固定する。自動移行・自動共有はしない。
- 既存のサービス全体の費用guard・同時実行・再送防止・終了処理を維持。待機から実行開始時にも所属を再確認し、失効後の新規外部効果は拒否する。停止/回収/費用確定は継続する。

## 担当と依存

| 単位 | 所有範囲・結果 | 確認 |
| --- | --- | --- |
| U1 API/DB | web/data、web/api、web/sharedの組織契約、data migration、prepare-execution、対応単体/DB/APIテスト | 実PGで3個上限/競合、最後のadmin、跨社拒否、招待失効、owner維持、移行再実行、開始直前の失効 |
| U2 UI/BFF | web/app（auth.server/login以外）、browser testsとfixture | 作成・招待・切替・グループ・ロール・旧履歴をブラウザで確認。CSRF、JSなし、キーボード/狭幅も確認 |
| U3 認証・統合（親） | web/server/auth*・oidc、app/lib/auth.server、login、auth tests、運用文書、実環境・全体検証・OKF | verified email保持、ログイン後の遷移、既存データ保持、Node/workerd、全体回帰と実AX offline |
| U4 独立レビュー | 読み取り専用 | 権限/情報分離/失効/競合/移行を確認。指摘を修正してから引き渡す |

U1/U2は以下の契約で分担し、共有ファイルへ重複書込みしない。DB/実環境へのmigrationと全体テストは親が統合後に直列実施。各テストは既存専用DBの独立schemaを使う。API担当は契約ファイルを先に作成しUI担当へ連絡する。全体確認で修正したファイルは担当へ通知する。

## 共通契約

- 組織APIは `/v1/workspaces` とその配下。別途 `/v1/invitations/accept`。Zod契約は `web/shared/workspace-contracts.ts` に集約しU1が所有。
- `GET /v1/workspaces`: `{workspaces:[{id,name,access_level,business_role}],created_count,creation_limit}`。
- `POST /v1/workspaces`: `{key,name}` → `{workspace,replayed}`。
- `GET /v1/workspaces/:id`: `{workspace,members:[{user_id,display_name,access_level,business_role}],groups:[{id,name,member_user_ids}],invitations:[{id,email,expires_at,status}]}`。invitationsはadminだけへ返す。
- POST `/:id` `{name}`、POST `/:id/members/:userId` `{access_level,business_role}`、DELETE同path、POST `/:id/leave` `{}`。
- POST `/:id/groups` `{key,name}`、POST `/:id/groups/:groupId` `{name}`、DELETE同path、POST `/:id/groups/:groupId/members/:userId` `{member:boolean}`。
- POST `/:id/invitations` `{key,email}` → `{id,token,expires_at,replayed}`。tokenは初回だけ返し、同key再送はtoken:nullとして既存リンクを維持する。再発行は取消＋新しいkeyで明示的に行う。DELETE `/:id/invitations/:inviteId`、POST `/v1/invitations/accept` `{token}` → `{workspace,replayed}`。全POST/DELETEはBFF側でCSRFを確認。
- workspaceに属する既存run/chat APIは `X-AX-Workspace-ID: UUID` で操作対象を指定。headerなしのGETは旧本人限定のworkspace NULLのみ。headerなしの新規/継続submitは拒否。所属とownerの両方が必要。
- Webは `/workspaces` が所属選択/初回案内、`/workspaces/:id` が管理、`/join?token=...` が招待確認。既存チャット/実行URLは `?workspace=UUID` を付けて明示し、選択を全タブ共通のsessionだけへ依存させない。旧履歴は `?legacy=1` とし新規送信を出さない。
- U3がauth migration v2で `users.verified_email`（nullable）を追加し、ログイン時に検証済みemailだけ保存する。未検証/欠落ならNULLへ更新。U1の招待判定はこの列を使う。
- エラーのコード・レスポンス検証は共有契約を使い、トークン/メール/DB詳細をログへ漏らさない。

## 検証と引き渡し

局所テスト、型/build、既存回帰、実PGの境界検証、ブラウザ操作、Node/workerdの共通API、既存ローカルデータへの移行と実AX offlineまで確認する。有料モデルは送信しない。証拠は `verification.md` にまとめる。認証・権限と永続データを扱うため独立レビューは必須。実装・検証をまとめた1本のPRにし、既存のPR方針に従って通常変更は検証・レビュー後にマージまで進める。本番公開は含めない。
