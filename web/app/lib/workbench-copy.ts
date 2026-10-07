import type { WorkbenchRoot } from "../../shared/workbench-contracts";
import { runErrorMessage } from "./run-copy";
export const workbenchStateLabels: Record<WorkbenchRoot["state"], string> = {
  running: "作業を進めています", stopping: "停止を確認しています", waiting_input: "あなたの回答を待っています", succeeded: "完了しました", failed: "完了できませんでした", blocked_unknown: "実行状況の確認が必要です", stopped: "停止しました",
};
export function workbenchError(code: string) {
  const messages: Record<string, string> = {
    workbench_not_found: "この作業は見つかりません。ワークスペースとログインを確認してください。",
    workbench_disabled: "この環境では、まだ作業の受付を開始していません。",
    python_disabled: "ファイルを処理する環境は、現在準備中です。",
    invalid_request: "依頼内容やファイルの選択を確認してください。",
    file_not_ready: "保存が完了したファイルを選んでください。",
    file_not_found: "選んだファイルを利用できません。選び直してください。",
    file_quota_exceeded: "結果ファイルを保存する容量が足りません。",
    definition_archived: "選んだ設定は利用を終了しています。別の公開版を選んでください。",
    definition_dependency_unavailable: "設定に含まれるスキルを利用できません。別の公開版を選んでください。",
    definition_version_not_found: "選んだ設定を利用できません。公開済みの設定を選んでください。",
    agent_answer_conflict: "回答は受け付け済みか、作業の状態が変わっています。画面を更新してください。",
    agent_grant_expired: "実行を続けられる期限を過ぎました。ログインを確認してください。",
    agent_budget_exhausted: "この作業の回数・時間・費用の上限に達しました。",
    agent_grant_revoked: "このログインでの実行許可は失効しています。ログインし直してください。",
    agent_stopped: "この作業は停止されています。",
    idempotency_conflict: "同じ送信として異なる内容が届いています。画面を更新してください。",
    submission_expired: "送信を確認できませんでした。画面を更新してから操作してください。",
  };
  return messages[code] ?? runErrorMessage(code);
}
