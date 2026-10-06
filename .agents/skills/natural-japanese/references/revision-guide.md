# 指摘を判断し、推敲を収束させる

## 指摘から読む資料を選ぶ

| カテゴリ | 確認すること |
| --- | --- |
| forbidden_phrase | [定型句](forbidden-patterns.md)。語句が内容を増やすか、根拠や留保として必要か |
| translationese / translationese_morph / english_syntax_inanimate_subject / inanimate_subject_morph / english_syntax_cleft_because | [翻訳調](translationese.md)。主体、修飾関係、自然な語順 |
| antithesis_repetition | 対比に実在する比較対象や誤解の訂正があるか |
| low_sentence_variance / low_burstiness / high_length_autocorrelation | 音読したときの単調さ。数値を変えるためだけに文を伸縮しない |
| nominal_ending | 長い本文に体言止めがないことが文書の用途に合うか。無理に追加しない |
| paragraph_lead_conjunction / uniform_paragraph_structure | 段落のつながりと内容に応じた厚み |
| repeated_sentence_lead / repeated_syntax_template | 説明の型の反復。固有名詞・技術用語・必要な並列性は残す |
| low_lexical_diversity_ttr / low_lexical_diversity_mtld | 同じ説明の水増しか、正しい用語の統一か |
| low_specificity | 数値・実例・根拠が不足していないか。素材の確認へ戻る |
| high_bold_density / high_bullet_ratio / boilerplate_heading / numbered_phase_structure / high_emoji_symbol_density | 文書の構成と強調が用途に合うか。形式の一律禁止にしない |
| sentence_too_long / buried_list / kanji_run / double_negative / no_chain | [読みやすさの確認項目](readability-antipatterns.md)。意味・条件・係り受けを保てる修正か |

## 濃淡と変更箇所

書く前に主張を支える重要な節と補助の節を分け、説明の厚みを配分する。既存文書では残す箇所を先に見極め、読者の得が具体的に言えるところを変える。

見出しの結論化、箇条書きの文章化、語尾の統一を全文へ一律に適用しない。議事録の助言や宿題などは、リストのままの方が探しやすい。口語の引用、節ごとの不揃い、著者特有の表現は、読解を妨げる場合だけ整理する。

## 素材不足の分岐

一般論しか言えない段落では、必要な情報が手元にあるかを確認する。提供資料を読む、利用可能な一次資料を調べる、ユーザーへ不足を尋ねる、の順で今回の範囲に合う方法を選ぶ。文章を自然に見せるための数値・体験・著者の方針を作らない。情報が得られなければ、欠落のまま渡す範囲や表現上の留保を明らかにする。

## 判断台帳

各指摘に、箇所・理由・判断・修正または保持理由を付ける。少数なら会話内、多数なら自分の一時ディレクトリに保存する。既存のタスク記録や保存指定があればそちらに従う。

| 箇所 | 指摘 | 判断 | 理由・対応 |
| --- | --- | --- | --- |
| L12 | 同じ語の反復 | 残す | 製品の正式名を統一している |
| L24 | 長い一文 | 直す | 条件と結果の主語が異なるため二文に分ける |

## 再検査と発散防止

修正後のlintを前回JSONと比較し、新規・継続の指摘を確認する。解消した指摘も、原文の意味を失っていないか差分で確かめる。

指摘にすべて判断が付き、新たな問題がなければ通読する。同じ問題が2周連続で戻るなら、文脈上必要な表現として理由付きで残すか、文・段落の構造を変える。点数や指摘ゼロのために修正を繰り返さない。必要な判断ができなければ不明点を示して止める。

最後に[6観点](eval-rubric.md)で確認する。自分が作った不要な一時ファイルのみ片付け、元文書や保持を求められた記録を残す。
