# 候補A: 同じAX Task内でスキルを読み、モデルとの小さなループを続ける

状態: 独立した設計候補。未採用・未実装。2026-10-08、main `586f2afe1a5330943a7c5940ac1aed4ac3f38970` を調査した。他候補は読んでいない。

## 利用例と変える構造

利用者は標準エージェントへ「月次の売上をまとめて」と送る。エージェントは最初に、そのWorkspaceで本人が使える公開済みスキルの名前・説明だけを見る。必要なスキルをモデルが `read_skill` で要求すると、同じAX Runtime Taskへその本文が返る。Runtimeは本文を含めてもう一度モデルを呼び、回答・質問・隔離Pythonの提案のどれかへ進む。スキル選択のために新しいTaskは作らない。

「/」でスキルを明示指定した場合は、その公開版の指示を最初から読み込む。エージェントの選択・作成・編集は通常画面から除き、スキルの登録と利用へ統一する。既存のエージェント定義と過去の実行は削除しない。

この案の構造上の特徴は、**有限区間の中にも複数のモデル操作と読取操作を置く**こと。Taskは現在と同じくAX内にあり、質問・最終回答・Python実行へ渡す地点で止まる。Pythonは引き続き別の隔離Taskで実行する。

## 現状の根拠と変更が必要な理由

- `ax-local/task_runtime/adapters/workbench.py` はSDKを一度だけ呼び、選択済み定義を最初から全文でプロンプトに入れる。`max_model_calls=1`、tools空、subagents無効。
- `ax-local/task_runtime/adapters/interactive.py` の `ModelProxy` は二度目の要求を拒否し、`wait_reply(1)` に固定されている。
- `ax-local/task_runtime/mailbox.py` と `execution/native/mailbox.go` はsequence 1=model、2=toolのみを認める。
- `web/data/schema-v4.sql` の操作表にもこの二操作のCHECK制約がある。v8の予約・生成認可・精算・終了処理もsequence 1/2を前提にする。
- `web/data/schema-v8.sql` の `ax_finish` は一つのモデル操作usageとRuntime結果を比較する。ループにするなら、成功した一回だけを比較して残りを漏らす変更はできない。
- `execution/controller/workbench.go` は現在、rootの固定definition_manifestを全件転送してからTaskを開始する。動的読取はこの開始前転送だけでは実現できない。

したがってSDKの上限だけを上げる実装では成立しない。新しい操作プロトコル、送信前の都度認可、全操作の精算と結果照合を一つの変更として扱う。

OKFで `ax-local/task_runtime/`、`web/data/`、`execution/` のcode_refsを検索し、`decisions/systems/ax/agent-runtime`、`decisions/systems/ax/portable-api-postgres`、`rules/ax-model-spending` の本文を確認した。AX内Runtime／AX外の認可・秘密・費用、HTTP側のPython非依存、同じ全体枠、再送禁止を維持する。ユーザーの最新指示に従いAI接続は通常利用のため有効なまま維持する。

## 責務と型の骨組み

SDKに汎用ツールを開放せず、Runtime所有の明示的ループを採る。ループごとに一回限りのSDK Agent/ModelProxyを作り、前回の結果を正規化したプロンプトへ組み直す。SDKの再開用内部DBを正本にはしない。各SDK呼出しの入力6000・出力512・再試行0を維持する。

```ts
type SkillRef = `builtin:${string}` | `published:${string}`;
type SkillSummary = {
  ref: SkillRef;
  name: string;
  description: string;
  version_sha256: string;
  visibility: "builtin" | "personal" | "workspace";
};
type SkillCatalogPage = {
  entries: SkillSummary[];
  next_cursor: string | null;
  total: number;
};
type LocalProposal =
  | {kind: "read_skill"; ref: SkillRef; path: "SKILL.md" | string}
  | {kind: "list_skills"; cursor: string | null; query: string}
  | ExistingQuestionOutputUnsupportedPythonProposal;
type SkillRead = {
  ref: SkillRef;
  version_sha256: string;
  path: string;
  content_sha256: string;
  text: string;
  resources: {path: string; size_bytes: number; sha256: string}[];
};
```

`read_skill(SKILL.md)` は登録時のinstructions本文と補助ファイルの目録を返す。filesの本文は含めない。補助ファイルは、モデルがその固定目録にあるpathを次のread_skillで要求したときだけ返す。scriptも単なる資料として読み、Runtime内で実行・importしない。現在のPython能力と隔離条件以外の権限は増やさない。

新ループ専用のmailbox版を設ける。たとえばversion=3とし、旧version=1/2を緩めない。新rootの固定execution_policy／descriptorにこの版を明記し、新しい固定Runtime imageだけが使う。run envelopeと既存の有限root APIは維持し、別の常駐Runtimeや新しい実行基盤は追加しない。

```text
sequence 1: model → read_skill の構造化応答
sequence 2: tool  → DBで認可した SkillRead
sequence 3: model → python の構造化応答
sequence 4: tool  → accepted
Task終了・usage全件照合・通信遮断・実停止
既存の隔離Python Task → 既存の次Runtime区間
```

sequenceは連続し、奇数model・偶数toolとする。同じsequenceには同じbytes/hashだけを認める。直前のmodelが要求した操作と同じtoolだけを許可する。read/listの成功後だけ次のmodelを許可し、question/output/unsupported/pythonの受理後は追加操作を拒否する。最大12操作だが、rootの残model/tool上限が常に優先する。

Go controllerは従来どおり各操作をDBへ予約し、モデルの場合だけ外側Gatewayへ送る。read/listはDBの認可付き読取で応答し、外部モデルや任意ネットワークへ直接接続しない。tool予約時に読み取った結果を同一transaction内で記録するか、予約→読取→保存の失敗が起きても同一版・同一応答へ収束する明示的なsettlementを持たせる。単なる `accepted:true` をskill本文が返った証拠にしてはならない。

## カタログ・版固定・認可

開始時にそのWorkspace内で本人が利用できる公開版をスナップショットする。通常は各definitionの最新公開版、slash/「この版で依頼する」は指定された厳密な公開版を追加する。draftや別Workspace・他人の個人用定義は入らない。名前が同じでもrefが異なるため混同しない。

既存rootのdefinition_manifestは不変なので動的ロードのたびに書き換えない。新schemaで次を加える。

- rootの不変なskill policy／catalog generation。
- `ax_workbench_skill_catalog(root_id, position, ref, version_id, version_sha256, name, description, visibility)`。公開本文を複製せず、不変versionへの参照とメタデータを保存する。
- `ax_workbench_skill_reads(root_id, run_id, operation_sequence, ref, path, content_sha256)`。読み込んだ依存と利用履歴は追記だけにする。
- `ax_agent_operations` に各modelの検証済みproposalを保存する。segment.proposalは最終の外向き提案だけに使い、read提案で上書きしない。

カタログ全件を一つのプロンプトへ押し込まない。初回とlist結果は最大32件・メタデータ合計8KiB、説明はUTF-8境界で短縮して「続きあり」を明示する。total/next_cursorを渡す。必要ならモデルがlist_skillsで続きを読むか、名前・説明を検索する。検索はモデルが要求した読み取り手段であり、キーワード一致だけで自動適用する機構にはしない。候補ページの順序とcursorは固定スナップショットに対して安定させる。

初回ページで漏れたスキルもslash一覧ではページ送り・検索で指定できる。カタログが大きい場合、6回のモデル上限内に適切なスキルを見付けられる保証はない。使用可能な範囲を画面と応答で説明し、無限探索や上限拡大へ逃がさない。

各read/list、各モデル生成直前、既読本文を次区間で再利用する時点で現在の本人・Workspace所属・定義公開/廃止状態を再確認する。PGに記録した読み込み済み依存が使えなくなれば継続を止める。まだモデルへ渡していないカタログ行の廃止だけでは、無関係な依頼まで止めない。モデルへ既に渡したメタデータも再利用依存として記録し、失効後の再送に用いない。

公開更新が実行途中で起きても新しい版に切り替わらない。読取成功の再返却は同じ操作結果を使うが、認可失効後に過去の応答を新たに利用してモデル送信することは拒否する。

## 本文の大きさと組み込みスキル

instructionsは既存上限16KiB、補助ファイル読取は既存上限32KiBを維持し、応答全体をmailbox64KiB以下にする。一度に一つのresourceだけ読む。モデルへ渡すのは必要な本文だけだが、複数スキルや大きい参照文書で入力6000を超える場合はGatewayが生成前に拒否する。本文を黙って途中で切ったり、課金上限を上げたりしない。長い補助資料の範囲読取を加えるならUTF-8境界・hash・offsetを別途契約化する必要があり、初期実装では扱わなくてもよい。

`general-v1`の常時適用する基本指示は標準エージェントのsystemとして保持する。組み込み一覧には「常時適用」と明記する。`tabular-v1`はカタログの候補にし、ファイル有無だけで自動注入する現在の条件を外す。必要な集計指示はモデルのread、またはslashから読み込む。組み込み本文は固定imageの同じcatalog/path/hashで検証する。ローカル読取でもtool操作と実際の読み込み履歴を記録し、ユーザー登録分と同じ回数上限に入れる。

slashで明示されたスキルは既存の開始前転送と同じく初期依存として固定・認可して読み込む。最初のモデルに全文指示とresources目録を渡し、モデルにもう一度選び直させない。現行の8件までを維持し、8件指定だけで8toolを使い切る変更はしない。以後の動的readは1回をtool1回として数える。

## 費用・故障・終了

1rootのmodel6/tool8/Python3・300秒・0.01 USD、累計0.05 USD、生成ごとの6000/512を変えない。暗黙選択では通常、選択1回＋実作業提案1回の少なくとも2モデルが必要。Task起動は増えないが、モデルの追加費用は発生する。

各モデル操作に予約・count・生成直前認可・一回の送信・usage精算を置く。モデル失敗や不明usageがあると次のループへ進めず、既存のhold/recovery規則へ渡す。Runtimeが落ちても成功済みモデルを自動再送しない。既存と同じく故障したTaskを回収・停止し、その試行を失敗として残す。

終了時には全model操作の既知usage/費用の合計とRuntime receiptを比較する。一部の操作だけ一致していても成功にしない。最終tool、既読hash、全operation settled、独立した通信遮断・Task停止を確認して次区間へ進む。rootのactive_msは区間全体の実時間で加算し、ループを回すたびに残時間をリセットしない。

## UIと互換性

- 新しい依頼画面は標準エージェント固定。依頼欄に「必要なスキルは自動で使います。/で指定できます」を短く示す。
- slash候補は名称・説明・本人用/共有・公開版を表示し、同名の曖昧な入力は候補から選べる。送信payloadは本文から推測した名前ではなく厳密なref/version IDを持つ。
- keyboard上下/Enter/Escape、IME変換中Enter、貼付け、文字列中のURL `/` を区別する。指定チップを削除でき、本文の再編集で古い選択が隠れて残らない。
- ライブラリはスキル中心に変更する。エージェント作成導線は外し、既存agent詳細は履歴用の読み取り表示にする。agent付き旧rootの参照・回答は既存契約で動かす。
- エージェント定義の既存APIと履歴をこの変更で破壊しない。新UIはagent_version_idを送らない。古いリンクから新規agent実行を始める経路を通常入口に残すかは、標準固定の目的に照らして移行メッセージへ変える。
- previewは自動選択やスキル遵守を検証した表示にしない。固定の集計質問を汎用の操作確認文へ改める。

## 変更候補ファイルと移行

新しい `web/data/schema-v9.sql` とmigration登録で旧CHECK制約を新旧契約ごとに検証する形へ変更する。古いモデル/操作経路のseq 1/2のみという条件は残す。既存rootは旧policyに据え置き、開始payloadの再送同一性を変えない。新規rootだけ新policy/mailboxを選ぶ。

主な変更は `web/shared/workbench-contracts.ts`、`web/data/workbench.ts`、`web/app/routes/workbench.tsx`、`web/app/routes/library.tsx`、definition編集各route/component、ナビ表示、`ax-local/task_runtime/workbench_mailbox.py`、`workbench_protocol.py`、`workbench_runner.py`、`adapters/workbench.py`、`execution/native/mailbox.go` と `workbench_protocol.go`、`execution/controller/interactive.go` と `workbench_postgres.go`、`execution/gateway/workbench.go`。既存ModelProxy本体は旧経路を維持し、新版専用proxyを用意するか、sequence対応部分だけを明示的に共通化する。

controller/Runtime/schemaを整合した固定版へ配備してから新policy受付を有効化する。旧imageで新プロトコルを開始しない。停止中または待機中の既存rootは旧ピンを使い続ける。切戻しは新policyの新規受付停止で行い、作成済み操作・版・費用履歴を削除しない。

## 検証と採否の判断材料

実装後に必要な証拠:

1. 初回モデル入力は名前・説明だけで、未読skill本文や補助ファイル本文がない。read後の二回目だけに指定版が入る。明示指定は一回目から入る。
2. 同一Task内model→read→model→最終提案の合成provider試験。model1とmodel2双方の予約・usage・費用が記録され、最終集計と一致する。
3. 欠番・重複・差し替え・直前proposalとの不一致・最終受理後の追加モデル・read失敗後の継続を拒否する。
4. 別Workspace、他人の個人skill、廃止、所属喪失、二回目送信直前の失効を拒否する。publish同時更新でも固定版を使う。
5. tool上限、model上限、時間上限、入力上限、未知usage、途中controller故障、Runtime死亡で追加送信しない。旧v1/v2の互換性と既存一枠を検証する。
6. slash操作・同名・日本語IME・320px・keyboard/アクセシビリティ、エージェント選択/編集導線の撤去と既存履歴を確認する。
7. 実AXでTaskを増やさずreadが完了することと実停止を確認し、最後に目的を固定した少数の有料確認を行う。

利点はモデルが必要性を決めて読み、同じ作業区間の中で素早く続けられること。将来のread-onlyなMCP/RAG等にも一般化しやすい。APIが利用者の代わりにプロンプトから先にスキルを選ばない点も明確になる。

代償は大きい。現在の安全な二操作契約を、予算内で連続する操作台帳へ変更するため、SQL・Go・Pythonの予約/精算/終了判定へ広く触る。初期目的がスキル選択UXの改善だけなら実装・検証負荷が重く、SDK予算を信頼する近道は採れない。低遅延と今後のRuntime内ツール拡張が主目的であり、この追加の検証範囲を一つのPRで完遂できる場合に採用価値がある。Task起動時間をどの程度削減するかは本案では未計測であり、速さを保証しない。
