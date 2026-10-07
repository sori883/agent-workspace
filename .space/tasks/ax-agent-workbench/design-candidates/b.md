# 候補B：PostgreSQLの定義台帳と外部の不変bundle/blob

2026-10-07、基準 `ede929ea87af8173af128e7b8706c11d1a9b16f6`。独立候補であり未採用・未実装。他候補は参照していない。共通条件は [task.md](../task.md) と親から受領した利用者回答を使用する。本人用とWorkspace共有の両方、定期実行は作成者権限・ログアウト後も継続・本人限定結果・所属/権限喪失時に停止、製品サブエージェントなしが確定している。

## 最初の利用例

1. 本人がWorkspace内で「売上集計」エージェントの公開版を選び、CSVまたは `.xlsx` をアップロードする。対象シート・集計列・金額列・出力形式を指定する。初期は非暗号化・マクロなし・数式なしの表に限定する。
2. Runtimeが固定されたスキルと依頼から型付きの集計指示を提出する。信頼側が列・演算・出力名を検証し、Runtimeを安全に停止してから別のcode TaskでPython集計を実行する。
3. code Taskを停止・回収した後、新しいRuntimeが確定した要約・結果参照から説明を作り、本人へCSV/XLSXのダウンロードを提示する。元ファイルをモデルへ丸ごと送らない。
4. 本人は同じ版と明示した入力選択で毎週実行する予定を登録できる。入力を固定するか最新データを解決するかは未決で、ここでは固定参照を最初の候補とする。ログアウト後も独立した実行許可で動き、結果は本人だけに保存される。共有スキルの作者やWorkspace adminへ入力・結果を公開しない。

W1は版固定済みの集計用Pythonと許可演算から始める。自由な生成scriptは同じ隔離境界の検証後に追加する。曖昧な列や不足条件は開始前のフォームで確認する。未対応の数式・外部接続・巨大ファイルは黙って変換せず説明して終了する。

## 保存の正本と公開単位

| 対象 | 正本・所有 | 更新と実行時の扱い |
| --- | --- | --- |
| 組込みスキル・既定エージェント | Gitの原本 | リリース時にcommitとdigestを持つ不変版を登録。画面から組込み原本を上書きせず、自分の定義へ複製する |
| 画面登録の定義・プロンプト・スキル本文 | PGの版・所有・参照台帳と、外部object storageの不変bundle | UI保存で新しいdraft revision、公開で新しい不変versionを作る。Gitへの逆書込みや共有ディレクトリを必須にしない |
| 入力・生成script・結果ファイル | PGの本人/Workspace/実行との結び付けと、不変blob | 一度確定したbytesを変更しない。新ファイルは別ID。実行結果を定義共有へ連動させない |
| 実行・認可・費用・操作結果 | app PostgreSQL | Task内ファイル、blob名、モデルの自己申告を権限・成功・使用量の正本にしない |

概念骨組み（DDLではない）：

```ts
type Scope = { kind: 'personal'; workspaceId: UUID; ownerUserId: UUID }
           | { kind: 'workspace'; workspaceId: UUID };
type VersionRef = { id: UUID; sha256: string };
type DefinitionVersion = { id: UUID; definitionId: UUID; parentVersion: UUID | null;
  bundle: VersionRef; prompt: VersionRef; skills: VersionRef[];
  allowedTools: string[]; environmentDigest: string; protocol: 'workbench-v1' };
type BlobRef = { id: UUID; sha256: string; bytes: number; mediaType: string };
type RunBinding = { owner: UUID; workspace: UUID; definition: VersionRef;
  inputs: BlobRef[]; mode: 'preview' | 'model'; budgetProfile: string; grantId: UUID };
```

個人用も選択Workspaceに閉じる案とし、他Workspaceへ使う場合は本人が明示複製する。共有版が個人限定の依存skillを参照する組合せは公開時に拒否する。共有版の利用者はそのWorkspaceの現メンバー。編集・公開は「作者がdraft編集、adminがWorkspace共有版を公開」を初期候補にするが、人間の決定待ち。業務ロールdeveloperから公開権限を推定しない。

bundleは正規化manifestと複数のcontent-addressed blobで表し、サイズ・全パス・全hashを固定する。Taskへ任意archiveをそのまま展開しない。絶対パス、`..`、symlink、hardlink、同名/正規化衝突、過剰な個数・展開サイズを拒否する。登録scriptは未信頼コードであり、共有・署名・公開だけでRuntime内実行を許可しない。

入力アップロードは本人限定のstaging object→サーバー側bytes/hash/上限確認→PGにready参照、公開はready blobだけを同一transactionで版へ束縛する。DBとobject storageは原子的にcommitできないため、先に存在確認済みの不変objectを作り、DB commit失敗の孤児だけを猶予後に回収する。受付後にblob欠落・不一致なら実行を始めず保留し、最新blobへ置き換えない。

同一版のロードはAPIが認可したbindingからcontrollerが取得・hash照合し、必要なファイルだけをTaskへ渡す。TaskはDB資格情報、bucket資格情報、署名URLを持たない。object取得/書込みは信頼側の限定権限。ダウンロードも本人と現在所属を再検査するAPI経由を初期とし、長寿命の公開URLを発行しない。

参照中version/blobはsoft delete後も実行履歴用に保持する。非公開化・利用停止は新規受付を止める。管理者の緊急revokeは既存grantを恒久取消する。削除とrevokeを区別し、保持期間・本人の物理削除要求と監査の衝突は別途決める。Workspace共有の解除で既存実行が別版へ切り替わることはない。

## AX内Runtimeと別code Taskの逐次実行

経路は `Runtime(plan) → checkpoint・停止 → code Task → 成果回収・停止 → Runtime(verify/final)`。各矢印はDBに確定したstepであり、APIのHTTP接続寿命やRuntimeの待ち続けるプロセスには依存しない。TaskはPodとは別の実行単位で、初期は各stepで新しいTask/Actorを使う。

rootは依頼全体、stepは型付き有限区間、runは一つのAX Task実行とする。新しい `workflow_steps(root_id, ordinal, kind, run_id, source_operation_id, checkpoint, state)` を追加し、`kind=runtime|code` とする。runtimeの会話履歴とcodeの内部実行を別に扱い、code stdoutをそのままassistant発言へ追加しない。

Runtimeは `execute_python{script_blob, inputs, expected_outputs, environment_digest}` を提案するだけ。信頼側が本人・grant・版・tool許可・累積予算・ファイルownerを検査し、一意なoperationへ束縛する。生成scriptや登録scriptをRuntimeと同じActorへコピーして実行しない。code Taskは入力readonly・専用scratch/outputだけを持ち、Runtimeのmailbox/receipt/技能キャッシュとvolumeを共有しない。

controllerによるファイル転送は既存の小さいJSON Stageとは別の、サイズ上限付きchunk転送とmanifest確定の契約を用意する。任意shell文字列にファイル名や本文を埋め込まない。出力はcode側のmanifestを信用せず、信頼側が許可した出力名・実bytes・サイズ・hashを照合してstaging blobを確定する。構造化ログも長さを制限し、制御結果として実行しない。

Runtimeのcheckpoint保存、model要求の全settle、通信deny読戻し、Actor SUSPENDEDかつworker未割当を確定してからcode stepを実行可能にする。code側も同じ停止証拠を得てから次Runtimeへ進む。全体slot1は全経路共有。root内のstep移行をDBで一度だけ確定し、同じrootの未解決leaf runがある間は次のrunを作らない。

operationの同key・同本文は保存済み結果を返し、変更本文は拒否する。開始intentのACK喪失・期限切れclaim・未知usage・未停止は再実行せずhold。未送信queueの取得だけと、送信済み外部操作の再送を区別する。codeの処理が純粋に見えてもunknown startを自動再実行しない。旧recoverは回収・遮断・停止だけのまま、新しい次step受付と区別する。

code Taskにモデル/PG/ストレージ/制御RPC資格情報やGateway capabilityを渡さない。AXの鍵自動注入禁止とActorTemplate検査をcode用配置にも適用する。現在のHTTP/HTTPS denyだけでは不足し、DNS・任意TCP/UDP・metadata・cluster内宛先と制御RPCへの到達を封じる。namespace/pool名だけを隔離保証にしない。資源はCPU/メモリ/プロセス/ディスク/時間を有効な実Actor制限へ落とす。

## 費用と初期の作業幅

現行のroot最大3モデル要求・2tool・入力6000/出力512・実作業90秒と、全体0.01 USD試用停止・2,000円上限を維持する。code待ちでRuntimeを停止してもcode実行時間をroot実作業時間へ加算する。人待ち・scheduler待ちは別期限とし、step追加で累積上限をリセットしない。

初回は「modelによる集計指示→code実行tool1→modelによる結果説明→成果物確定tool2」を想定する。計画/検証2回のモデルで収まらない場合、残り枠を明示判定し、勝手な修復loopや追加toolを始めない。modelの出力512では任意の長いPython生成は成立しにくいため、短い型付き集計recipeと版固定scriptを先に使う。追加の質問や修復を含む広い体験は、tool定義と予算を人間と合意してから広げる。

費用予約→count→生成直前認可→一回送信→実usage保存はv5の意味を引き継ぐ。旧run・新workflow・定期実行を同じ全体費用guardへ含め、二重計上しない。入力計数と概算費用は絶対的な請求上限ではなく、超過時も既知費用を保存して追加送信を止める。無人実行の回数・期間・累積金額の許可はまだ無いので、有料scheduleの有効化は未決のゲートとする。

## 定期実行と非セッションgrant

`Schedule(id, creator, workspace, version_ref, input_refs, timezone, calendar, revision, enabled)` と `ScheduleGrant(id, creator, workspace, allowed_version, allowed_tools, limits, expires_at, revoked_at)` をPGに置く。明示した予定・入力・版・範囲・費用に対する許可であり、Web JWT/refresh tokenの延命ではない。schedulerは限定service roleでこのgrantの実行を代行する。

保存・有効化時は本人のログインを要求する。各発火と全ての新しい外部送信で、作成者のactive・現在所属・対象版利用権・grant期限/取消・全体/予定別残額をDBで再確認する。ownerは常に作成者UUID。定義作者やschedulerサービスを結果ownerにしない。共有definitionの更新はscheduleの固定版を自動更新しない。

通常logoutはsession grantを止め、明示登録したschedule grantとそこから開始済みのrunは止めない。この区別を型で表し、既存logoutの全root UPDATEを無条件に流用しない。「予定を停止」は将来occurrenceを止めて関連grantも失効させる操作としてUIへ出す。所属削除・必要権限喪失・user disabledは該当grantを恒久revokeし、再加入・再有効化で復活させない。取消後もservice権限で回収・実停止できる。現在の失効根拠はapp DBのusers.statusとorg_membershipsであり、外部IdPでの変更を即時に全tokenへ伝播する保証はない。その同期や検出期限をschedule導入と混同せず、必要なら追加要件として定める。

schedulerはUTCの実行時刻と表示timezoneを保存し、`UNIQUE(schedule_id, occurrence_at)` とrow lockで一回だけoccurrence/rootを作る。予定revisionはそのoccurrenceへ固定するが、同時刻の編集で二重実行しない。ロック期限切れを外部startの再許可にしない。障害復帰時は取り逃しを無制限catch-upせず、初期はskipを記録する。同予定の前回が未完了/unknownなら次回をskip/holdし、重複起動しない。

初期案は本人が登録したblob参照を固定する方式であり、利用者が確定した入力方針ではない。「最新ファイル」を選ぶ場合は、発火時に本人の許可されたselectorを解決し、その時点の不変blob IDをoccurrenceに固定する別契約が必要になる。取得元・更新者・欠落時挙動・外部連携の有無は人間の回答後に決める。入力更新時は新schedule revisionを明示保存し、受付済みoccurrenceの入力を差し替えない。DST重複/欠落の扱いは画面に次回時刻を示す仕様とともに確定する。

## API・移行・境界

公開面の候補は `POST /uploads`→`POST /uploads/:id/complete`、`/definitions` のdraft/versions/publish、`POST /workflows`、本人用の結果参照/stop、`/schedules` の作成/更新/停止。各変更はidempotency keyと期待revisionを持つ。bundleの低水準転送・claim・step連結はUIから隠す。APIはNode/fs/spawnへ依存せず、PGと注入したobject-store境界だけを使う。

v1〜v5とchecksumは変更せず、追加migrationで版台帳/blob/step/schedule/grantを導入する。旧rootは `protocol=interactive-v1`、旧固定skill・2区間・session grantのまま固定。新rootだけ `workbench-v1` とし、既存run/effects/費用正本を使うが新しい入力・成果物契約へ明示分岐する。旧runのraw bytes/hash/費用/owner/会話順を保持し、ownerなしの旧資料に所有者を作らない。

既存rootのCHECK（固定skill、segment1〜2、operation1=model/2=tool）を新rootへ無条件に流用しない。追加の版別制約・step表で旧契約を保持しつつ新契約を表す。旧64 KiB UTF-8成果物はPG byteaに残し、新binary成果物はblob参照を使う。旧private資料を公開bundleへ移さない。

切替は旧受付を閉じてwriter退役・未解決/停止を確認し、新旧reader互換と限定roleを確認してから新受付を開く。object移行が失敗した状態でDB参照を公開しない。新workflow受付前なら追加機能を閉じて旧経路へ戻せる。受付後は新writerを止めて回収・照合し、旧コードへ盲目的にrollbackしない。PG backupだけでは新成果物を復元できないため、参照blobの保持/backupも復元条件に含める。

## 現状と固定上流の根拠

- 現行SDKはtools空、subagent無効、1回の `agent.chat` と型付き提案＋固定tool。`ax-local/task_runtime/adapters/interactive.py` 197〜258行。固定スキルhash検証は48〜55行。登録bundleのロードは新規に必要。
- 現行PGは固定skill/2segment/operation1・2/session期限とfingerprintを持つ。`web/data/schema-v4.sql` 2〜32行、logout187行、所属/disabled失効354〜371行。v5 reserve/authorizeは `web/data/schema-v5.sql` 155〜198行。
- Task作成は固定command・imageでWorkspace bindingを渡さず、Stageは小JSON。`execution/native/adapter.go` 221〜247、417〜429行。実停止証拠は同313〜323行。旧入力4 KiB/成果64 KiBは `ax-local/task_runtime/protocol.py` 9〜14行。
- 固定AX `ac2332829f22360ff97b0ba34d94dd0dd782f17e` の [setupSkills](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/internal/workspace/setup.go#L262) はmkdirのみ。[鍵注入](https://github.com/google/ax/blob/ac2332829f22360ff97b0ba34d94dd0dd782f17e/internal/controller/reconciler.go#L143) がある。ローカル固定上流ソースでもHEADと本文を照合した。AX標準の「skill登録」が既に使えるとは扱わない。
- `ax-local/runner/Dockerfile` 1〜11行はPython3.12/SDK0.1.20と上流ax-task-runner PID1。`ax-local/patches/README.md` 3、38行は鍵注入禁止と共有workerの条件。`ax-local/README.md` 53〜57行はHTTP/HTTPS確認の範囲で、任意Pythonの全通信遮断の証拠ではない。

## 実装単位と実Actorの合格条件

1. **不変ファイル経路**：本人アップロード→保存→downloadと、固定Python集計のCSV/XLSX fixtureを無課金で完結。二人・同Workspace・別Workspace・失効・欠落/破損blob・upload応答喪失・DB/blob部分失敗を確認する。zip膨張、巨大sheet、NUL、CSV formula injection、外部link/マクロを扱う上限と拒否を確定する。
2. **code Taskの隔離**：実Actorでモデル/DB/object/制御資格情報が無いこと、他Actorのファイル・Runtime mailboxへ届かないこと、TCP/UDP/DNS/metadata/cluster RPCを拒否すること、CPU/memory/disk/process/timeoutを強制できることを確かめる。pool分離が必要なら全template selector/配置の実観測までを含める。失敗なら生成/登録scriptを製品公開しない。
3. **逐次workflow**：模擬providerでRuntime→code→Runtimeの実AX往復、集計の独立期待値、停止後だけ次step、start ACK喪失・controller退役・期限切れclaim・未知usage・stop/所属取消で再開始しないことを確認。少数有料検証は別途許可された枠でだけ行う。
4. **定義登録**：本人用/共有版の編集・公開権限、依存ACL、実行中の版固定、改ざん拒否、削除後の履歴、他人結果非公開を検証する。built-inのGit原本と画面編集版の出所を表示する。
5. **定期運用**：模擬時計＋実DBでDST・重複scheduler・再起動・編集中発火・前回unknown・logout継続・除籍→再加入を確認し、実Actorを無課金で1回起動する。有料scheduleは明示した期限・回数・費用と停止手段が決まるまで有効にしない。

Bの利点はbinary入力/結果と参照資料をPGから分離し、定義公開版を実行環境から独立して固定できること。負担はobject storeの認証・backup・GC・不整合回復・ファイル転送という新しい運用面で、少量Markdownだけなら過剰である。今回はCSV/Excelが第一用途なのでこの負担を受け入れる候補とする。

未決は個人定義のWorkspace単位、共有版の公開者、定期実行の最新データ取得方法、アップロード/保持量、Excel対応範囲と大きさ、scheduleの期限・回数・費用枠、DST方針、object storage製品と整合/条件付きwriteの保証、実Actorの全通信/資源隔離の成立性。既存3model/2tool/90秒で届かない一般作業を、現上限のまま実現済みとはしない。
