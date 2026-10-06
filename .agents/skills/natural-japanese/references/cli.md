# CLIの使い方

入口はこのスキルの`scripts/japanese.ts`。Bun 1.4.2以上で実行する。初回と依存定義の更新時は、固定された依存をスキル自身の`scripts/`へ導入する。日本語解析はkuromojiを使い、モデルの取得や外部サービスへの本文送信は行わない。

利用先のworkspaceに含まれる場所では依存の導入を拒否する。通常のプラグインキャッシュなど、workspaceの対象外へ配置する。起動ロックが残っている場合は、別の起動処理が動いていないことを確認してから`scripts/node_modules/.natural-japanese-bootstrap.lock`を取り除いて再実行する。

```text
bun /absolute/path/to/natural-japanese/scripts/japanese.ts <lint|outline|terms|score> <file> [options]
```

| コマンド | 用途 | オプション |
| --- | --- | --- |
| lint | 定型句・翻訳調・反復・文体統計を検出 | --json、--genre、--baseline、--reading-load、--experimental |
| outline | 見出し・段落冒頭・箇条書きの位置と見出し統計 | --json |
| terms | 用語候補の初出行・回数・説明の手掛かり | --json |
| score | lintと同じ検査と自然度の機械ベース | --json、--genre、--reading-load |

`--genre`は`essay`・`tech`・`business`。未指定なら共通の目安を使う。businessでは箇条書き・太字・定型見出し・段階表現に関する実験的な指摘を出さない。`--experimental`は静的な補助検査を増やすオプションであり、AIモデルの検査ではない。

UTF-8のMarkdownまたはテキストファイルを読み取る。入力ファイルは変更しない。正常な検査は指摘件数にかかわらず終了コード0。存在しないファイル、ディレクトリ、UTF-8でない入力、不正な引数、依存の導入失敗は終了コード1と標準エラー出力で知らせる。`--json`の正常結果は標準出力だけに書く。

## 検査範囲と解釈

lintの本文検査は見出し・箇条書き・引用・表・コードブロック・frontmatter・HTMLコメントを除く。インラインコードとリンク先URLも解析対象から外す。構造検査は見出し・箇条書きを含む。outlineは見出し・段落冒頭・箇条書きの項目数を示し、termsは本文と見出しから候補を抽出する。Markdownの特殊な拡張構文やインデントだけのコードは完全には識別しない。

行番号は元ファイルの1始まり。文章の区切りは句点・疑問符・感嘆符・改行を使う簡易判定である。品詞・基本形・読みは辞書による推定で、固有名詞や新語を誤って分割することもある。少ない文数では統計の指摘を出さない。指摘なしは品質保証やAI不使用の証明ではない。

`info`・`warn`・`critical`は検出ルール上の強さであり、修正の必須度ではない。具体性の不足は素材を調べて判断し、語尾や言い換えだけで埋めない。用語の反復は表記統一として必要な場合がある。

## 前回結果との比較

前回のlint JSONを一時ファイルへ保存し、同じジャンル・オプションで比較する。出力先は入力文書や前回JSONと別のファイルにする。

```sh
bun /absolute/path/to/natural-japanese/scripts/japanese.ts lint draft.md --json > /tmp/natural-japanese-task/previous.json
bun /absolute/path/to/natural-japanese/scripts/japanese.ts lint draft.md --json --baseline /tmp/natural-japanese-task/previous.json > /tmp/natural-japanese-task/current.json
```

例の一時ディレクトリは先に自分の作業用として用意する。比較結果は`baseline.summary`の`resolved`・`new`・`persisting`と、各指摘の`status`に出る。同じカテゴリと抜粋の先頭20文字を空白を除いて対応付け、文書全体の統計はカテゴリで対応付ける。同じ指摘が複数あれば一件ずつ比較する。行移動には耐えるが、意味の同一性を保証する比較ではない。

baselineのJSONが読めない場合はエラー。JSONとして読めてもfindings配列がなければ警告して比較を省略し、不正な要素だけなら警告して読み飛ばす。`reading_load`は比較しない。

## 読解負荷と診断

`--reading-load`は長文・埋もれた列挙・連続漢字・二重否定・「の」の連鎖を`reading_load`欄へ出す。全指摘は参考情報であり、通常のfindings・スコア・baselineに加算しない。

scoreの`score.base`は[診断手順](diagnose.md)で解釈する。CLIは構造や意味の良し悪しを採点せず、fullの判断調整はAIが理由付きで行う。
