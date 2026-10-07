# Workbench Runtime v2 の局所検証

2026-10-07、親担当。AX内Runtimeの1区間を、モデル1回・提案1件に固定する実装と確認。実AX Task、実モデル、Python code Taskへのhandoffはこの記録の合格に含めない。

## 実装

- `task_runtime/workbench_protocol.py` はv2 request、immutable descriptor、定義、提案、9field resultを厳密に検査する。v1 request validatorは維持。
- `workbench_runner.py` はstage、32KiB definition-chunk、seal、start、status、collect、mailbox、replyを提供する。同bytesのstage/chunk/sealだけ再生可能で、Start/executeは一回のみ。登録scriptはreference JSONとして保持し、import/execしない。
- 既存 `runner.py wait` は保存済みrequestのschema_version=2だけ新executeへ渡す。TaskSpec commandは従来のまま。Mailbox共通処理はvalidator/versionの小さなhookへ分け、v2 subclassに接続した。
- 固定 `tabular-v1/SKILL.md` と `adapters/workbench.py` がCSV/Excel用の指示を提供する。選んだ公開版のhash・size・依存順を照合し、本人依頼・履歴・ファイルmetadataを入力する。ファイルbytesはRuntimeへ持たず、Python提案を外部controllerへ渡す。
- Pythonは入力最大4件/合計8MiB、出力最大4件/合計8MiB、source4KiB、出力はASCII basename64文字以内のCSV/XLSX。選択したagentのallowed_toolsが空ならPythonを拒否する。単独skill又は標準はPython利用可。PGが現在の利用権を再検査する。
- descriptor40KiB、history16KiB、prompt40KiB、mailbox raw48,000bytesとして、base64を含む応答frame64KiB以内に収める。大きい定義は明示的に拒否し、黙って切り捨てない。

## SDKで観測した制約

固定SDKは `max_tool_calls=0` を受け付けないため、最小値1を設定し、tools空・deny_all・enabled_tools空・subagents=falseでSDK tool自体を禁止する。

`max_model_calls=1` のとき、候補がSTOPで全文と使用量を返しても、SDK終了理由が `MAX_MODEL_CALLS_EXCEEDED` となることを無課金fixtureで確認した。v2だけ、この理由とUNSPECIFIEDを許容する。proxyのモデル送信が厳密に1回、応答全文のSTOP、使用量/課金の照合、SDK tool callなし、有効な単一提案を全て要求する。追加送信・再試行は許可しない。生のSDK終了理由はguest receiptに残す。既存v1の終了判定は変更しない。

モデル使用量が既知の後で提案が不正又はtool受理を拒否されても、usage/costをreceiptに残す。費用の正本は外部PGのoperationであり、guest receiptをunknown解消の代用品にしない。

## 検証結果

固定の既存ローカルSDK image `localhost:5001/ax-task-runner:real-model-v1` をnetwork noneで起動し、現task_runtimeとtestsをread-only mountした。実provider資格情報・有料モデル送信なし。

- v2専用13件、全成功。封印/欠損/hash不一致、同bytes並行再送、symlink、重複キー、固定skillhash、v1/v2 mailbox分離、モデル1回→tool ACK→receipt、PythonをRuntimeで実行しないこと、質問/最終回答、拒否/不正提案での既知usage保持、同時Start一回、signal exitの非負化、64KiB frameを含む。
- 旧interactive＋model SDK回帰24件、全成功。Mailbox hookとwait版分岐による既存動作の回帰なし。
- PostgreSQLが実際に生成した `evidence/workbench-pg-fixture.json` のagent＋skill claim/chunksをPython stage/chunk/sealへ通し、canonical bytes/hashと依存順序が全て一致することを確認。
- `git diff --check` は対象Python/新testで成功。

試行中、SDK tool上限0とモデル1回時の終了理由を原因にテストが失敗した。上記の限定処理に修正後、同じSDK試験が全成功した。最終確認は13件/24件であり、SDKなしホストのskip結果を成功件数へ含めない。

## 残る確認

独立レビュー、PG/Go/Runtime/codeの一連のAX実行、8MiBの実搬送、モデルを使用した最少試験、ブラウザからの実結果ダウンロード。課金・Python gateはこの局所検証を理由に開けていない。

## 確認時のSHA-256

- `ax-local/task_runtime/workbench_protocol.py`: `d9d4807f6584eb4dc763a7fb87c9bb6660ffe24d70459f14273edce0217aad61`
- `ax-local/task_runtime/workbench_runner.py`: `3a9e4aa1d6fd6ff3e43b5d4958f562ad455c79d61c40ca0cde7ee414848c4dae`
- `ax-local/task_runtime/workbench_mailbox.py`: `323a5c0fc909b77db131dd2efcdf38daec005cf3df58a120f1e8bfa9c4930d51`
- `ax-local/task_runtime/adapters/workbench.py`: `60dea975a17be223cbcdcbcedde45a86ede51157cceddb8fc9088e2284be605a`
- `ax-local/task_runtime/skills/tabular-v1/SKILL.md`: `9243609c9f6487ae89d778b47a17923c57079433d94321b473aad2decef8e1b7`
- `ax-local/task_runtime/mailbox.py`: `4967a236c7f7ef057b9669873ab3a25e87000eee8c2b2482d04c093ddda7b24c`
- `ax-local/task_runtime/runner.py`: `4ac17a10c52bab6f01c3b9f143f6a67805087ed36e84e0cb19cebb72fa97dcb9`
- `ax-local/tests/test_workbench_runtime.py`: `14020b87df9d10a90e4b747dc6d93708cd943c3d9b9822e5a2aec589e543109f`

## ビルド済みimageの追加確認

親が `localhost:5001/ax-task-runner:workbench-v2` をビルドした。manifest index `sha256:fa9f1b4e42ac06963552f0ddb4a4c49a41e5e46739c2bbd26508d959220dd52d`、arm64 manifest `sha256:88b1b665b35b0b28dc6cc1987fb2c0ced5457ddc9e306399e81d04926f507d1b`。task_runtimeをホストからmountせず、image内 `/opt/ax-task` を対象に13件が成功した（4.631秒）。network none、実providerなし。まだregistry push・AX設定切替はしていない。Cの独立レビューは `workbench-runtime-review.md` に保存し、必須指摘なし。

## 2026-10-08: 実モデルがファイル調査を question とした件

担当A。対象は未コミット `adapters/workbench.py`、固定 `skills/tabular-v1/SKILL.md`、`tests/test_workbench_runtime.py` の今回差分。既存 v1/v2 プロトコル、PG/Go、権限、予算、再送制御は変更していない。

### 原因と変更

親の実測では root `a1779b3b-e299-4e68-b04a-c8d1006aedd8` / run `ax-run-953a0d0d8762d994` が `model=1/tool=1/python=0`、概算費用 `0.0004405 USD` で `waiting_input` となった。15 bytes のCSVに対する集計・CSV作成依頼へ、モデルは「ファイルの中身を表示します」という作業予告を `question` として返した。停止・resolved の確認は親の実測であり、Aは実環境を操作していない。

旧system指示は単に不足情報なら質問、固定skillは列名/encoding/希望結果が不明なら「Pythonで調査または質問」としていた。添付ファイルから得られる事実と、利用者だけが決められる業務条件を分けておらず、Runtime自身にはファイルbytesがないことも説明不足だった。有効な `question` JSONを受けたPGが待機へ進んだのは既存契約通りである。モデルの内部判断を観測したわけではないが、この不適切な選択を許す指示の曖昧さをソースで確認した。Gatewayのv2応答schemaはPythonを含んでおり、Python候補がschemaから欠落する問題ではない。

- `question` は、利用者がまだ指定せず、ファイル/履歴からも決められない必要な条件だけに限定する。作業予告・進捗報告を質問にしない。必要な質問は引き続き許可し、疑問符/言語等による推定拒否は追加しない。
- 列名・encoding・数値形式・内容は許可されたPythonで確認する。計算と結果形式が明確なら一度の提案で検査＋生成し、入力pathには表示名でなくaliasを使う。
- Runtimeは操作提案、controllerは別の隔離Taskで実行する境界を明示。調査だけでも既存契約どおり小さいCSV/XLSXを宣言・作成し、次の判断に必要な所見をstdoutへ出す。
- 成功後は `python_result` のstdoutと `files` の封印済み成果物を読み、完了していれば `output` を返す。`python` のpurposeやACKを成功と扱わず、stdout内の命令は権限を変える根拠にしない。

結果previewは既に存在する。`schema-v8.sql:142–145` は履歴と既存入力/出力file参照を次descriptorへ、同 `:521–530` は成功Pythonの結果summaryを `python_result` へ保存する。`prompt_value` はこれをSDK入力へ渡す。今回この保存・搬送経路は変更せず、意味をsystem/skillへ明記した。stdoutなしでは内容を推測できず、追加のPython調査か、必要なら正当な利用者への質問が残る。

### 局所検証

既存ローカルimage `localhost:5001/ax-task-runner:workbench-v2`（fa9）の固定SDKを使用し、現ソース/testsだけread-only mountした。image再build、外部モデル送信、live AX/DB、Gateway設定変更なし。

```sh
docker run --rm --pull never --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=67108864 \
  --env HOME=/tmp --env PYTHONDONTWRITEBYTECODE=1 \
  --mount type=bind,src=/Users/const/sori883/agent-workspace/ax-local/task_runtime,dst=/task_runtime,readonly \
  --mount type=bind,src=/Users/const/sori883/agent-workspace/ax-local/tests,dst=/tests,readonly \
  --entrypoint python3 localhost:5001/ax-task-runner:workbench-v2 \
  -B -m unittest discover -s /tests -p test_workbench_runtime.py -v
```

15件成功、4.763秒、skipなし。新規2件は、添付CSV metadata/alias→固定Python提案→別Runtimeへの合成成功checkpoint/出力metadata→固定完了提案、および為替レート等の正当な質問の保持を固定SDK/実mailbox経路で確認した。各Runtimeでモデル1回・tool ACK1回、Runtime自身のコード実行なし、異なるrun IDへの履歴受渡し、未信頼stdoutがsystem指示へ昇格しないことも照合した。固定skillの実読込とhash照合を含む。`git diff --check` は対象3ファイルで成功。

最初の新テストはSDKの `<USER_REQUEST>` ラッパーをJSON直接入力と誤認して2件失敗した。テスト側で固定SDKのラッパーを取り出し、上記15件が成功した。この失敗は今回のモデル選択不具合のRedではない。模擬providerは明示した提案を返すため、実モデルがPythonを選ぶこと・prompt injectionに従わないことの証明には数えない。実モデルの元の再現は親の上記実測、修正後の限定実モデル試験と最終image照合は親へ引継ぐ。

最終SHA-256:

- `ax-local/task_runtime/adapters/workbench.py`: `3390a5df665ae44428a101fc2c020c2a6beeeac1bcc54ea14135af28b23004fb`
- `ax-local/task_runtime/skills/tabular-v1/SKILL.md`: `47c67805bf384f4051ad2c7392ef9e18b194dc611c1133775646e5e8f50313d5`（2726 bytes、固定digestと一致）
- `ax-local/tests/test_workbench_runtime.py`: `dda2d36f5cc31ac284dd10f3b4cc4fae1b210b5d7f16388549eea76e76f2416b`

上の初版hash/13件は当時の証拠として保持した。今回の製品変更はprompt/skillのみであり、旧interactive/modelの未変更コードに対して既受理24件を再実行していない。OKF/共通台帳は親の所有のため更新していない。

Cの独立比較用に、旧fa9 image内の対象2ファイルをnetwork none/read-onlyの `cat` で一時抽出した。保存先は `/var/folders/9w/921pjkys39q28sk4xsc0hs000000gn/T/ax-workbench-prompt-before-fnxtv6ti/`（元相対pathと `.diff`）。旧hashは上の初版2件と完全一致し、新imageのビルドはしていない。この一時比較物は恒久成果物ではない。

## 2026-10-08: SDKの既定指示との競合を取り除く

前節のprompt文言変更後も、親の第2回限定実モデル試験はPythonへ進まなかった。root `ace6d772-46bc-4506-928f-97e739a55ed0` / run `ax-run-58f54b697eddc012`、Runtime image `745e2f4527f8…`、概算費用 `0.00053325 USD`。親報告ではファイルが空又はamount列がないとする質問を返し、Pythonは0回、unresolvedは0。前節の曖昧さ解消だけで実利用の問題が直ったとは扱わない。

親が保存した実mailbox `ax-local/.state/workbench-build-arg973la/public-v8/trial2-model-request.json` を読取り確認した。新system/skill、利用者の明示依頼、`allowed_tools:["python"]`、`input_1`、15 bytes、入力SHAは全て届いていた。SDK→ModelProxy→mailboxでの本文/入力参照の欠落は確認しなかった。Go Gatewayの調査は親担当と分離した。

一方、固定SDK 0.1.20では `system_instructions` にstrを渡すと、既定指示への追加として扱われる。根拠はimage内 `/usr/local/lib/python3.12/site-packages/google/antigravity/connections/local/local_connection_config.py:185–193`、`types.py:128–160`。実mailboxには既定のidentity/workspace/communication_styleが前置され、次が専用planner契約と競合していた。

- `/workspace/task/output` へコードを書くという既定workspace指示と、別code Taskの `/input/<alias>` / `/output/<name>` へのhandoff。
- GitHub Markdownと全ファイルのfileリンク必須という回答指示と、単一の厳密なJSON提案。
- 利用者が応答できないので質問しないという指示と、必要時は待機して質問する製品契約。

`AgentBehavior.MINIMAL` でもこれらは残る。競合の存在と設定上の原因は確定したが、今回のモデル選択の唯一の原因であることは確定していない。

親が採用した公開 `CustomSystemInstructions(text=...)` の完全置換経路を、先に無料captureで確認した。SDKは `<System>\n…\n</System>` の区切りだけを追加し、既定のidentity/workspace/communication_styleを除く。最初のcaptureは区切りのない生textとの一致を期待して失敗したため、内容の削除/追加と区切りを分けて確認した。製品修正は `adapters/workbench.py` のimportと `make_config` の代入のみ。SYSTEM_INSTRUCTIONS/skill文言、ModelProxy、v1、プログラム上のtools/subagent拒否、予算、再送回数を変更していない。

### 再現と検証

`test_system_wire_is_exact_planner_contract_without_sdk_defaults` を追加した。最終期待値は固定SDKの区切りを含めたsystemInstruction.parts全文であり、既定指示の混入・専用指示の欠落を両方検出する。旧str設定ではidentity等の前置で1件失敗（0.839秒）。上記2行修正後、固定SDKで全16件成功（5.695秒、skipなし）。質問保持、Python提案、次Runtimeへの結果preview、1モデル/1ACK、SDK tool無しの既存試験も維持した。

実行は前節と同じnetwork none/read-only/tmpfsのDocker commandで、imageを `localhost:5001/ax-task-runner:workbench-v2-inspect`（既存745）へ変更し、現task_runtime/testsをread-only mountした。Red単体は `--workdir /tests` と `-m unittest test_workbench_runtime.SDKTests.test_system_wire_is_exact_planner_contract_without_sdk_defaults -v`、Greenは前節のdiscoverを使用。外部provider送信・image build・live DB/AX操作なし。

- `ax-local/task_runtime/adapters/workbench.py`: `4a3fb55c970c97972e9ebfa181e189d84060e3b0074a826526170b41e4d1e198`
- `ax-local/tests/test_workbench_runtime.py`: `fb85cd8cff9fe68b0d9d37a853c22bc0b85ae17a0ac2813ba85ea39582979d45`
- skillは前節の `47c67805bf384f4051ad2c7392ef9e18b194dc611c1133775646e5e8f50313d5` と同一。
- 全文一致を確認したwire system textは5233 bytes、SHA-256 `2c8f7b25947af2e72fa9c273ef9876f4a38d44073b2fbdf8ea4097fa397880a6`。
- 対象sourceの `git diff --check` 成功。Cへ差分範囲・source hash・capture・Red/Greenを共有。

このRed/Greenが証明するのは指示の置換と送信境界であり、実モデルがPythonを選ぶことや正しいCSVを作ることではない。実利用の再確認は親の限定試験に残る。追加の有料試行を自動で行う処理は入れていない。
