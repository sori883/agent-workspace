# スキル自動利用の実装契約

2026-10-08。候補Bを土台に採用。比較担当もBを推奨した。Aの同一Taskループは起動回数を減らすが、今回の目的のために操作sequence・費用精算・終了判定の全面拡張を必要とするため見送る。Aの版固定・段階読み込み・初回明示指定という共通の要件は保つ。

Bからの簡略化: 読み込んだ本文は既存40KiB以内のdescriptorにSQLが投影し、そのhashで固定する。新しいchunk転送操作を増やさない。旧rootのdescriptorとdefinition chunk経路はそのまま使う。大きすぎるcontextは明示的なエラーで止める。Python descriptorへスキル本文は渡さない。

## APIと画面

- 既存startのskill_version_idsは公開版UUIDの配列。追加builtin_skill_idsはgeneral-v1/tabular-v1の重複なし配列。合わせて8件まで。どちらも省略可能。
- 新しい通常依頼は標準エージェント。旧agent_version_id付き受付の同一key再送は互換を維持、新規はagent_selection_disabledで拒否。
- UIは標準固定。入力欄の行頭`/`から候補を指定し、削除可能なchipにする。URLや通常のスラッシュを命令と誤認しない。未確定commandを無言で送らない。
- ライブラリはスキルだけを登録・編集。旧agentデータと履歴は保存し、既存detailは閲覧専用。
- root viewにskill_catalog_omitted（整数、旧経路0）とfailure_reason（文字列またはnull）を追加。契約上は旧fixture等の互換のためoptional。

## 新しいRuntime descriptor

既存version2 envelopeの任意フィールドskill_contextを、新方式のruntime区間だけに加える。旧rootおよびpython区間ではキー自体を省略する。

```ts
type SkillContext = {
  version: 1;
  catalog: {id: UUID; name: string; description: string}[];
  omitted_count: number;
  loaded_skills: {
    id: UUID; name: string; description: string; instructions: string;
    files: {path: string; size_bytes: number; sha256: string}[];
  }[];
  loaded_files: {skill_id: UUID; path: string; content: string; size_bytes: number; sha256: string}[];
  builtin_skill_ids: ("general-v1"|"tabular-v1")[];
};
```

catalogには登録スキルのみ。組み込みの概要は固定Runtime imageの共通catalogからモデル入力へ加える。general-v1は常に基礎指示、tabular-v1は明示指定またはread_skillsで読む。スキル全体をdefinition_manifestへ載せない。新方式では同manifestは空。登録版UUIDは不変版を指し、descriptor SHAが実際の投影内容を固定する。fileのsha256とsize_bytesはUTF-8本文に対する値。

登録catalogは受付時に権限のある最新公開版を固定し、最大32件・UTF-8 JSON 8KiB。明示指定のdefinitionは自動候補から除き、指定された版だけを読み込む。名前/版IDの順序を固定し、超過件数をomitted_countとしてモデルと画面へ伝える。途中の新版公開で差し替えない。ページ探索は今回追加せず、省略されたスキルは`/`候補の一覧ページ送りで指定できる。

## モデル提案と遷移

既存question/output/unsupported/pythonへ次を追加する。

```ts
{kind: "read_skills", skill_ids: (UUID|"general-v1"|"tabular-v1")[]}
{kind: "read_skill_file", skill_id: UUID, path: string}
```

read_skillsは1〜8件、重複なし、カタログにある未読スキルのみ。generalは基礎指示として既読なので動的要求は拒否。root内で読み込める登録版と追加tabularは計8件まで。明示generalは基礎指示の指定として受け入れる。

read_skill_fileは主本文を読んだ登録スキルの、目録に載る未読のファイルのみ。パスは既存references/scripts/assets規則。scriptを読んでも実行権限は増えない。rootの総モデル6回・tool8回・Python3回・区間9回・300秒・0.01 USD、累計0.05 USDを維持する。

各区間は既存sequence1=model、2=tool。read提案の認可・精算・実停止を経て、読み込み記録の追記と次runtime作成を同じtransactionで実施する。finish再送は同じ次区間を返す。進展しない重複readや未知IDを拒否する。

## SQLと認可

schema-v9を追加し既存migrationは変更しない。rootの新方式flag/nullable catalog snapshot/省略数は不変。読込済み(main=SKILL.md、file=既存path)は追記専用表へ、元のrunを含め保存する。新方式のax_workbench_definitionsはカタログと読み込んだ登録版を全件現在権限で確認する。tool予約時、handoff、staging、生成直前の既存live経路から再認可されること。未使用候補のarchiveでもそのrootが止まる可能性を最小実装の制限として明記する。

skill_contextを含むdescriptorが40KiBを超える場合はskill_context_too_largeで生成前停止。6000tokenのGateway事前計数も維持。エラー理由はroot.failure_reasonに表示可能なcodeとして渡す。既存の他root・旧agent経路・費用台帳は変更しない。

## 所有範囲と検証

- SQL担当: schema-v9、migration登録、web/tests/workbench.test.tsと必要なDB試験。共有TS型・UI・Go/Pythonは編集しない。
- Runtime担当: ax-local/task_runtimeの関連ファイル・同tests、execution/native/controller/gatewayの関連ファイル・同tests、builtin_catalog。固定pins・deploy・Webは親。
- UI担当: compose/library/editor/ナビ/CSS・関連browser試験。API/SQL/共有型・Runtimeは親または別担当。
- 親: 共有TS/APIエラー、統合検証、実画像確認、固定image/配備、知識、PR。

テストは未読本文なし→読込後だけ本文、明示初回本文、補助資料の段階読込、固定版・失効・scope境界・再送・旧root互換・上限を確認する。Runtime/Go/SQLの共通DTOを照合する。UIはkeyboard/IME/同名/版固定/receipt不明/320px/axeを確認する。有料確認は範囲を固定した1依頼から開始し、想定外の失敗やusage不明なら追加送信しない。
