# orch CLI

## 起動と共通入力

必要環境はBun 1.4.2以上とスキルのscriptsへの書き込み権限。CLIの配置は実際に読み込んだスキルを基準にする。以下の`orch`は`bun <このスキル>/scripts/task.ts`の略記で、グローバルコマンドのインストールを前提にしない。

```text
orch --store <台帳の場所> --json status
orch --store <台帳の場所> --actor <役割ID> --session <セッションID> \
  --operation-id <操作ID> --if-version <現在のversion> --attempt <現在のattempt> \
  --input <JSONファイルまたは-> unit start <unit-id>
```

`--store`は`ORCH_STORE`でも指定できる。JSONの`--input -`は標準入力。入力ファイルをunitの成果物として保存する必要はない。`--json`は一行のJSON、通常出力は整形したJSON。問い合わせで一覧を省略しない。

更新前に`unit get`でversion・currentAttemptを読む。actorは役割を識別する名前、sessionは実行中の担当を識別する名前。担当交代でsessionを使い回さない。

台帳更新にはoperation-idを必須とする。同じ操作の応答が不明なときは、IDと全引数を変えずに再送する。保存済みなら当時の結果と`replayed: true`を返す。内容を変える場合は読み直して別のIDを使う。ロック競合を含む失敗を無条件で成功と扱わない。

## 登録する内容

`init --project <利用先>`は空の台帳を明示的に初期化する。actor・sessionを最初の統括担当として登録する。再実行は既存の内容を保持し、別プロジェクトや別の統括担当へ上書きしない。

`unit add <id>`へ渡す小規模なレビューunitの例：

```json
{
  "size": "small",
  "purpose": "変更の指摘と確認限界を報告する",
  "owner": { "actor": "reviewer", "session": "reviewer-1" },
  "scope": ["src/example.tsを読み取る"],
  "conditions": [
    { "id": "report", "description": "指摘・根拠・限界を報告した", "purpose": "delivery", "required": true, "allowed": ["pass"], "target": "report" },
    { "id": "quality", "description": "対象が期待する挙動を満たす", "purpose": "assessment", "required": false, "allowed": ["pass"], "target": "source" }
  ],
  "stages": { "review": { "selection": "execute", "reason": "レビューのみの依頼" } }
}
```

| 項目 | 内容 |
| --- | --- |
| `parent` | 親unit ID。省略するとルートunit。登録後に付け替えない |
| `size` | small・standard・large |
| `purpose`・`scope` | 目的と担当範囲。scopeは空でない文字列配列 |
| `owner`・`recorder`・`verifiers` | 作業・記録・確認担当のactor/session。recorder省略時はowner、verifiers省略時は空配列 |
| `taskRef`・`planRef` | 既存文書への参照。standard以上はtaskRef、largeはplanRefも必要。CLIは本文を作らない |
| `conditions` | 一意のID、description、purpose（delivery／assessment）、required、allowed（省略時pass）、target ID。必須条件を一つ以上持つ |
| `contractFiles` | 開始前提となる文書の配列。内容のハッシュを保存。進捗で書き換えるtask.md全体を機械的に含めない |
| `track` | 任意の作業分類 |
| `stages` | 工程名をキーに、selectionとreason。必要な工程を明示する |

条件本文は台帳に置く。外部文書を条件の根拠に使う場合はcontractFilesでも版を固定する。変更時は親が`unit update`で条件・根拠を更新する。

## unitと状態の操作

全ての`unit`更新（add以外）とdependency更新は現在の`--if-version`を必要とする。子のstart・set・stage・submit・reopenとledger record・inbox pushは`--attempt`も必要。入力JSONの未知の項目は拒否する。

| コマンド | 入力JSON・役割 |
| --- | --- |
| `unit get <id>` | 現在のunitとstatus（条件別判定・受け入れ・前提不足）。`--history`で確認記録・提出・通知・更新操作の履歴も取得 |
| `unit list`・`unit counts` | `--parent`（子孫を含む）、`--state`、`--owner`、`--track`で絞り込み |
| `unit ready` | 同じ絞り込みでreadyと不足を表示。pausedや手動確認待ちは自動着手候補にしない |
| `unit update <id>` | 親がreasonと変更項目（purpose・scope・track・size・taskRef・planRef・contractFiles・conditions・exclusions）を渡す。実行中は先に中断する |
| `unit assign <id>` | 親がreason、owner・recorder・verifiersの変更と`handoff.stoppedRef`を渡す。recorder省略時にownerを変えるとrecorderも変更。新試行へ切り替える |
| `unit start <id>` | 記録担当が開始・再開。waitingからの再開は`resumeRef`に再開条件を確認した根拠を渡す |
| `unit set <id>` | 記録担当がstate（waiting・paused・cancelled）、reason、任意のnextを記録 |
| `unit stage <id> <工程>` | selection・reason・state・任意のrefs。省略した工程はstate=not-applicable、他はpending等の進行状態 |
| `unit reopen <id>` | reasonを渡してcompleted・paused・waiting・cancelledから新試行へ。cancelledからは親の範囲確認を示すscopeRefも必要 |
| `unit submit <id>` | checks（確認記録ID配列）、report（報告本文）、任意のrefs。完了状態と通知を同時に保存 |
| `unit accept <id>` | 親がsubmissionとreasonを指定し、提出の現在性と終了条件を照合して受け入れる |
| `unit return <id>` | 親がsubmissionとreasonを指定して差し戻す。子の状態はcompletedのまま。子がreopenしてやり直す |

工程名はintake・investigate・design・plan・implement・verify・review・deliver。selectionはexecute（実施）・integrate（統合）・reuse（再利用の確認）・omit（省略）。省略以外の選択工程がcompletedになるまでsubmitできない。

親のないルートunitのaccept・returnは統括担当が行う。統括担当自身が作業した場合も、submit後に成果物を照合してacceptし、自分宛ての完了通知を処理する。この確認は独立したレビューとは別に扱う。

通常のstartは同じ契約・入力版でのみ再開できる。変わっていたらreopenが必要。契約変更や再割当が試行を切り替えた場合は、返された新しいattemptを使う。新試行に旧確認記録を自動移行しない。

exclusionsは`[{"unit":"中止した子ID","reason":"元の条件を扱う場所と除外理由"}]`。親の全体条件を見直した場合にだけ使う。必須の子を中止しただけでは親を完了できない。

## 依存と確認記録

`dependency add <後続>`はon（先行unit）、reason、任意のchecksを受け取る。checksは`[{"condition":"条件ID","verdict":"pass"}]`の形。省略時も先行unitの現在有効な受け入れが必要。`dependency remove`はonとreasonを受け取る。親子の完了待ちを含む循環は拒否する。

`ledger record <unit>`の入力例：

```json
{
  "condition": "report",
  "verdict": "pass",
  "target": { "id": "report", "kind": "files", "files": [".space/tasks/example/review.md"] },
  "evidence": [".space/tasks/example/evidence/check.txt"],
  "method": "指摘の根拠と報告内容を照合",
  "environment": "作業中のチェックアウト",
  "observedAt": "2026-09-23T10:00:00Z"
}
```

実際に確認した日時を使う。上例の日時やファイルを実施済みの証拠として流用しない。

- target.idは条件のtargetと一致させる。filesは明示したローカルファイル群のハッシュをCLIが取得する。指定した範囲だけの版であり、リポジトリ全体の検証にはならない。
- 外部対象は`{"id":"source","kind":"external","ref":"対象への参照","version":"確認した版"}`。Git SHAや環境の版を使えるが、CLIは外部状態を取得しない。未コミットの変更をHEADだけで表さず、filesまたは変更を識別する版を使う。
- verdictはpass・fail・unknown・not-applicable。pass・failはevidenceが必須、unknown・not-applicableはreasonが必須。method・environment・observedAtは全て必須。
- 同じ試行・条件を再確認するときは`supersedes`に現在有効な記録IDを渡す。対象の版が変わった場合も明示的に置き換える。古い記録から分岐した置き換えや、置き換え済みの記録での提出を拒否する。
- 他の試行の証拠を使う場合は`reusedFrom`と`reuseReason`を渡す。同じunit・条件・対象版・判定であることに加え、担当が現在の前提への適合性を確認する。CLIは理由の意味を判断しない。
- 代理記録ではperformerに実際の確認者を記す。記録者のactor/sessionは別に保存される。

確認記録はstartで契約・入力版を固定した後に作る。入力が変わった場合は新試行へ切り替えてから記録する。再利用元が置き換え済み、またはその対象・証拠が変わった場合はreusedFromを使えない。

`ledger check <unit>`は現在の条件別判定を返し、テストを実行しない。記録がない、契約・依存入力・ローカルの対象・証拠が変わった場合はunknownと表示する。以前の判定はrecordedVerdictに残す。`ledger summary`は全unitの現在の判定、`--history`では履歴を返す。

submitには現在の試行で記録した全条件の有効な記録を含める。不都合な評価結果だけを省略しない。同じtarget IDに異なる版の確認を混在させない。必須条件が許可した判定を満たさない場合は完了にできない。レビュー対象のfailと、報告のpassは併存できる。

## 報告と判断待ち

| コマンド | 入力・動作 |
| --- | --- |
| `inbox push <unit>` | kind=reportまたはhelp、body、任意のrefs。ownerまたはrecorderが親へ報告する |
| `inbox list` | 未処理通知を読む。`--recipient`で役割を絞り、`--history`で処理済み・失効も読む |
| `inbox ack <通知ID>` | 受信担当がreason付きで途中報告を処理済みにする。完了通知には使えない |
| `gate park <gate-id>` | unit、question、options（文字列配列）、respondent、任意のrecommendation。新規はunitのversion・attempt、再登録はgateのversion・現在のattemptを渡す |
| `gate list` | 未解決一覧。`--history`で解決済みも取得 |
| `gate resolve <gate-id>` | 親がanswerとevidenceを渡す。`--if-version`はgateのversion |

完了通知はsubmitで作り、accept・returnで処理済みにする。読み取りで削除しない。reopenや試行の切り替えで旧提出を無効にした場合、未処理の完了通知はobsoleteとして履歴に残す。新しい提出ができたときにsuccessorで関連付ける。

## セッションの引き継ぎ

通常更新では登録されたactor/sessionの一致を必須にする。旧統括セッションが終了した後の最初の操作は、新セッションからルートunitの`unit assign`を呼ぶ。

```json
{
  "coordinator": { "actor": "parent", "session": "parent-2" },
  "handoff": { "previousSession": "parent-1", "stoppedRef": "handoff/stop.md", "authorityRef": "handoff/scope.md" },
  "reason": "既存依頼の継続を新セッションへ引き継ぐ"
}
```

新セッションのactorは既存の統括役割と同じにする。旧セッション、現在のunit version、停止と引き継ぎ権限の根拠を照合する。この操作だけに新セッションからの開始を許し、通常更新の照合を省略しない。旧担当が実際の書き込みを終えたことは呼び出す担当が確認する。

引き継ぎの保存後は古いsessionを使わない。操作が競合した場合は台帳を読み直し、既に行われた交代を上書きしない。既存の依頼で認められた引き継ぎに、人間への再承認を一律に追加しない。

統括セッションの交代は台帳全体の同じ統括役割に適用する。その旧セッションが作業・記録を担当するunitは新試行へ進み、確認担当の登録も更新する。他の子エージェントのセッションは変更しない。停止の根拠は統括の旧セッション全体を対象にする。

停止・権限の根拠は参照とローカルファイルのハッシュを更新履歴へ保存する。`unit get <id> --history`のoperationsで、入力、実行者、影響を受けたunit、根拠を確認できる。

## 保存・表示・復旧

state.jsonが管理情報の正本。共有ファイルを直接編集しない。`status`は読み取り専用。統括担当の`export`は`exports/<revision>/`へunits.tsv・ledger.tsv・status.mdを生成する。出力の編集や逆インポートで台帳を更新しない。exportは台帳更新ではなく、operation-idを必要としない。

同じrevisionの出力が既にあれば内容を照合する。成果物の変更などで判定が変わっていた場合はEXPORT_CONFLICTとし、以前の出力を上書きしない。現在の状況はstatusで確認し、必要な再開・再確認を台帳へ反映してから新しいrevisionを出力する。

`doctor`で形式、参照、ロックを確認する。ロック競合時は所有する処理の終了を待つ。異常終了で残ったロックは、全ての書き手の停止、doctorのロック情報、保存済みJSONを確認してから、その台帳の`.orch.lock`だけを取り除く。稼働中のロックを奪わない。不明なschemaや壊れたJSONは初期化し直さず、元ファイルを保持して原因を調べる。

同じホストのローカル台帳を対象にする。ネットワーク越しの共有や電源断まで含む永続性を保証しない。複数worktreeへ台帳の同じ場所を渡し、成果物の参照は親が読める基準で示す。相対参照はinit時のproject基準、絶対パス・HTTP(S)も利用できる。ローカル証拠のハッシュは読み取り時に照合するが、外部参照の内容は担当が確認する。

完了した仕事の履歴は保持する。必須の子の受け入れ、親の完了判定、gateと通知の処理を終え、全書き手の停止を確認してから最後のexportを作る。保存用にはstate.json・exportsと、参照する成果物・証拠を一緒にコピーし、元のproject・store・revision・各ファイルのハッシュと保存先の対応を目録へ残す。保存コピーは読み取り専用にし、元データを自動削除しない。

次の独立した仕事は別のstoreを明示してinitする。進行中の依存を分断せず、旧成果を入力にする場合はその版を新unitの契約と確認条件へ取り込む。別storeのunit IDを依存として直接接続する機能はない。

storeを移してもstate.json内のprojectや絶対参照は変わらない。保存後に元の成果物が変わればstatus上の判定は古くなるため、当時の確認には保存した証拠とdigestを照合する。参照先を合わせるためにstate.jsonを直接書き換えない。履歴の自動削除・圧縮・移設後の参照変換は提供しない。

起動時の準備はスキルのscripts内に閉じる。外部依存のない構成では依存定義の検査だけを行い、必要な依存がある構成では同じscripts内のbun.lockで固定して導入する。利用先のpackage.jsonを変更しない。

終了コードは0=問い合わせ・操作成功、1=入出力等の失敗、2=入力・参照・条件違反、3=ロックや版の競合。0は対象の合格を意味しない。JSONは成功時`ok/revision/data`、失敗時`ok:false/error.code/error.message`を返す。
