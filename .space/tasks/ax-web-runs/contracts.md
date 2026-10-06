# Web実行の境界契約

HTTPとPythonの公開データをここで固定する。ブラウザはBFFのみを呼び、HonoはPython経由で台帳を扱う。公開入力からパス、コマンド、イメージ、モデル名を指定しない。

## Python bridge

`python3 ax-local/web_bridge.py <submit|list|get|artifact|recover>`。JSONを標準入力で1件渡し、標準出力に1件だけ返す。入力64 KiB、出力512 KiB。成功は `{ "ok": true, "data": ... }`、失敗は `{ "ok": false, "error": { "code": "safe_identifier", "status": 409 } }`。秘密やコマンド出力を公開しない。

- submit入力: `{key, mode, instruction, input_text, output_name, allow_model}`。keyはUUID、modeはoffline/model、allow_modelはboolean。modelはtrue必須。instructionはUTF-8で1〜2048 bytes、input_textは0〜4096 bytes、output_nameはprotocolのファイル名規則。input_textが空ならinputs={}、それ以外はinputs={"input.txt": input_text}。同じkeyは同じ内容の場合だけ再生。
- submit出力: `{run_id, replayed}`。副作用の受付は永続化後に返す。再生ではworkerを起動しない。
- list入力: `{}`。出力: `{runs: RunSummary[]}`、新しいものから最大50件。
- get入力: `{run_id}`。出力: `{summary: RunSummary, request: ProtocolRequest, result: ProtocolResult|null, cleanup: {egress_denied: boolean, suspended: boolean}, cleanup_errors: string[]}`。
- artifact入力: `{run_id}`。出力: `{name, content}`。既存成果物のサイズ・SHA256・UTF-8を照合する。最大64 KiBの成果物をJSONで返す。
- recover入力: `{run_id}`。出力: `{run_id}`。有限workerへ復旧を渡す。新しい開始やresumeはしない。処理中は409、解決済みは副作用なし。

RunSummaryは `{run_id, adapter, accepted_at, state, phase, resolved, active, can_recover, error_type}`。adapterはoffline/antigravity。accepted_atはISO UTC日時、従来CLIの記録はnull可。stateはaccepted/running/succeeded/failed/needs_recovery/not_started。phase/error_typeは安全な文字列（error_typeはnull可）。activeは実行ロックの観測値で、プロセスのPIDを根拠にしない。can_recoverは未解決かつ実行中でない場合。未開始終了をcleanup実施済みとは表示しない。

ProtocolRequest/ProtocolResultは既存 `ax-local/task_runtime/protocol.py` の形を使う。結果のusageは整数の辞書、estimated_usdは数値またはnull。HonoとBFFは応答の型も検証する。

## HTTPとBFF

- `POST /v1/runs` → submit。JSONのkeyで冪等性を確保する。202。
- `GET /v1/runs` → list。
- `GET /v1/runs/:runId` → get。
- `GET /v1/runs/:runId/artifact` → artifact。
- `POST /v1/runs/:runId/recover` → recover。JSON本文は空のobject。202。

HonoはW1のHost/Origin/Bearer制限を維持。異常はJSON `{error: code}` と400/403/404/409/413/415/503等。未知の障害は本文を漏らさず503。Python入口への待ち時間は5秒以下（実行workerの寿命とは別）、BFFは本文読取まで8秒。自動再送なし。

`web/shared/run-contracts.ts` がTypeScriptの型/実行時schema、`web/api/run-service.ts` がPython境界、`web/app/lib/runs.server.ts` がBFFクライアント。クライアントは `list()`, `get(runId)`, `submit(input)`, `artifact(runId)`, `recover(runId)`。`RunApiError` は安全な `code` と `status` を持つ。UIへの説明はBFF側の対応表で行う。

フォームはセッション・CSRFを検証し、keyを送信失敗や再読込で使い続ける。「新しい実行」の明示操作だけでkeyを切り替える。受理後は詳細URLへ303で移動する。GETやpollingは読むだけ。モデル利用はradioと明示checkboxで選び、入力の外部送信と料金を説明する。
