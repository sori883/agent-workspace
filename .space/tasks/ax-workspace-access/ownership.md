# ワークスペースの所有と50個の上限

## 目的と受け入れ条件

2026-10-07の追加依頼。累計作成数による制限をやめ、現在所有する数に50個の上限を置く。招待参加と個人チャットの閲覧境界は維持する。

- O1: 50個までは所有でき、51個目の作成・譲渡承諾は競合時も拒否される。成功済み再送は追加消費しない。
- O2: 所有者は一人。相手の承諾で譲渡し、旧所有者の枠が空き、新所有者の枠を使う。本人以外は承諾できない。
- O3: 所有者の退出・削除・管理権限の降格を拒否する。譲渡前の依頼取消、受取拒否、期限切れを扱う。
- O4: 所有者が変わっても会話・実行・成果物の所有者、グループ、業務ロールは書き換えない。
- O5: v1/v2を保持した追加移行とし、既存データを保持する。画面の所有数・権限・譲渡の説明を実挙動と一致させる。

## 事前確認

実ローカルはWorkspace 1件。作成者はactive admin。実行17、会話2、成果物16、適用済みschema v1/v2。作成者を所有者にできない既存行について、勝手な再参加や管理権限付与をせず移行を止める。コード調査はOKFのwebパス適用文書とworkspace-access決定を参照した。

## 担当と工程

設計候補A/Bは既存担当が互いの候補を読まずに探索する。比較と統合は親、独立確認はレビュー担当。API/DBとUIは契約を固定してから分担し、同じファイルを同時編集しない。実app DBへの移行、稼働プロセス管理、README・OKF・Git操作は親が担当する。試験は専用DB/スキーマへ隔離し、追加モデル呼出しは行わない。

局所試験、ブラウザの譲渡操作・狭幅・JavaScriptなし、型検査・ビルド、既存のprivate境界と再送を検証する。実ローカルはバックアップ後に移行し、旧データの不変とログインした画面の所有数を確認する。設計と最終差分の独立レビューを行う。

## 独立候補と比較

候補A（API担当）はWorkspaceのowner_user_idを現在所有の正本にする。作成者は不変履歴として保持し、所有者がadmin所属を持つことを保証する。候補B（UI担当）はmembership.access_levelをowner/admin/memberへ増やし、部分一意制約と遅延検査で一人の所有者を保証する。両案とも譲渡申請と相手の承諾で所有枠を移す。

親の評価ではAは所有数を直接取得でき、既存のadmin認可を変えずに済む。Bは所属そのものが所有権を表すが、招待・権限変更・画面・SQL内の全admin判定を変える必要があり、変更範囲が増える。候補作成に参加していない担当もAを推奨したため、Aを採用する。Bの所有者表示と承諾操作の案も同じ利用要件に沿うものとして取り込む。独立レビューの必須条件は、ownerの非NULL・所属・admin維持、quota→workspaceの排他順、消費済み再送から再譲渡しないこと、不適合行の移行rollback。いずれも実装・検証条件へ反映する。

## 採用契約

- Workspace応答にowner_user_idを追加。access_levelはadmin/memberを維持する。
- 一覧はowned_countとownership_limit（50）へ変更。旧created_count/creation_limitは同時移行する内部呼出し元と一緒に置換する。
- 詳細にownership_transfer（nullまたは有効なpending申請）を追加。所有者と受取人だけに返す。申請にはid/from_user_id/to_user_id/expires_at/statusを持つ。
- POST `/v1/workspaces/:id/ownership-transfers` は `{key,to_user_id}` を受け、`{transfer,replayed}` を返す。
- POST `/v1/workspaces/:id/ownership-transfers/:transferId/:action` のactionはaccept/reject/cancel、本文は空のobject、応答は `{ok:true}`。同じ申請に対する同じ確定操作は再送可能だが、逆操作・旧申請からの再譲渡は拒否する。
- WorkspaceServiceとBFF clientは `proposeOwnership(owner,id,input)` / `respondOwnership(owner,id,transferId,action)`（BFFではownerを受け取らない）。入力の型はsharedへ集約。
- 有効なpendingはWorkspaceごとに1件、期限7日。受取人の除籍・退出で申請を無効にし、再加入しても復活させない。受取人は現在activeかつ所属中で、自分自身は指定できない。
- 承諾時のみ所有枠を移動し、新所有者をadminにする。申請元が現在もactive adminであることも再確認し、停止済みの利用者による過去の申請から新たな譲渡を成立させない。確定済み承諾の再送は副作用なしで成功する。業務ロール、グループ、個人記録は保持する。旧所有者はadminで残り、後から退出できる。
- 作成・承諾は同じ所有枠の排他を使う。既存のWorkspace→Userロックと逆順にUser行を取得しない。取消・承諾・除籍はWorkspace行で順序を決める。
- v3移行を追加する。v1/v2は変更しない。既存creatorがactive adminでない場合は明示エラーで移行全体をrollbackする。移行失敗時は旧版が利用可能、成功後はバックアップを保全して前進修正を優先する。

## 実装の分担

API担当はschema-v3、migration runner、workspace contracts/service/repository/API route、DB権限、Node試験を所有する。UI担当はweb/appとbrowser/organizations.spec.tsを所有する。親は文書・OKF、実環境、全体検証と納品を所有する。API担当がshared契約を先に確定して通知し、UIはその契約に接続する。親が台帳を代理更新し、他担当は結果と証拠を返す。

## 確認記録

実app DBの受付を閉じ、未解決・invalidが0件であることを確認してWeb/APIを停止した。移行前バックアップを `ax-local/.state/ownership-check/before-v3.dump`（161124 bytes、private）へ保存し、pg_restoreの目録で実行・組織データが読めることを確認した。既存7テーブルの件数と内容hashを同ディレクトリのbefore.jsonへ保存した。

指定UI差分の先行独立レビューはP0–P2なし。CSRF、承諾確認、ID・action検証、応答不明時の同じ申請キー保持、所有と管理の区別を確認した。DB強制力とブラウザ結果は最終レビューで照合する。

### 自動検証と独立レビュー

[API/DBの証拠](ownership-api-verification.md)に50件目の競合、譲渡の消費・取消・再送、owner保護、private保持、v3不適合時の全rollbackを記録した。[UIの証拠](ownership-ui-verification.md)は全34ブラウザ試験の成功、型・build、JSあり/なしの往復、320px、axe違反0、画像目視を含む。

独立レビュー中、遅延制約トリガーのCOMMIT時権限不足が疑われたが、PostgreSQL 18がキュー登録時のroleを復元する実装と、限定ax_api roleでcreate/acceptをCOMMITまで実行した成功結果により、不成立として撤回した。製品SQLは変更せず、限定roleの回帰試験とCIの試験role準備を追加した。管理用poolの成功と限定roleの成功を区別して記録する。READMEの更新元表記は「v1以前」に訂正した。

### 実ローカルの移行と操作

v3移行と限定runtime関数のgrantが成功。適用版は1/2/3で、旧org_detail_v2/org_mutate_v2をax_apiから実行できないことを照合した。移行前後のax_runs 17件、ax_conversations 2件、ax_artifacts 16件、Workspace 1件、membership 2件、Group 2件、Group参加2件について内容hashが一致した（Workspaceは追加owner列を除く）。

Web/APIを再起動し、実KeycloakでAlice/Bobがログイン。既存Workspace `0ede69e2-b84b-4aa3-bcd4-8ab03af48781` をAlice→Bob→Aliceと画面から譲渡し、所有数1/0→0/1→1/0と承諾を確認した。BobがWorkspace所有者の時もAliceの既存run `ax-run-baee42066af1fd26` は404で、Aliceだけが元の成果物本文を読めた。確認後にBobを元のmember/developerへ戻し、上記7テーブルのhashが再度一致した。新たな譲渡記録・監査だけを残し、実行やモデルを追加していない。

実画面の390pxで横溢れがなく、private画像を目視した。実操作スクリプト・before/after・結果・画像は `ax-local/.state/ownership-check/`。認証Cookieの一時ファイルは確認後に削除し、秘密情報やbackupをGitへ含めない。最終的に受付を開き、`http://127.0.0.1:3100/workspaces` を再表示可能にした。

本番配置・メール配送・自己登録・物理パスキーの検証は今回の対象外。確認したのはローカルの実Keycloakとアプリ、専用DBによるNode/workerd・ブラウザ試験である。

### 最終判定

型検査・build・Node 72件・ブラウザ34件が成功し、独立レビューはP0–P2なしで引き渡し可能と判定した。レビューは作成担当と別の同一モデル担当によるもので、独自の再試験はしていない。親が実移行・実操作・データ比較と担当証拠を照合して受け入れる。OKFのworkspace-access、ax-web-foundation、ax-agent-platform-directionを更新してCLIで読み返し、strict/drift検証はerrors/warnings/gate findings/broken linksが全て0。

ソース、移行、画面、文書、試験を一つのPRへまとめる。公開・CI・マージの状態はGitHubを正本とし、ローカル成果の受け入れ状態はownership-orchを参照する。

### PRの自動チェック設定の訂正

PR #17の初回commit `58b5d00` は、追加した `POSTGRES_CONTAINER` がjob-level envでjob contextを参照したため、workflowの検証で失敗しジョブは起動しなかった。GitHub公式の[context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)と照合し、当該変数をjob contextが利用可能な `npm test` のstep-level envへ移した。既存のDB準備stepも同じ位置で参照している。限定runtime roleの試験だけがこの変数を使用し、製品コードと既に成功したローカル試験対象は変更していない。先行レビューではこの設定上の問題を見落としていたため、修正差分を独立レビューへ再提出した。修正後のリモート実行結果はPRのChecksを正本とする。

独立レビュー担当は修正後の両stepのenvを公式資料と照合して追加指摘なし、`git diff --check`成功と報告した。親も同じ差分と資料を照合した。これは設定差分の確認であり、リモートCIの成功を代わりに主張するものではない。
