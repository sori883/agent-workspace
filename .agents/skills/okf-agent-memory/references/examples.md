# 操作例

`$OKF_CLI` と `$OKF_BUNDLE` は [SKILL.md](../SKILL.md) の指定どおり設定する。例のID・内容・actorは実際の対象に置き換える。これらは操作の例であり、採用済みのプロジェクトルールではない。

## 既存の制約を調べる

```sh
bun "$OKF_CLI" search --type rule "$OKF_BUNDLE" --all --json
bun "$OKF_CLI" search --type principle "$OKF_BUNDLE" --all --json
# descriptionが作業に合致する文書のIDを指定する
bun "$OKF_CLI" show "rules/auth-tests" "$OKF_BUNDLE" --json
bun "$OKF_CLI" search --for-path "src/auth/" "$OKF_BUNDLE" --all --json
bun "$OKF_CLI" search "認証 テスト" "$OKF_BUNDLE" --limit 3 --json
```

ルール・原則は全件のdescriptionを確認して合致する文書を選び、その本文だけを取得する。適用判断が曖昧な文書も本文を読む。パス検索の結果から保留と制約を確認し、話題検索で過去の判断を補う。実際の検索結果にないIDを推測して使わない。

## 決定を記録する

```sh
bun "$OKF_CLI" search "認証 テスト範囲" "$OKF_BUNDLE" --limit 3 --json
```

同じ決定を扱う文書があれば `update` を使う。新規文書が必要で、根拠となるユーザーの決定がある場合の例：

```sh
bun "$OKF_CLI" create "decisions/auth-test-scope" "$OKF_BUNDLE" \
  --type decision \
  --title '認証テストの範囲' \
  --desc '認証の成功・期限切れ・不正入力を回帰テストの対象とする。' \
  --body 'ユーザーの明示的な決定に基づき、認証の成功・期限切れ・不正入力を確認対象とする。認証失敗の見落としを防ぐために採用した。' \
  --actor 'agent:codex' \
  --json

bun "$OKF_CLI" show "decisions/auth-test-scope" "$OKF_BUNDLE" --json
```

決定の根拠に参照可能な資料があれば、[CLIの詳細](cli.md) の `--metadata-file` で `sources` も設定する。実際に確認していない資料や、人間の `verified` は追加しない。

## 関連付けて検証する

以下は `procedures/auth-test-run` の存在と内容を `show` で確認済みの場合の例。

```sh
bun "$OKF_CLI" relate "decisions/auth-test-scope" "procedures/auth-test-run" "$OKF_BUNDLE" \
  --desc '決定した確認範囲を実行するテスト手順' \
  --actor 'agent:codex' \
  --json

bun "$OKF_CLI" validate "$OKF_BUNDLE" --strict --drift --json
```

保存結果、目次・履歴の同期、検証のエラー・警告が0件であることを確認して完了とする。

## 文書を削除する

ユーザーが `rules/auth-tests` の削除を依頼した場合の例。

```sh
bun "$OKF_CLI" delete "rules/auth-tests" "$OKF_BUNDLE" --dry-run --json
bun "$OKF_CLI" delete "rules/auth-tests" "$OKF_BUNDLE" --actor 'agent:codex' --json
bun "$OKF_CLI" validate "$OKF_BUNDLE" --strict --drift --json
```

対象ファイル、対象への関連リンク、目次の掲載を削除し、履歴を記録する。通常の文章中のリンクは表示文字を残す。削除で新たに孤立した文書は `new_orphans` に表示されるため、削除結果とstrict検証の成否を分けて確認する。
