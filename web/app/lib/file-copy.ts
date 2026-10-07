import { runErrorMessage } from "./run-copy";

export function fileErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    invalid_request: "ファイルの形式とサイズを確認してください。CSVまたはExcel（.xlsx）、空でない8 MiB以下のファイルを選べます。",
    invalid_file_chunk: "ファイルの送信内容を確認できませんでした。同じファイルで再送してください。",
    file_not_found: "このファイルは見つからないか、利用する権限がありません。",
    file_not_ready: "ファイルの送信が完了していません。一覧から続きを送信してください。",
    file_cancelled: "この送信は取り消されています。新しくファイルを選んでください。",
    file_already_ready: "このファイルは保存済みです。一覧を更新してください。",
    file_incomplete: "ファイルの一部が届いていません。同じファイルを選んで続きを送信してください。",
    file_hash_mismatch: "ファイルの内容が一致しません。元のファイルを選び直してください。",
    file_chunk_conflict: "送信済みの内容と一致しません。元のファイルを選び直してください。",
    file_draft_limit: "送信途中のファイルが4件あります。続きを送信するか、不要な送信を取り消してください。",
    file_quota_exceeded: "ファイルの保存容量の上限に達しています。管理者にお問い合わせください。",
    submission_expired: "ページを再読み込みしてから、同じファイルを選んで続きを送信してください。",
    api_unavailable: "通信結果を確認できませんでした。同じファイルのまま再送するか、一覧を更新してください。",
    bridge_unavailable: "通信結果を確認できませんでした。同じファイルのまま再送するか、一覧を更新してください。",
    request_too_large: "送信内容が大きすぎます。ページを再読み込みしてから再送してください。",
  };
  return messages[code] ?? runErrorMessage(code);
}
