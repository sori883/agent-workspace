# 候補 B: スキル読込を AX 区間間の確認済み操作にする

2026-10-08。設計候補のみ。実装・実環境検証はしていない。他候補は参照していない。

## 利用例と構造

利用者は標準エージェントへ普通に依頼する。最初のモデル入力には利用可能スキルの名前・説明・固定 ID だけがある。モデルが依頼に必要と判断した場合、`read_skills` を返す。現在の AX Task を精算・通信遮断・停止してから、外側の制御基盤が認可済み本文を次の AX Task へ渡す。そのモデルが回答または Python を提案する。不要なスキルは読まない。

`/` から利用者がスキルを選んだ場合は、固定 ID を送信し、その本文を初回 Task へ渡す。明示指定のためにモデルによる選択区間を増やさない。入力欄には解除可能な選択済みスキルを表示する。

登録済みスキルの補助ファイルは本文と同時に全部注入しない。最初はファイル名・サイズ・hash の一覧だけを渡し、必要なものを `read_skill_file` で次区間へ読み込む。登録された script は参照用テキストであり、Runtime が実行・import する権限にはならない。

標準エージェントの基本指示は常時使う。組み込み `general-v1` はその基礎動作に含め、`tabular-v1` はメタデータから意味判断して読む。ファイル添付の有無だけを選択規則にしない。組み込みスキルも `/` に表示する。

## 現状に接続する根拠

- `web/data/schema-v8.sql` の `ax_workbench_next` は不変 descriptor を作り、同じ root の確認済み履歴から次の AX Task を構成する。
- `ax_finish` は費用精算・egress deny・実停止の証拠を確認した後にだけ次区間を作る。現在は Python 提案と Python 結果の後にだけ継続する。
- 現行の root `definition_manifest` は不変で、`ax_workbench_definition_chunk` はその範囲だけ転送する。ここへ動的選択を追記してはならない。
- `ax-local/task_runtime/adapters/workbench.py` は固定 SDK 0.1.20 を各区間一回だけ呼び、モデル提案と tool 受領の二操作で終わる。内部 SDK 会話の復元や可変 mailbox sequence は不要である。
- `ax_agent_reserve` は一区間の sequence 1=model / 2=tool、root モデル 6 / tool 8 / Python 3 回を管理する。区間は最大 9、合計稼働 300 秒、費用 0.01 USD。これらを広げない。
- OKF の `decisions/systems/ax/agent-runtime` の責務分離、費用・認可・checkpoint は AX 外、進行する Runtime は AX 内という採用済み判断を保つ。

## 型と最小の操作面

```ts
type SkillId = "builtin:general-v1" | "builtin:tabular-v1" | UUID;
type SkillSummary = {
  id: SkillId;
  name: string;
  description: string;
};
type SkillResource = {
  skill_id: SkillId;
  path: "SKILL.md" | string;
  sha256: string;
  size_bytes: number;
};
type SkillRead =
  | { kind: "read_skills"; skill_ids: SkillId[] }
  | { kind: "read_skill_file"; skill_id: SkillId; path: string };
```

`read_skills` は重複なし 1〜8 件で、未読の主本文だけを対象とする。root 全体の読込済みスキルも最大 8 件とする。`read_skill_file` は既に主本文を読んだスキルの既存ファイルだけを対象にする。同じ資源を再要求して進展しないループは拒否し、予算上限だけに頼らない。パスを自由なローカルファイルアクセスへ変換しない。

開始 DTO は既存 `skill_version_ids: UUID[]` を明示指定用に保ち、`builtin_skill_ids` を固定 enum の配列として追加する。名称文字列を認可や版の解決に使わない。暗黙利用のカタログはサーバーが本人・選択 Workspace から取得し、クライアントが全候補を指定する方式にはしない。

主本文の転送表現は `name / description / instructions / files[{path,sha256,size_bytes}]`。実際の補助ファイル本文は含めない。スキル全体の公開版 hash は既存の不変版を特定するために使い、転送する主本文・補助ファイルそれぞれにも hash とバイト数を付ける。

## 保存・認可・版の境界

追加 migration で新規 root 向けに次を導入する。

1. `skill_discovery` などの不変な方針識別と、受付時のカタログ snapshot。登録済み候補は各 definition の最新公開版を固定する。利用者の明示指定は古い公開版でも既存の認可を通せばその版を固定する。draft・他人の personal・他 Workspace・archived を含めない。
2. `ax_workbench_skill_loads(root_id, skill_id, resource_path, source_run_id, sha256, size_bytes)` 相当の追記専用表。主本文とファイル読込を区別し、確認済み提案の操作 ID と結びつける。初回の明示指定には開始リクエストを根拠として記録する。UNIQUE で同じ資源の二重読込を防ぐ。
3. 新しい descriptor には、カタログの要約と読込済み資源の参照を載せる。本文は controller の staging で専用の範囲限定 reader から転送する。旧 root の `definition_manifest` と descriptor bytes は書き換えない。

組み込みスキルは不変の root `runtime_image` が版を固定する。SQL は固定 ID を許可し、Runtime は image 内の共通 `builtin_catalog.json` と本文 hash を照合する。新たな deploy 時 hash 設定同期は不要。Web 表示と image のカタログ一致はビルド・配備検証で確認する。

登録済み本文の reader は `(run, generation, controller, skill_id, path, part)` を受ける。現在の所属・root 所有者・失効・停止・固定公開版・当該 segment の読み込み資源を確認し、許可した資源の内容だけを返す。現行の definition 全体 chunk reader を新方式に流用して全ファイルを先に送ることはしない。コード Task はこの reader を使えない。

読込を決めた提案の認可は tool 予約時と次区間 staging 時に再確認する。モデル送信直前にも再確認する。公開新版が作られても既存 root の版は変えない。失効や archive で利用できなくなった版を以前の snapshot だけで読み続けない。

カタログ情報自体も権限の対象である。既に作った不変 descriptor が、現在は見せられない候補の情報を含む場合はモデル送信を拒否する。未使用候補の archive でもその区間が停止し得るのは最小構成で受け入れる不利益。停止済み区間の再解釈や descriptor の黙った差し替えはしない。

## 実行の遷移と再送

新しい読込提案も、モデル結果の検証 → 同じ提案の tool 予約・精算 → Task 完了 → 通信遮断・実停止 → 次区間、という現行の経路へ乗せる。

`ax_finish` の継続条件に `read_skills` / `read_skill_file` を追加する。成功時に読込台帳の追記と次 descriptor 作成を同じ transaction に置く。既存の `finish_response` を同じ generation/controller で再読した場合は、同じ次区間を返し、新しい Task や読込行を増やさない。停止確認不明・usage 不明は既存どおり hold とする。

Python の後は Runtime、読込の後も Runtime に戻る。`attempt_kind` は runtime/python の二種類を保つ。読込という別 Pod 種別は作らない。主本文読込の結果は利用者への質問ではなく進行状況として表示する。

モデルが無関係なスキルを読まなければ、一回で通常回答できる。代表的な消費は次のとおり。

| 依頼経路 | モデル回数 | AX 区間数 |
| --- | ---: | ---: |
| 通常の直接回答 | 1 | 1 |
| 暗黙スキル読込 → 回答 | 2 | 2 |
| 明示スキル → 回答 | 1 | 1 |
| 暗黙本文 → 補助ファイル → Python → 回答 | 4 | 5 |

読込を受け付けても次のモデル枠・稼働時間が残らない場合は、成功完了と表示せず上限到達を返す。読込に使うモデル要求・tool 回数を別枠にしない。

## カタログとコンテキストの上限

初期カタログは本文を除いた UTF-8 JSON の予算を設ける。候補案は最大 32 件・8 KiB。明示指定分を優先して含め、残りを名前と公開版 ID の決定的な順序で採る。上限を超えた場合は `omitted_count` をモデルと画面に伝える。件数だけを切って未掲載の存在を隠さない。`/` 候補 UI は通常の認可済み一覧をページ取得でき、カタログから省略された公開版も明示利用できる。

自動選択ですべての巨大な組織カタログを必ず探索する保証はしない。公式 Codex と同様に限定コンテキスト内のカタログという範囲を明記する。ページ探索まで必須にすると `list_skills` 提案と snapshot paging が追加で必要になり、6 モデル枠をカタログ巡回に消費するため今回の最小案では見送る。8 KiB / 32 件の最終値は統合側で現在の system/history サイズと照合して決める。

一度選ばれたスキル主本文は以後の Runtime 区間にも渡す。補助ファイル本文も、読込済みのものだけを渡す。全体は既存の 6000 入力トークン計数で止める。既存登録上限の 16 KiB instructions / 32 KiB file が必ずコンテキストへ収まるわけではない。超過時は本文短縮などの具体的な理由を返し、無課金の事前計数で止まったものをモデル不調に見せない。ファイルの行範囲 reader は有効な後続拡張だが、今回の最小案はファイル一件全体の読込に限定する。

## UI と既存データ

- エージェント選択・登録・編集の通常導線を消す。スキル一覧に標準の働きと組み込みスキルを表示し、スキルの作成・公開・共有操作を残す。
- 入力欄の `/` で検索可能な候補一覧を開く。名前衝突時は本人用/共有・作成者・公開版で区別する。Enter は候補確定、Escape は閉じる、IME 確定は送信にしない。通常テキスト中の URL やスラッシュは命令として消さない。
- 通信は確定した版 ID を送る。単に入力文字列 `/test` をサーバーで曖昧一致させない。補助 UI に頼らずキーボードから選べる。
- 新規通常受付は標準エージェントのみ。既存 agent 定義・版・履歴・待機中 root は残す。古い agent 管理 URL は閲覧専用、`?agent=` の新規開始リンクは利用不能の説明を表示し、黙って標準の新依頼に変えない。
- 旧 start の同一 idempotency key 再確認は既存の受付結果を返す。新規 `agent_version_id` を停止する場合でも、再確認処理より先に新方針の拒否を置かない。

## 変更範囲と検証

SQL: additive migration、カタログ snapshot、資源読込台帳、資源 reader、提案検証、予約時の参照検証、finish 継続、履歴表示。旧履歴・既存版・旧 descriptor を保存する。

Python/Go: 新しい descriptor の厳密型、資源 chunk staging、提案二種、JSON response schema の kind 先頭、読込済み情報の prompt 表現、標準 system の読込規則。既存 mailbox の二操作とモデル要求一回は変えない。

Web: `/` picker、組み込みと登録済みの共通候補、標準エージェント固定、旧管理 URL の閲覧専用化、読込中表示、正確な公開版・範囲表示。

最低限の試験は以下。

1. 正常: 無関係な依頼は本文なしで回答、関連スキルをモデル fixture が選択して本文が次区間だけに入る、明示指定は初回から本文、補助ファイルは選択後だけ本文が入る。
2. 境界: 他 Workspace・他人の personal・draft・archived・不明 ID・未公開版・未読スキルのファイル・path traversal を拒否。モデル送信直前の失効と archive を拒否。
3. 再送: 同一開始と finish の再読は同じ root/次 Task を返す。停止未確認で次 Task を作らない。失敗後にモデル送信を自動でやり直さない。
4. 費用: 読込も既存 6/8/3/9/300 秒内、巨大主本文・file・カタログ超過を計数前後で検証し、silent truncation を防ぐ。
5. 互換: 旧 root の hash/image/manifest と旧 agent 履歴を維持し、旧待機 root の回答と受付再確認が通る。
6. UI: `/` の矢印・Enter・Escape・IME・320px・画面読上げ、同名区別、8 件上限、スキル登録後の利用、カタログ省略表示、旧 agent URL 説明。

有料試験はこの候補作成では行っていない。意味選択は fixture だけでは証明できないため、実装後は既存費用承認内の少数の実モデル試験で別に評価する。

## 利点と引き受ける不利益

既存の確認済み区間・不変 descriptor・費用台帳を使い、SDK 内部の可変 tool loop や会話保存の正本を増やさない。model の read 提案は Python 提案と同じ境界で検証される。root のどの公開版をいつ読んだかを外側で追跡できる。

反面、本文を一つ読むだけでも Pod の停止・次の起動・追加推論が発生する。既存の 300 秒と 6 モデルという小さな予算に対し、スキル探索の割合が大きい。多数の補助ファイルを読む Codex のような細かい対話には適さない。Runtime 内部ループより SQL の継続分岐と descriptor 互換分岐が増える。今回の典型的な一スキル・一補助ファイル程度の流れには収まるが、応答時間と大きなスキルでの実測が採否の重要な条件となる。
