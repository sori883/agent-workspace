---
name: okf-agent-memory
description: BunのOKF CLIでプロジェクトの永続記憶を検索・参照・記録・更新する。過去の決定や変更対象の制約を調べるとき、ルール・原則・知識・手順・決定を会話を越えて残すときに使う。
license: MIT
---

# OKF Agent Memory

OKF v0.2のMarkdown文書をプロジェクトの永続記憶として管理する。判断と本文の作成はエージェントが行い、検索・保存・目次と履歴の更新・形式検証はBun CLIに任せる。

## 0. プロジェクトおよびドメインコーデックス

- **事実整合性：** 記述を根拠と照合し、事実・推測・未確認事項を区別する。矛盾を隠したり、根拠や検証記録を捏造したりしない。
- **ドメイン中立性：** 記憶管理をソフトウェア開発など特定の分野に限定しない。文書の形式・操作と、各プロジェクト固有の知識・判断を分離する。
- **厳密な決定性：** 同じ入力・bundle状態・実行条件に対する形式処理の結果を再現可能にする。検索・保存・検証はCLIの仕様に従い、その場ごとの独自処理へ置き換えない。
- **図はMermaidに限定する。** このスキルで図を作成する場合はMermaidを使い、ASCIIや罫線による図・ボックスアートは使わない。Mermaidで表現できない場合は図の作成を止め、その制約を説明する。

## 1. 行動契約

1. **記憶はbundleに残す。** 既定の保存先は利用先プロジェクトの `.space/babel/`。ユーザーが対象bundleを指定した場合はそれに従う。
2. **書く前に検索する。** 設計変更の提案やconceptの新規作成前に `search` を実行し、既存の判断・制約・重複を確認する。
3. **必要な文書だけ読む。** bundleを `ls`・`rg`・一括読み込みで探索せず、`search` の説明から候補を選び、必要な本文だけ `show` で取得する。
4. **重複より更新を優先する。** 同じ話題の情報は既存conceptへ反映し、独立した意味や寿命がある場合にだけ分ける。
5. **会話の雑音を保存しない。** 将来役立つ事実・決定・根拠を残し、会話全文、思考過程、使い捨てのログを記録しない。推測は事実と区別する。
6. **出所と信頼を保つ。** 作成・更新した主体を `generated`、根拠資料を `sources` に記録する。参照先を捏造せず、エージェントの作成やテスト成功を人間による `verified` と扱わない。
7. **作業後に知識を見直す。** 意味のある作業が終わったら、新たな決定・要件・発見・訂正を評価し、保存する価値があるものを作成または更新する。
8. **検証を完了条件にする。** conceptを変更したら目次・履歴の同期を確認し、`validate --strict --drift` でエラー・警告が0件になるまで修正する。保存や検証に失敗した場合は、その操作を未完了として報告する。

コードの領域を初めて変更するときは、先に `search --for-path` で適用文書を確認する。`constraint` の制約を守り、`hold` の対象操作は止めて根拠文書を示す。当該保留を踏まえたユーザーの解除・承認が既にあればそれに従い、なければ確認する。`context` は背景情報として使う。適用範囲や矛盾の確認は [検索・参照](references/discovery.md) に従う。

## 2. CLIコマンド

OKFの操作にはBun CLIのみを使用する。MCPツールやMCPサーバーは使用しない。

Bun 1.4.2以上を用意し、[CLIのセットアップ](references/cli.md) に従って起動する。初回と依存定義の変更時は、CLIがスキルのscripts内に依存パッケージを導入してから再起動する。

`$OKF_CLI` に、この `SKILL.md` と同じディレクトリにある `scripts/okf.ts` の絶対パスを設定する。`$OKF_BUNDLE` には対象bundleの絶対パスを設定する。作業ディレクトリは利用先プロジェクトのルートを維持し、スキルの配置先へ移動しない。新しいbundleは `bun "$OKF_CLI" init "$OKF_BUNDLE" --json` で初期化する。

| 操作 | コマンド |
| --- | --- |
| 知識を検索 | `bun "$OKF_CLI" search "検索語" "$OKF_BUNDLE" --limit 3 --json` |
| 種類を絞って検索 | `bun "$OKF_CLI" search "検索語" "$OKF_BUNDLE" --type principle --limit 3 --json` |
| ルールを全件取得 | `bun "$OKF_CLI" search --type rule "$OKF_BUNDLE" --all --json` |
| 原則を全件取得 | `bun "$OKF_CLI" search --type principle "$OKF_BUNDLE" --all --json` |
| コードに適用される文書を検索 | `bun "$OKF_CLI" search --for-path "src/auth/" "$OKF_BUNDLE" --all --json` |
| 文書を取得 | `bun "$OKF_CLI" show "concept-id" "$OKF_BUNDLE" --json` |
| 文書を作成 | `bun "$OKF_CLI" create "concept-id" "$OKF_BUNDLE" --type "type" --title "題名" --desc "説明1文" --actor "agent:codex" --json` |
| 文書を更新 | `bun "$OKF_CLI" update "concept-id" "$OKF_BUNDLE" --desc "更新した説明1文" --actor "agent:codex" --json` |
| 削除の影響を確認 | `bun "$OKF_CLI" delete "concept-id" "$OKF_BUNDLE" --dry-run --json` |
| 文書と関連リンクを削除 | `bun "$OKF_CLI" delete "concept-id" "$OKF_BUNDLE" --actor "agent:codex" --json` |
| 文書を関連付け | `bun "$OKF_CLI" relate "source-id" "target-id" "$OKF_BUNDLE" --desc "関係の説明" --actor "agent:codex" --json` |
| bundleを検証 | `bun "$OKF_CLI" validate "$OKF_BUNDLE" --strict --drift --json` |

`concept-id` はbundle内の相対パスから `.md` を除いた値。`type` は [frontmatterの定義](references/frontmatter.md) から選び、`--actor` は実際の作成主体に合わせる。本文は `--body` または `--body-file`、追加のメタデータは `--metadata-file` で渡す。入力形式・終了コード・復旧方法は [CLIの詳細](references/cli.md) を参照する。

物理削除が依頼されている場合は `delete` を使う。対象ファイル、関連リンク、目次を整理し、削除の履歴を残す。`--dry-run` で変更対象と新たな孤立文書を確認できる。廃止と物理削除の選び方、削除後の検証は [更新・削除の扱い](references/update.md) に従う。

ルールの取得は `search --type rule --all` で全件のdescriptionを確認し、作業に合致する文書の `concept_id` を選んで `show` に渡す。原則を調べる場合も `search --type principle --all` で同じ手順を使う。適用するか判断しづらい文書は本文を確認する。typeは文書の種類であり、守るべき制約・保留かどうかは本文と `governance` で確認する。

知識の操作にはこのCLIを使い、Markdownの直接編集や手動検証へ切り替えない。コマンドが失敗したら、原因と書き込み済みの範囲を確認する。CLIが起動できない場合は、失敗を報告して知識操作を止め、保存・検証に成功したことにはしない。

## 3. 作業別の参照資料

該当する資料だけを読む。

| 場面 | 参照先 |
| --- | --- |
| 既存知識やコードの制約を調べる | [検索・参照](references/discovery.md) |
| 何を記憶し、どこへ保存するか決める | [保存判断](references/remember.md) |
| 文書やメタデータを作成・変更する | [frontmatterの定義](references/frontmatter.md) |
| 既存知識を訂正・更新・廃止する | [更新・矛盾の扱い](references/update.md) |
| 文書同士をつなぐ | [関連付け](references/relationships.md) |
| 一連の使い方を確認する | [操作例](references/examples.md) |
