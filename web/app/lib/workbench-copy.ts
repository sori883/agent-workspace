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
    agent_selection_disabled: "新しい依頼は標準エージェントで受け付けます。スキルを指定する場合は入力欄の「/」から選んでください。",
    skill_context_too_large: "スキルの指示や補助資料が長く、今回読み込める量を超えました。内容を短くするか、指定するスキルを減らして新しい依頼を始めてください。",
    model_input_limit: "依頼やスキルの指示・補助資料が長く、AIが一度に読み込める量を超えました。内容を短くするか、指定するスキルを減らして新しい依頼を始めてください。",
    skill_selection_unavailable: "この依頼は以前の方式で開始されています。スキルを自動で使う場合は、新しい依頼を始めてください。",
    skill_load_limit: "この依頼で読み込めるスキルの上限に達しました。依頼を分けてお試しください。",
    skill_already_loaded: "同じスキルや資料を繰り返し読み込もうとしたため、作業を停止しました。",
    skill_not_available: "エージェントが指定したスキルを、この依頼では利用できませんでした。",
    skill_not_loaded: "スキルの手順を読む前に補助資料を参照しようとしたため、作業を停止しました。",
    skill_file_not_found: "スキルに登録されていない補助資料を参照しようとしたため、作業を停止しました。",
    agent_answer_conflict: "回答は受け付け済みか、作業の状態が変わっています。画面を更新してください。",
    agent_grant_expired: "実行を続けられる期限を過ぎました。ログインを確認してください。",
    agent_budget_exhausted: "読み込む量・実行回数・時間・費用のいずれかの上限に達しました。指示や資料を短くするか、依頼を分けてお試しください。",
    agent_grant_revoked: "このログインでの実行許可は失効しています。ログインし直してください。",
    agent_stopped: "この作業は停止されています。",
    idempotency_conflict: "同じ送信として異なる内容が届いています。画面を更新してください。",
    submission_expired: "送信を確認できませんでした。画面を更新してから操作してください。",
  };
  return messages[code] ?? runErrorMessage(code);
}
