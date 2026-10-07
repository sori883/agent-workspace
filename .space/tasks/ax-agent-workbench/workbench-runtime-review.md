# Workbench Python Runtimeの独立実装レビュー

2026-10-07、C。基点 `ede929e` と親担当の未commit差分（新規ファイルを含む）。このPythonコードの実装には参加していない。共通PG/descriptor契約の設計とv8実装はCが担当しており、共通契約そのものへの完全独立な評価ではない。同じモデルによる別実装担当のレビューで、モデルの多様性はない。

## 結論

対象範囲に追加のP0–P2必須修正は確認しなかった。読み取り確認を完了した。Runtime内で生成Pythonや登録scriptを実行する入口はなく、定義は封印したJSON参照として扱う。SDKの停止理由を限定的に許容する変更も、追加モデル送信や未知usageの成功扱いには広がっていない。

## 確認した境界

- `workbench_protocol.py:126` 以降でv2要求、mode/profile、descriptor hash、版とroot結合、history16KiB/17件、descriptor40KiB、file/definition集合、code宣言の厳密一致を検査する。旧v1 validatorは変更していない。
- `workbench_runner.py:54` のstageと `:79` のdefinition-chunkは同bytesだけ再生し、欠損・不一致・symlinkを拒否する。`:101` の定義復元は公開size/SHA/canonical bytesとagent→依存の順序を照合する。定義に含まれるscriptのimport/execは行わない。
- `workbench_runner.py:135` のStart、`:186` のexecute、`:237` のadapterはそれぞれflock＋write-once印で単回化している。Start/executeの応答不明を新しい実行許可へ変える経路はない。resultを返す前に子process群を停止し、signal exitを非負へ正規化する。
- `adapters/workbench.py:61` のSDK設定は固定モデル・loopback endpoint、literalの無効な資格情報、tools空、deny_all、subagents無効、retry0。本人の指示・定義をSDK設定や任意commandに変換する処理はない。
- `adapters/workbench.py:101–127` はモデルusage/costを提案の検査とtool ACKより先にreceiptへ保持し、後段失敗でもfinallyで保存する。さらに正本は外側PG operationであり、guest receiptの欠落が費用を0に書き換える根拠にはならない。
- `MAX_MODEL_CALLS_EXCEEDED` 許容はv2だけ。再利用するModelProxyは送信1回を固定し、`gemini_meter.py:42–109` がSTOPと完全なusageを検査する。SDK toolがないこと・proxy request_count=1・使用量一致・有効な提案のすべてが必要で、STOP未完や追加送信を許容しない。
- mailbox共通差分はversion/request/proposal/phase hookだけで、元hash照合・単一seq・同reply再生・denied処理を維持している。v2 raw48,000Bはbase64外枠64KiBに収めるための上限で、大きいprompt/定義を黙って切り捨てず生成前に拒否する。
- `runner.py:285` の待機分岐は保存済みschema_version=2だけ新executeへ渡し、旧v1経路を維持する。

## 証拠と限界

[Runtime検証記録](workbench-runtime-verification.md) の13件、旧SDK24件、PG→Pythonの合成fixture照合を確認した。実測者は親で、Cは追加SDK/Docker/AX/モデル実行をしていない。同記録の最終8ファイルSHA-256は読み取り時のsourceと全件一致した。

Aへ確認したcode runner成功/既知失敗の結果は5fieldすべて0のusage＋費用0で、共有 `validate_result` の成功非NULL条件と整合している。code不明時は結果を作らずholdへ残す契約であり、これはAの申告・別単位の確認事項として扱う。

live AX、Go/PG/Pythonの全実経路、cold start、8 MiB搬送時間、server-owned host cleanup、実モデル費用、ブラウザ結果は本レビューでは未確認。実Actorとgate開放の前提は親の統合検証に残る。v8保存層はC自身の実装なので、この報告では独立レビュー済みとは扱わない。

使用資料はdevlow/review、interrogate/reviewer-prompt、既存のOKF `.space/babel` の検索範囲（agent-runtime/workbench/portable-api-postgresとrules/ax-model-spending）を引き継いだ。今回の読み取りで本体コード・OKF・サービス状態は変更していない。

## 2026-10-08 実AX fixtureの保存証拠照合

実測者は親、Cは保存済み証拠だけを照合した。前節の未確認事項のうち、以下の固定fixtureに限って実AXのRuntime→code→Runtime、成果物搬送、実停止と公開host cleanupの結合を確認できた。DB・AX・モデルをCが再実行したものではない。

| 対象 | 照合した結果 |
| --- | --- |
| probe5 / `9541c376-76a1-47ea-acfa-56db2926c5a1` | CSV/XLSX集計。3runがfinished/done/resolved、root succeeded/revision4。合成model 2・tool 2・Python 1、active 76,441 ms、実費/予約0。保存CSV 42 bytesは `source,total\nsales.csv,300\nsample.xlsx,30\n` と完全一致。保存XLSX 4,883 bytesは結果metadataのSHAと一致し、別のセル検査記録も同じ3行を示す |
| probe6 / `e84bda14-c725-4cfb-826d-7e56bd9c9b54` | 1 file 8,388,608 bytes、入力/出力各256 chunk。両SHAは固定scenarioの `3480e36fd09a0e1fb7fc22645b44a0332ee0c2fd9cd6f62ef44fd76522b708fe` と一致するchecker記録。3run finished/done/resolved、root succeeded/revision4、合成model 2・tool 2・Python 1、active 144,968 ms、実費/予約0 |

両fixtureのseed、run.stdout、result、runtime/code inspectを対応付けた。各3Actorは停止・AX Suspended・egress deny・worker未割当を示し、codeの保存済みhost cleanupとinspectの7fieldは完全一致する。imageは `8485abc6e29320c34a68e0bc79b3db21c01feecf10cc87b0d1ddbc3b27ef1642`、profileは `host-quota-8m-v1`。probe5の同Actor UID `fa02431e-b746-4384-a879-59e9d12e134b` のhost読取りはrootfs mode/UID/GID `700 0 0` を示し、dirfd修正の前提が実配備でも一致した。これを旧probe4の未観測modeへ遡及しない。

元証拠は `ax-local/.state/workbench-build-arg973la/probe5/results-kkiMiV/`、同 `probe5/{seed.json,run.stdout,actual-rootfs-mode.json}`、同 `results-8m-rfUkac/` と `probe6/{seed.json,preflight.json,run.stdout,quarantine.txt}`。親が保存した [恒久的な証拠抜粋](evidence/actual-ax-fixtures.json) の10個のsource SHA、resultの投影、checksの重複除去、inspect、XLSXセルとrootfs観測が原本と一致することも確認した。

**判定:** この範囲に追加の必須指摘はない。probe6の8 MiB原bytesは保存されていないため、Cによる再hashではなく親checkerの実読取り結果との照合である。private getの拒否相手は新規の不存在UUIDで、所属済みBobの認可試験ではない。費用0・`generation_started=false` は合成モデル決定のfixtureを表し、有料モデルの利用成功ではない。probe6のquarantineはtransaction完了の保存ログを確認したが、Cから現在のrole/gate状態を再照会していない。public UI、4件非整列8 MiB、実Actor boundaryはこの追記時点では対象外である。

### 限定trialへ進める条件と試験の再利用

親からの問いに対し、後続の4件非整列8 MiBとboundaryの実Actor証拠が一致することを条件に、資源超過・symlink・host faultの全項目をliveで再注入しないことだけを、今回の監督下の限定trialのブロッカーとはしない。[固定runsc試験](runsc-probe.md) の実効RLIMIT/容量/inode/不正成果物拒否、現版でも不変のsecurity、dirfdのroot700回帰、[失敗時holdと同worker回収](ax-code-recovery-review.md) を再利用できる。現時点で、それらを否定する具体的な未解消不具合は確認していない。

この判断は一般受付・定期自動実行・無人の障害復旧の承認ではない。固定image/profile、既存global slot、費用上限、unknown時の開始/モデル再送禁止と管理者回収を維持し、限定試験で不明状態が出たらそこで停止する。実Actorのcgroup限界、worker急死/再起動、各mount/stop/unmount失敗の網羅的注入は未確認のまま残す。direct runscは`--ignore-cgroups`であり、これらを実証済みと記載しない。

## 2026-10-08 probe7・8の追加照合

親が保存した以下の2fixtureも、seed・run.stdout・result・runtime/code inspect・quarantine.txtの範囲でCが読み取り照合した。本体、DB、AX、モデルの操作はしていない。

| 対象 | 結果と証拠 |
| --- | --- |
| probe7 / `dc3f5217-8b9d-4ef5-94ce-5c095b8279ba` | `copy-8m-4`。4件は1,048,577 / 2,097,155 / 3,145,733 / 2,097,143 bytesで全件chunk非整列、合計8,388,608 bytes。各入力/出力のSHAが固定scenarioと一致し、chunk数33/65/97/64、入力259＋出力259をcheckerが実読取り。active 153,213 ms。`results-8m-wZ5Q85/result.json` SHA `d5322152cbdbef638021e3579b7a4ec4bd623f2103dec6f438d3584dddc3148a` |
| probe8 / `6e9bda18-8328-49ae-9781-30699bb08abb` | `isolation-boundary`。固定15 bytes入力、`boundary.csv` 186 bytes、SHA `6cd526de64285084849bb028668f3906f52a357d03c9f9c1d3d4640db8885d0c` が固定Go literalと一致。checkerは実出力とのbytes一致を記録。active 66,426 ms。`results-boundary-6iKMA5/result.json` SHA `b075b40f3b2f0aa7ba757ebb523799cde588cd5c8f3ef3f3e031c28761a503f4` |

どちらもroot succeeded/revision4、Runtime→Python→Runtimeの3run finished/done/resolved、合成model 2・tool 2・Python 1、費用/予約0、外部生成なし。対応する全Actorの停止・Suspended・deny・未割当をinspectで確認でき、code cleanupはDB保存結果と7field完全一致する。前項と同じcode image `8485abc6…1642`、`host-quota-8m-v1` である。quarantine.txtはtransactionのCOMMITまで記録されており、現在のrole/gate状態をCが再照会した証拠にはしない。全ファイルは前項と同じprivate buildroot配下で、seed/run/quarantineはそれぞれ `probe7/`、`probe8/` にある。

boundaryの観測は固定コードのassertに限る。非root UID/GID、socket生成・fork/thread/exec・親操作・特権変更の拒否、親の私有path非到達、入力/library書込み拒否、FD 3–63不在、入力不変を示す期待出力である。capability全set=0とNNP=1の値をguestから独立に再計測したものではなく、その検査はtrusted bootstrapに依存する。出力CSVをserver-owned停止証拠の代わりにはしていない。

**判定:** 2fixtureに追加の矛盾・必須修正はなく、前項の限定trialに必要とした4file/boundaryの保存証拠条件を満たす。原bytes未保存のためCが実入出力を再hashしたとは言わず、不存在UUIDによるprivate拒否、有料モデル未実施、cgroup/網羅的host障害未確認の限界は維持する。通常controllerへの復帰、旧v1回帰、public UIからの有料試験は別工程で、本追記の合格へ含めない。追記時点の恒久抜粋はprobe5・6までであり、probe7・8は上記原本とSHAを根拠とする。

## 2026-10-08 有料試験1後のprompt・固定skill修正

対象はAの `adapters/workbench.py` のsystem指示とskill SHA、`skills/tabular-v1/SKILL.md`、追加SDK試験2件だけ。旧fa9 imageから抽出された2ファイルのSHAが初版記録 `60dea975…` / `9243609c…` と一致し、adapterのASTは `SYSTEM_INSTRUCTIONS` と `SKILL_SHA256` を除いて同一だった。protocol/runner/mailbox各SHAも旧記録と一致する。

[有料試験1](evidence/paid-trial1.json) の5原本SHAと保存内容を照合した。root `a1779b3b-e299-4e68-b04a-c8d1006aedd8` はmodel 1/tool 1/Python 0で質問待ちとなり、集計は不成立。既知費用0.0004405 USD、過去込み0.0046665 USDを残し、helperの開始は1回・回答/再送なし。親の通常UI停止1回、最終stopped/未解決0、gateway/trial閉・鍵mountなしという記録を確認した。Cは課金試験や停止を実行していない。

修正は、添付ファイルで確認できる列・encoding・値をPythonで調べること、Runtimeは別Taskへの提案役であること、表示名でなくaliasを使うことを明示する。調査だけでも小さな宣言済みreportとstdoutを作る指示は、既存の出力1件以上の契約に合う。成功後は `python_result` のstdoutと封印済みfile参照を読み、purpose/ACKを成功と誤認しない。SQLの既存descriptor/checkpoint生成とも整合する。利用者しか決められない為替・集計規則などはquestionを保持し、kindの自動書換え・疑問符判定・強制Python実行は加えていない。allowed_tools、予算、再送、usage保存、ACK順序の処理は変わらない。

最終SHAはadapter `3390a5df665ae44428a101fc2c020c2a6beeeac1bcc54ea14135af28b23004fb`、skill `47c67805bf384f4051ad2c7392ef9e18b194dc611c1133775646e5e8f50313d5`、test `dda2d36f5cc31ac284dd10f3b4cc4fae1b210b5d7f16388549eea76e76f2416b`。skillは2726 bytesで読取り上限と固定hashが一致する。追加試験はfile metadata/alias→固定Python提案→別runの合成成功履歴/成果物→完了、および必要質問・未信頼previewのuser-data保持を検査している。SDK/mailboxの回帰証拠であり、実モデルの提案選択やprompt injection耐性の実証ではない。

作者のソースmount版15件/4.763秒の記録に加え、親の新image `sha256:745e2f4527f80c0fe64a7d292514357444ab27f7f3ccbf9116dc36ea2a0815de` の保存build metadata、source mountなし15件/9.136秒・skipなしログ、全16 task_runtimeファイル一致記録を確認し、記録の各SHAが現在sourceと一致した。根拠はprivate buildrootの `runtime-inspect-{build.json,tests.stderr,source-match.json}`。CはimageやSDK試験を再実行していない。

**判定:** 限定修正に追加P0–P2指摘なし。親の配備・既承認範囲の次の限定trialへ引き渡し可能。旧指示の曖昧さを狭める妥当な変更だが、実モデルが次回Pythonを選び集計を完了することは未確認である。質問/失敗/未知時の再送禁止を維持し、成功と費用・停止の実結果は後続証拠で別に判定する。

## 有料試験2の実要求からの限定診断

親から、745e2 imageでもroot `ace6d772-46bc-4506-928f-97e739a55ed0` がPython実行前に「入力が空/amountなし」とする質問へ進み、機能未達だったと報告を受けた。今回Cは `ax-local/.state/workbench-build-arg973la/public-v8/trial2-model-request.json` と `execution/gateway/{workbench,model}.go` を読み取り確認した。試験の再送・DB照会・課金操作はしていない。

実mailbox bodyには `input_1`、15 bytes、既知のsales CSV SHA、`allowed_tools=[python]`、skill `47c67805…`、amount集計とsummary.csv作成の依頼が存在する。更新system/skillも含まれている。ファイルのmetadataやPython許可がモデル要求から落ちた形跡はない。Gatewayのv2 schemaはpython提案の枝を含む。SDK bodyのmaxOutputTokens=65535は `prepareMailbox` が512へ置き換え、toolConfig/sessionIdもprovider payloadへ採用しないため、そのbody値を予算逸脱やPython禁止と解釈しない。provider payload SHAの実照合はBの別担当範囲とし、Cは重複実施していない。

具体的な指示矛盾として、SDKの自動system wrapperはMarkdown形式、全fileへのリンク、`/workspace/task/output`へのコード配置、利用者は応答不可という規則を付け、その内側にJSON-onlyの提案、別Taskの`/input/<alias>`と`/output`、必要な利用者質問を許す専用規則が並存している。これが今回の質問を引き起こしたと断定はできないが、両方を満たせない形式・実行環境の説明を送っていることは保存要求から確認できる。schemaのanyOf順序だけが質問を強制したという証拠はない。

次の最小改善は、v2のSDK公式設定または狭いhookで自動wrapperを外し、実providerのsystem/contentsを専用planner契約へ一本化すること。まず無課金fixtureで、不要なSDK章がないこと、実metadata/履歴/固定skillが欠落しないこと、モデル1回・usage保存・既存schema/512上限が維持されることをwireで検査する。質問をPythonへ自動変換するheuristic、入力を読んだと偽る応答、同じrootの再送は解決案に含めない。この診断は追加試験の成功ではなく、次の変更候補とその検証条件である。

### 公開SDK APIによるsystem全置換の再レビュー

対象adapter SHA `4a3fb55c970c97972e9ebfa181e189d84060e3b0074a826526170b41e4d1e198`、test SHA `fb85cd8cff9fe68b0d9d37a853c22bc0b85ae17a0ac2813ba85ea39582979d45`。`make_config` に `CustomSystemInstructions` のimportと `system_instructions=CustomSystemInstructions(text=...)` を加えた2行を逆変換すると、直前745版のSHA `3390a5df…` と完全一致した。固定skill SHA `47c67805…`、system文言、予算、tools/subagent拒否、usage・ACK、v1の処理は変更していない。

新テストは実SDKからmailboxへ渡った `systemInstruction.parts` 全文を `<System>\n`＋専用指示＋改行＋skill＋`\n</System>` だけへ完全一致させる。期待bytesは5233、SHA `2c8f7b25947af2e72fa9c273ef9876f4a38d44073b2fbdf8ea4097fa397880a6` でCの再計算も一致した。functionsの許可を広げずtoolConfig NONE/tools空も検査するため、単にPython定数を比較する試験ではない。作者の[再現・検証記録](workbench-runtime-verification.md)では旧str版が1件失敗0.839秒、変更後の通信なし固定SDK16件が5.695秒・skipなしで成功している。Cはsourceと記録を照合し、SDKの再実行はしていない。

Bから、trial2の元request bytesを現 `PrepareWorkbench` に渡して保存provider payload SHA `7ae7bf32016c22462bb626ab3e6d65eb3e67f7d018c4f4ac521066ea4f8af225`（9173 bytes、v2/python枝、maxOutput512）を再現したと報告を受けた。当該送信に古いv1 schemaが使われたという仮説はこの別担当の照合で否定される。C自身がそのGo試験を実行したとは扱わない。

**判定:** この限定差分に追加の必須指摘なし。既存SDKの公開完全置換APIで実在する指示競合を除く変更として、親の正式image照合と次の限定trialへ引き渡せる。これは実モデルの選択改善や問題の唯一因果を証明するものではなく、生成Pythonによる集計成功は引き続き未確認である。

### 有料試験3後のschema順序仮説

親報告では、system全置換版9ebの第3試験もPython 0で「調査・計算を行う」というoutputを返し、機能未達。model 1、過去込み0.00560225 USD、gateを閉じた状態である。この時点で指示競合を除いたことを集計成功へ読み替えない。

Cは現 `workbenchResponseSchema` と[Google公式のGenerate Content structured output仕様](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en)を確認した。公式仕様はschemaのキー順に沿った出力と3.1 Flash-Liteの対応を説明する。現Go mapのシリアライズではtext枝のpropertiesが `kind,text`、Python枝が `input_aliases,kind,outputs,purpose,source` となる一方、専用指示の例はどちらもkind先頭である。この非対称はコード上確認できる。

順序付き生成がkindキーを先に選ぶことでtext枝へ狭まる、という説明は検証可能な仮説だが、provider内部の枝選択や今回の唯一原因を示す証拠はない。両枝のpropertiesをkind先頭へそろえる最小変更は妥当と判断する。修正の確認条件は、旧schemaとのparse後完全等価（型・enum・必須項目・追加field禁止・各上限を維持）、実 `PrepareWorkbench` payload中の順序保持、既存v1とcount/generate共通payloadの不変である。question/outputの削除、Pythonへの強制変換、失敗rootの再送は必要ない。実装の最終レビューと実モデルの再確認は別に扱う。
