export const runStateLabels = {
  accepted: "受付済み・実行未確認",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
  needs_recovery: "復旧が必要",
  not_started: "開始せず終了",
} as const;

export function runErrorMessage(code: string) {
  const messages: Record<string, string> = {
    workspace_required: "ワークスペースを選んでから送信してください。",
    workspace_not_found: "ワークスペースが見つからないか、現在は参加していません。一覧から選び直してください。",
    unauthorized: "ログインを確認できませんでした。アカウントからログアウトして、もう一度ログインしてください。",
    authentication_unavailable: "ログインサービスに接続できません。しばらくしてから更新してください。",
    idempotency_conflict: "この送信はすでに受け付けています。内容を変えて実行する場合は「新しい実行」から始めてください。",
    another_cli_running: "別の処理が動いています。実行一覧で状態を確認してください。",
    unresolved_run: "確認が終わっていない実行があります。一覧から開いて、復旧の操作を行ってください。",
    run_not_found: "この実行は見つかりませんでした。実行一覧から選び直してください。",
    pilot_estimate_limit_reached: "この環境のモデル利用上限に達しました。追加実行の前に利用状況の確認が必要です。",
    paid_failure_requires_review: "前回のモデル実行に失敗しています。原因と使用量を確認してから次の実行へ進んでください。",
    failed_request_already_attempted: "同じ内容のモデル実行がすでに失敗しています。原因を確認してから内容を見直してください。",
    unknown_paid_usage: "モデルの使用量が確認できない実行があります。追加実行を止めています。",
    model_consent_required: "モデルを使う場合は、外部送信と料金についての確認にチェックしてください。",
    result_not_available_no_restart: "結果がまだ確認できません。二重実行を防ぐため、最初からのやり直しは行っていません。",
    suspended_result_unavailable_manual_inspection: "実行は停止していますが、結果を回収できませんでした。保存された記録の確認が必要です。",
  };
  return messages[code.split(":")[0]] ?? "状況を確認できませんでした。実行一覧を確認し、送信をやり直す場合は同じフォームを使ってください。";
}
