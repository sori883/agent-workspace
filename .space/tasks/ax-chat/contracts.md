# チャットの境界契約

既存の有限AX実行を各往復に用い、Pythonが会話の受付と復元を所有する。会話はreceiptの `conversation: {id, parent_run_id, sequence}`（sequenceは1始まり）で連鎖し、request.instructionと検証済みreply.txtを本文の正本とする。SDKやguestの要求形式は変更しない。

## 操作と型

- `GET /v1/conversations` → `{conversations: ConversationSummary[]}`（最新50件以内）。
- `GET /v1/conversations/:id` → `ConversationDetail`。未受付の新規UUIDは404 `conversation_not_found`。
- `POST /v1/conversations/:id/turns` → `{conversation_id, run_id, replayed}`、入力 `ChatInput: {key: UUID, parent_run_id: RunId|null, text: string, allow_model: true}`。受付済みの再送は同じrunを返しworkerを増やさない。
- Python bridge command: `conversations`（入力{}）、`conversation`（入力{id}）、`chat`（入力{id, ...ChatInput}）。
- TS `ChatService`（Python bridge）と `chatsClient`（BFF）: `list()`, `get(id)`, `submit(id,input)`。

```
ConversationSummary {
 id: UUID; title: string; updated_at: ISODate;
 head_run_id: RunId; turn_count: number; state: RunState;
}
ConversationDetail {
 conversation: ConversationSummary;
 turns: {summary: RunSummary; user: string; assistant: string|null}[];
 can_send: boolean; context_full: boolean;
}
```

本文はUTF-8、最新発言2048バイトまで。過去の成功ペアはrole/content付きJSON（ensure_ascii=false、compact separator）を `request.inputs["conversation.json"]` に固定して渡す。例 `[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]`。初回は空配列。成功・使用量確定・cleanup完了・artifact検証を満たす返答のみassistantとして公開・文脈化する。失敗発言は表示するが次の文脈に含めない。履歴JSONが4096バイトを超えるか32回に到達するとcontext_fullとなり新規受付拒否。会話を黙って切り詰めたり要約モデルを呼んだりしない。titleは最初の発言の最初の60 Unicode code points、改行は空白化。UUIDは小文字正規化。

## 不変条件

元のsubmitted bodyとidから冪等性hashを作り、現在の会話で組み直した文脈から作らない。既存キーの照合→既存global lock内で再照合・現在head一致・全先行run解決・文脈/費用検証→既存atomic prepareでreceipt/request/manifestを一度に保存する。旧parent、未完了、分岐/欠損/循環など不正会話状態はfail closed。GETとworker再生は新しいAX実行を始めない。既存runsAPI・旧receiptは互換。実行の復旧は既存POST /v1/runs/:id/recoverを使いモデル再試行と分ける。

追加エラー: `invalid_conversation_id`400、`conversation_not_found`404、`conversation_conflict`409、`conversation_busy`409、`conversation_context_full`422、`invalid_conversation_state`409。入力不正/上限/モデル同意/料金/復旧などは既存safe error codeも使用可。成功応答のconversation_id、各runと親リンクを検証する。会話応答はMAX_CHAT_RESPONSE_BYTES=1MiB以内。Python stdout/TS bridge transportの最大枠も1MiBとし、旧run API/BFFの512KiBは維持。JSON符号化の最大6倍増加を含め、32回のuser最大384KiB+最後assistant最大384KiB+先行履歴最大24KiB+メタデータで1MiB以内とする。符号化後の上限チェックと制御文字を含む最大ケースの試験を行う。

## Webでの利用

`/`をチャット画面にする。旧単発実行画面は`/tasks`、既存`/runs/:id`と`/connection`を維持。会話UUIDをURLに持ち、送信キーはその会話UUIDと現在の末尾runから決定的にUUID化する。同じ会話状態は再読込で同じキー、受付で末尾が進むと新しいキーになる。未送信の新規会話はサーバーに作成しない。履歴をサーバーから読む。最初に料金/外部送信の同意を表示し、送信ごとにallow_modelを渡す。再送不明時は同じキー・本文・親を保持し、編集と新規送信を混同させない。前の回答完成後だけ次を送れる。読み込み/再読込で課金を始めない。

Enterは改行、Ctrl/Cmd+Enterは送信（IME変換中は送らない）。初版は完成回答をポーリング表示し、スピナーではなく静止した待機表示と説明を使う。会話上限・失敗・復旧への導線・新しい会話を提供する。会話はローカル保存であり本番の認証/保存には着手しない。
