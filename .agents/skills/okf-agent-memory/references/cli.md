# CLIの詳細

CLIはTypeScriptで実装され、Bun 1.4.2以上で動作する。初回とpackage.json・bun.lock・Bunの版が変わった起動時には、CLIがスキルのscripts内で `bun install --frozen-lockfile --ignore-scripts` を実行し、再起動してから本体を読み込む。scriptsへの書き込み権限と、必要なパッケージを取得できるネットワークまたはBunのキャッシュが必要になる。導入後の検索はオフラインで動作する。

利用先プロジェクトのルートから実行する。bundle引数の省略時は、その作業ディレクトリの `.space/babel/` を使う。`code_refs` の検証も作業ディレクトリを基準とする。

```sh
export OKF_SKILL='/absolute/path/to/skills/okf-agent-memory'
export OKF_CLI="$OKF_SKILL/scripts/okf.ts"
export OKF_BUNDLE="$PWD/.space/babel"
bun "$OKF_CLI" init "$OKF_BUNDLE" --json
bun "$OKF_CLI" help
bun "$OKF_CLI" create --help
```

依存定義・bun.lock・node_modulesはすべてスキルのscripts内に置く。利用先のpackage.json・bun.lock・node_modulesへ追加せず、呼び出し元の作業ディレクトリも変えない。導入に失敗した場合は本体を実行せず、通常のエラー形式で終了する。

スキルの配置先を利用先package.jsonのworkspacesに含めない。依存導入時に祖先のworkspace設定に含まれていれば停止するため、プラグインのキャッシュなど、そのworkspaceパターンの外へスキルを配置する。

同時起動時は準備が完了するまで最大約5秒待ち、間に合わなければエラーを返す。その場合は実行中の準備が終わってから再実行する。異常終了後に `scripts/node_modules/.okf-bootstrap.lock` が残った場合は、そのファイルのpidと対象スキルを使う全プロセスの停止を確認してからロックだけを削除し、再起動する。稼働中のロックを削除しない。

`init` は既存文書を保持し、5種類のディレクトリ、各目次、ルートの目次・履歴を作る。`create` は既存文書を上書きしない。更新には `update` を使う。

## 日本語の検索

```sh
bun "$OKF_CLI" search 'ルール' "$OKF_BUNDLE" --limit 10 --json
bun "$OKF_CLI" search '認証 APIキー' "$OKF_BUNDLE" --limit 10 --json
```

検索対象は `title`・`tags`・`description`・concept ID・Markdown本文。日本語を単語に分割するため、「認証変更の保留ルール」は「ルール」で見つかる。検索語と文書は検索時だけNFKC正規化・英字の小文字化を行い、全角・半角や結合文字の違いを吸収する。保存済み文書は変更しない。

単語の前方一致で検索し、複数語はいずれかに一致する文書を候補にする（OR）。共通する助詞 `の`・`は`・`が`・`を`・`に`・`へ`・`と`・`で`・`も`・`や` は検索語と文書の両方から除外する。除外後に語が残らない場合は `[]`。同義語や活用形の変換、単語の途中からの任意の部分一致は行わない。例えば「規則」と「ルール」は別の語として扱う。

順位はMiniSearchのBM25+で計算する。項目の重みは title 4 / tags 3.5 / description 2.5 / ID 2 / body 1。スコアは小数点以下2桁に丸め、同点はconcept ID順に並べる。`matched_on` は一致した項目名をこの順序で返す。検索語は先頭1,000文字、分割後の先頭50語まで。結果は既定10件、`--limit` 指定時は最大100件。`--all` を指定すると該当する全件を返す。

インデックスは実行ごとに文書からメモリー上に構築するため、直接編集した内容も次回検索に反映される。日本語の単語境界はBunが利用する国際化処理に依存し、実行環境の更新で変わる場合がある。同じ文書・入力・実行環境では同じ結果を返す。

## typeで絞り込む

```sh
# 検索語なしでルールと原則のdescriptionを全件取得する
bun "$OKF_CLI" search --type rule "$OKF_BUNDLE" --all --json
bun "$OKF_CLI" search --type principle "$OKF_BUNDLE" --all --json
# 原則の中から検索する
bun "$OKF_CLI" search '検証' "$OKF_BUNDLE" --type principle --limit 3 --json
# パスに適用されるルールを取得する
bun "$OKF_CLI" search --for-path 'src/auth/login.ts' "$OKF_BUNDLE" --type rule --all --json
```

`--type` は `rule`・`principle`・`knowledge`・`procedure`・`decision` のいずれか1つ。frontmatterの `type` と完全一致で絞り込み、ディレクトリ名や本文の語から推定しない。無効な値は引数エラーとする。`--type` 省略時の検索は従来どおり全種類を対象とする。

検索語なしなら、`code_refs` のない全体ルールも候補になる。`hold > constraint > context`、同じgovernanceではconcept ID順に返し、`score` は0、`matched_on` は `["type"]`。検索語を指定すると、その語に一致する文書を従来の関連度順で返す。`--for-path` との併用ではパスとtypeの両方で絞り、governanceの優先順位を維持する。パス検索に検索語も渡す場合は順位への加点に使い、語に一致しない保留文書を除外しない。併用時の `matched_on` は従来の一致項目の末尾に `type` を追加する。

絞り込みは件数制限より前に行う。全件の候補を確認する場合は `--all` を使う。`--limit` との併用は引数エラーとし、省略時の10件・数値指定時の最大100件は維持する。`--all` はキーワード検索・type検索・パス検索のいずれでも使える。

検索結果には、通常表示・JSONのどちらでもdescriptionを含む。ルール・原則は全件のdescriptionから作業に合致する文書を選び、選んだIDの本文を `show` で確認する。検索結果だけを本文を読んだことにはしない。`status` や期限切れによる自動除外は行わず、本文とメタデータで適用を判断する。

`--type` または `--for-path` があり位置引数が1つの場合、その引数が既存ディレクトリならbundle、それ以外なら検索語として扱う。曖昧さを避けるには検索語とbundleを両方指定する。検索語なしでbundleを明示する形式は `search '' "$OKF_BUNDLE" --type rule`。bundle省略時は既定の `.space/babel/` を使う。

## 本文とfrontmatterを渡す

`--body` はMarkdown本文全体の文字列、`--body-file` はUTF-8ファイルのパス。両方は指定できない。本文を省略した更新は既存本文を保持し、`--body ''` は本文を空にする。

`--metadata-file` はJSONまたはYAMLのマッピングを読む。Markdownファイルの場合はfrontmatter部分を読む。これはCLIへの入力ファイルであり、bundleに保存される文書は常にfrontmatter付きMarkdownである。

例えば `metadata.json` に次の内容を用意する。実際に確認した根拠があれば、このマッピングに `sources` を加える。

```json
{
  "type": "rule",
  "title": "認証変更時の確認",
  "description": "認証処理の変更では成功と失敗の両方を確認する。",
  "governance": "constraint",
  "code_refs": ["src/auth/"],
  "tags": ["認証", "テスト"],
  "status": "stable"
}
```

```sh
bun "$OKF_CLI" create rules/auth-tests "$OKF_BUNDLE" \
  --metadata-file metadata.json --body-file body.md --actor agent:codex --json
```

- `--type`、`--title`、`--desc`、`--tags`、`--status` は入力ファイルの同じ項目を上書きする。`--tags` はカンマ区切り。
- 更新は指定したトップレベル項目だけを置き換える。`sources` などの配列は全体を渡す。未知の独自項目は保持する。
- `generated` はCLIが実際の日時と `--actor` から設定する。入力ファイルでは指定できない。actor省略時は `agent/cli`。
- `verified` を自動生成することはない。入力する場合は、実際に内容確認した人間の記録だけを指定する。
- 任意項目の明示的な削除には `update ... --unset resource` を使う。複数項目なら `--unset` を繰り返す。必須項目と `generated` は削除できない。検証を通すために過去の `verified` を消す操作はしない。
- `update` の内容が同一なら、日時と履歴も変更しない。YAMLの再出力が必要な変更ではfrontmatterのコメント・整形は正規化される。本文を変更しない更新では本文の改行・空白を保持する。

## 文書を削除する

```sh
bun "$OKF_CLI" delete "rules/auth-tests" "$OKF_BUNDLE" --dry-run --json
bun "$OKF_CLI" delete "rules/auth-tests" "$OKF_BUNDLE" --actor agent:codex --json
```

`delete <concept-id> [bundle]` は文書のファイルを物理削除する。bundle省略時は `.space/babel/`。`--dry-run` は同じ解析と変更計画を行い、文書・目次・履歴を変更せず `status: "preview"` を返す。実行時の書き込み権限や、その後の状態が変わらないことまでは保証しない。

- 削除対象へのbundle内のリンクを解除する。CLIの `# Related Concepts` / `# Related` 節の単独の関連項目と、目次の単独掲載行は削除する。空になった関連節も取り除く。通常の文章中や他のリンクと同じ行にあるリンクは、表示文字と周囲の文章を保持して解除する。
- 対象が持っていた出リンクは対象ファイルとともに消える。リンク先の文書は削除しない。空のディレクトリや目次も残す。
- 過去の履歴は消さず、削除対象へのリンクを表示文字とIDに置き換える。`log.md` に `Deletion`、対象ID・題名、実行者、実行日時、リンクを解除した文書のIDを記録する。`--no-log` / `--no-index` は受け付けない。
- リンクを解除した文書の `generated` は更新する。その他のメタデータと無関係な本文は保持する。過去の `verified` は保持するため、更新前の確認として警告される場合がある。
- 関連の対象は、検索・表示で使うグラフと同じインライン形式のbundle内Markdownリンク。コード例、HTMLコメント、エスケープされたリンク、画像、外部URLは変更しない。参照形式リンク、frontmatterの `sources` / `code_refs`、別bundleや外部文書からの参照は自動更新の対象外。
- 対象が存在しない場合は終了コード1で、変更・重複ログを残さない。残す文書のfrontmatterを解析できず参照を確認できない場合や、更新する文書のメタデータが不正な場合も書き込み前に失敗する。不正なfrontmatterを持つ削除対象自体は削除できる。

結果には `concept_id`、`path`、`updated_concepts`、`changed_paths`、`removed_relations`（source/targetの組）、`new_orphans` を返す。`changed_paths` は削除ファイルを含む。`new_orphans` はこの削除で新たに孤立する文書であり、既存の孤立文書は含めない。孤立の判定は `validate` と同じで、削除後にconceptが1件以下なら空配列になる。

削除後は `validate --strict --drift` で確認する。削除自体が成功しても、残った文書の孤立や古い確認記録によってstrict検証が失敗する場合がある。検証を通すためだけに無関係なリンクを追加したり、過去の確認記録を消したりしない。

## 結果と検証

| 操作・形式 | 結果 |
| --- | --- |
| `search --json` | ID・説明・スコア・governance・関連リンクの配列。該当なしは `[]` |
| `show --json` | frontmatterと本文、元のMarkdown、`inbound`・`outbound`。独自項目は `extra` |
| `show --raw` | 元のMarkdownをそのまま出力。`--json` と併用不可 |
| 変更操作の `--json` | `status: "success"` と対象IDなど |
| `delete --dry-run --json` | `status: "preview"` と変更対象・解除する関連・新たな孤立文書 |
| `validate --json` | `errors`・`warnings`・`gate_findings`・`broken_links`・`orphans`・`stale_count` と `gate_passed` |
| 操作エラーの `--json` | stdoutに `status: "error"` と `error`。書き込み処理の失敗では `written_paths` も返す |

終了コードは成功 `0`、引数・変更操作の失敗または検証不合格 `1`、検索・表示・検証でのbundle読み込み失敗 `2`。JSON形式ではstderrの有無だけで成功を判断せず、終了コードと結果を確認する。

`validate --strict --drift` は、プロファイル違反、警告、旧形式の残存、リンク切れ、孤立文書をすべて不合格にする。孤立文書は、2件以上のconceptがあるbundleで、他のconceptとの入出リンクがどちらもない文書。目次からのリンクはconcept同士の関連には数えない。

`--drift` は親の目次への掲載・説明の一致と `code_refs` の実在を確認する。globも一致するパスがあるか調べる。期限切れと古い `verified` は通常の検証でも警告する。`--stale` はstrictでなくても期限切れを不合格にする。これらは形式と参照の検証であり、記述の事実性や人間の確認を証明しない。Mermaid限定など本文作成の契約はエージェントが守る。

## 保存失敗からの復旧

書き込みはbundle内の `.okf-write-lock` で同時変更を排他し、各ファイルを一時ファイルから置換する。複数ファイル全体のトランザクションではないため、途中で失敗したら `written_paths` と `show` で現状を確認する。内容が正しければ次で目次と不足する履歴参照を補う。

削除も同じ排他と変更前の内容照合を行う。参照・目次の整理、対象ファイルの削除、削除イベントの記録の順に実行し、途中で失敗した場合は自動で巻き戻さない。`written_paths` には既に削除したファイルも含む。削除に失敗した段階では成功の削除イベントを記録しないが、ファイル削除後にログ書き込みだけが失敗する可能性はある。その場合は未完了として報告し、バックアップ等から復元して原因を解消する。削除対象がない状態での再実行や `update --sync` では、失われた削除イベントを再構成できない。

```sh
bun "$OKF_CLI" update "concept-id" "$OKF_BUNDLE" --sync --json
bun "$OKF_CLI" validate "$OKF_BUNDLE" --strict --drift --json
```

`--sync` は内容が不変なら `generated` を保持し、必要な修復を `Synchronization` として履歴に記す。失われた過去の変更時刻や出来事を再構成する機能ではない。既に同期済みなら重複記録しない。`--no-index`・`--no-log` は意図的に同期を省く場合だけ使う。

プロセスが強制終了するとロックが残る場合がある。CLIは稼働中の書き込みと区別できないため、自動解除しない。実行中のプロセスがないことを確認した管理者がロックを除去して再開する。bundle内のシンボリックリンクは読み書きとも拒否する。

YAMLの解釈は `Bun.YAML` に従う。重複したマッピングキーはBunが後の値を採用し、このCLIでは検出できないため、入力ではキーを重複させない。本文の関連リンクはインライン形式の `.md` リンクを対象とし、コードフェンス・HTMLコメント・画像・外部URLを除く。Markdownの参照形式リンクはグラフ化しない。
