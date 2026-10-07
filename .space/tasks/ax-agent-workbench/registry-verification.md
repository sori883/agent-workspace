# スキル・エージェント保存層の検証

2026-10-07、担当B。基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6`、`codex/agent-workbench` の未コミット差分。[registry-contract.md](registry-contract.md) と親が採用した公開型を基準に、保存層の実装・専用DB検証までを完了した。

## 成果物

所有・変更ファイルは `web/data/schema-v7.sql`、`web/data/definitions.ts`、`web/shared/definition-contracts.ts`、`web/tests/definitions.test.ts`、この記録。既存の `AgentRepository` は変更していない。共通migration入口・権限一覧・API/BFF/UIの統合は親担当。

最終v7 SHA-256は `0ede130ab671a38b561491b1dd4840c69429638526cb38864b6a85ee93dd4d34`。v1〜v5 SQLに差分はなく、受入済みv6のhashも `cd2380231128fc573373213e33b3a8e5fb954877a1313553ee932c18b8c2f186` のまま。

`DefinitionRepository` の操作は `list/get/create/updateDraft/publish/archive/getVersion`。公開DB関数は `ax_definition_list/get/create/update/publish/archive/version` の7件。SECURITY DEFINERと固定search_pathを持ち、PUBLICには実行権を与えない。内部helper、table、execution roleからの利用は公開していない。

本人用も共有用もWorkspaceを固定する。本人用は作者だけ、共有下書きは作者と現在adminだけが読める。一般memberへは共有公開版だけを返し、下書きの名前やrevisionも返さない。共有作者が退出しても公開版は残り、現在adminが管理できる。すべての操作と再送に現在所属とactive userを要求する。

保存・公開・アーカイブはexpected_revisionを検査し、成功ごとにrevisionを進める。ownerごとのmutation keyとcanonical要求hashで同一再送を処理する。公開後の本文は不変で、応答喪失後の公開再送も元のversion IDを返す。公開版のhashは空白なしcanonical JSONのUTF-8 bytesから計算する。`latest_version.name` は公開版本文から返し、下書きだけを改名しても公開版の名前は変わらない。

`getVersion` の既定は履歴参照。現在の私有・Workspace権限内で、アーカイブ済みの過去版本文も取得できる。`forUse:true` は新規利用のため、baseと依存skillのアーカイブを拒否する。共有agentの依存は同Workspaceの共有skill公開版に限定し、本人用agentは本人のskillまたは共有skillを使える。依存を下書き保存・公開・新規利用の各時点で検査する。実行への接続は後続unit。

補助fileは安全な `references/`・`scripts/`・`assets/` 相対pathとUTF-8 textだけを受け付ける。NULと孤立surrogateは拒否する。`renderSkillMarkdown` はname/description/instructionsから固定形式のSKILL.mdを生成する。scriptの登録は実行を伴わず、私有作業fileへの専用参照や暗黙コピーも追加していない。

作成100件/作者/Workspace、公開100版/base、canonical本文の総量128 MiB/appをDBで守る。archiveも容量・件数に残す。容量は現在draftと全公開版を合算し、draft置換・公開追加と同じtransaction内で共通advisory lockを取得する。mutation応答の保存にはsummaryとversion IDを使い、本文を重複保存しない。

## 検証結果

試験は `app_auth_test` 内の一意な `definitions_test_*` / `definitions_v6_*` schemaを使い、終了時に削除した。v7は専用schemaへ直接適用した。稼働DBや既存共有schemaを変更していない。

| 確認 | 結果 |
| --- | --- |
| `npx tsx --test tests/definitions.test.ts`（web/） | 16/16成功。最終ログ `/tmp/ax-registry-final.log` |
| `npm run typecheck`、最終 `npx tsc --noEmit`（web/） | 成功 |
| 所有4ソースの末尾空白検査 | 0件 |
| 既存SQLの差分/hash照合 | v1〜v6不変 |

16件は次を確認する。

- 本人用の下書き→公開→下書き更新→旧版取得。固定SKILL.mdとcanonical hashの一致、公開版本文・base属性の直接更新拒否。下書き改名後もget/listのlatest_version.nameが公開時の名前を返す。
- adminを含む他人、別Workspace、未知IDからの私有アクセス拒否。
- memberによる共有登録、作者/adminの編集、一般memberへのdraft秘匿、作者退出後の共有保持、admin降格後の編集拒否。
- 並行create・publishの同key再送、異なる要求のkey衝突、異なる編集者のCAS競合、archive後の元公開結果の再送。
- 私有skill混入、跨Workspace、未知version、agentをskillとして参照する要求の拒否。依存archive後の公開・新規利用拒否と履歴参照の維持。
- 所属喪失・user停止後の読み取りとmutation再送拒否。再加入後は現在権限で参照できる。
- path traversal、重複path、非text、未知field、過大本文、重複skill、不明tool、kind不一致をTS/SQL境界で拒否。
- 一覧filter/cursorの整合、非公開draftの秘匿、131072 bytesの受付と131073 bytesの拒否。
- 100件・100版・128 MiBの並行上限。容量試験は実際のcanonical本文を保存し、未計上の容量をfixtureで偽っていない。
- 限定 `ax_api` が7公開関数を呼びCOMMITでき、table/helper/実行roleの読み取りは拒否される。
- v6環境へ作った旧run・Workspace・ready fileとbytes、v1〜v6のchecksumがv7追加後も同一である。
- Workspace除籍transactionを待つpublishは、除籍確定後に拒否されてversionを作らない。依存archiveとagent publishが競合しても、archive後の新規利用は通らない。

初回の専用DB試験でSQLのCASE括弧とローカル変数名の衝突を検出し、修正後に全件を再実行した。型検査の初回は並行作業中のroute生成型が不足していたが、typegen後の最終検査は成功している。

## 引き渡しと限界

保存成功はエージェント実行成功を意味しない。スケジュール、controllerのversion取得権限、補助scriptの隔離実行、builtinの導入・更新は後続unit。会話・入力file・成果物の私有権限を共有定義へ広げていない。

稼働migration、AX、課金、commit/PRは実施していない。API/BFF/UIの統合結果と独立レビューは親担当の証拠に従う。リポジトリ全体の `git diff --check` は所有外OKFの `rules/ax-model-spending.md` の末尾空白を報告したため親へ通知し、本担当では変更していない。OKF保存も親担当へ引き渡す。

2026-10-07追記：Web独立レビューR1の採用を受け、公開版summaryにnameを追加した。保存層の変更は担当Bによる自己検証であり、独立レビューには数えない。変更後の専用DB16件を全件再実行し成功（同じ最終ログを更新）。Web表示側の変更・ブラウザ回帰は親担当。
