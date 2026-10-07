# Workbench Gatewayのschema順序レビュー

2026-10-08、C。Bが変更した `execution/gateway/workbench.go` と関係試験の限定独立レビュー。CはこのGo差分の作者ではないが、v8 PG/共通契約の作者であり、同じモデルによる別担当レビューである。実モデル・AX・DB・配備操作は実施していない。本記録のみを編集し、受理済みRuntimeレビューには追記しない。

## 結論

製品SHA `97810e232e1e464cf2295ceb34fb6e387109c909ba3953cd32cfce22625f0d60` に追加P0–P2指摘なし。schemaの意味・上限を変えず、両候補のpropertiesをkind先頭へそろえる変更として妥当。最終試験版も確認済みで、親の配備・既承認内の限定試験へ引き渡せる。実モデルの選択改善や、過去3試験の唯一原因を確定したとは扱わない。

## 仮説の根拠と限界

[Google公式のGenerate Content structured output仕様](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en)はschemaのキー順に沿う出力とGemini 3.1 Flash-Liteの対応を説明する。旧Go mapのpropertiesはtext枝が `kind,text`、Python枝が `input_aliases,kind,outputs,purpose,source` となり、専用promptのkind先頭の例と非対称だった。順序を制約する生成過程でkindキーの選択がtext枝に偏るという説明は妥当な仮説だが、provider内部の枝選択を直接観測したものではない。

親報告の第3試験はPython 0で調査・計算の予告をoutputにし、集計未達、過去込み0.00560225 USDだった。system全置換済みでも未達だった事実を保持し、今回の局所試験を有料試験の成功へ読み替えない。

## 確認した差分

- `workbenchResponseSchema` のpropertiesだけをGo structへ変え、textは `kind,text`、Pythonは `kind,source,input_aliases,outputs,purpose` の順でJSON化する。anyOfの2枝とenum、required、additionalProperties、source4096、input4件、output1–4件/各8388608、text/purpose2048は変わらない。
- `TestWorkbenchWireSchemaChoosesKindBeforeBranchSpecificFields` は実 `PrepareWorkbench` の送信payloadからRawMessageのキーを順に読み、後段のmap化で順序が失われる場合も検出する。旧版のmap順はこの条件を満たさない。
- `TestWorkbenchSchemaOrderChangePreservesAllowedShapesAndLimits` は旧schema literalと新payloadをparseして完全一致させる。旧literalも修正前の関数と照合した。question/output/unsupportedはそのまま許可し、Pythonだけの強制選択や提案の自動書換えは行わない。
- 共通 `model.go` の上限・送信処理は変更対象外。v2はinput6000/output512、v1の厳しい上限を維持する。controllerは同じPreparedをCountとGenerateへ渡し、CountはgenerationConfigをRawMessageのままwrapperへ格納、Generateは元Payloadをそのまま送る。保存SHA・生成直前認可・費用台帳・retry禁止は変えない。

## Cの局所確認

製品SHA `97810e23…`、その時点のtest SHA `ac11929ac5da5b02fc4ed956d272031e75f5f5617ac70c1e3263ad05b7b8144c` で、`go test -race ./gateway -count=1` が1.513秒で成功、`go vet ./gateway` も成功した。ネットワーク先は既存局所fixtureのみで、provider・DB・AXへ接続していない。後続のBの変更はHTTP回帰試験追加のみで、製品版は固定と報告を受けた。

今回の合格はキー順の整合・schema等価・局所回帰までである。実GeminiがPythonを選び、生成コードが計算し、成果物を返すことは後続の限定試験で別に確認する。失敗/質問/未知時に同じ実行を再送する許可は増やさない。

## 最終試験版の照合

最終test SHA `9b2a98a87c5414f35d2c67c3edf76e17d79e63929f695c850cd8101303e18aa2`、製品SHAは上記のまま。repository rootから2ファイルのpath順SHA行を連結したsnapshotは `0f61c838feb06e876c09371b44d1a677877e9e34e1ba66a6c82e196759569eca` で、Cの再計算も作者報告と一致した。

追加 `TestWorkbenchOrderedPayloadIsIdenticalForCountAndGenerate` はlocalhost HTTP fixtureで、countTokensのwrapperから追加model fieldだけを除いたbytes、Prepared.Payload、生成HTTP body、保存evidence SHAの同一性を検査する。呼出しはcount/生成の各1回だけで、再送も検出する。Cもこの最終追加試験を `go test -race ./gateway -run '^TestWorkbenchOrderedPayloadIsIdenticalForCountAndGenerate$' -count=1` で実行し、1.502秒で成功した。

作者Bは旧版の実wire順 `[input_aliases kind outputs purpose source]` でRed、3追加回帰を含む最終Gateway 12 top-level試験/raceが1.525秒・vet/diff確認成功と報告した。既存v1 HTTPも同suiteに含む。Cは前段の全Gateway局所実行と、最終版の追加1件を分けて記録する。製品差分に追加の必須修正はない。
