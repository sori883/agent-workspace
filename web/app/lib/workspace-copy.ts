import { runErrorMessage } from "./run-copy";
export const accessLabels = { admin: "管理者", member: "一般メンバー" } as const;
export const businessLabels = { general: "一般", developer: "開発者" } as const;
export function workspaceError(code: string) {
  const messages: Record<string, string> = {
    bridge_unavailable: "受付結果を確認できませんでした。画面を更新して確認してください。同じ内容で再送しても作成は増えません。",
    last_workspace_admin: "最後の管理者は変更・退出できません。先に別のメンバーを管理者にしてください。",
    invitation_recipient_mismatch: "この招待の宛先と、ログイン中のメールアドレスが一致しません。招待されたアカウントでログインしてください。",
    invitation_unavailable: "この招待は利用できません。期限切れか取り消し済みです。管理者に新しいリンクを依頼してください。",
    invitation_sender_inactive: "招待者の権限が変更されたため参加できません。管理者に新しいリンクを依頼してください。",
    invitation_already_used: "この招待は使用済みです。管理者に新しいリンクを依頼してください。",
    invalid_request: "入力を確認してください。名前は100文字・300バイト以内、空欄や制御文字は使えません。",
    workspace_required: "ワークスペースを選んでから送信してください。",
    workspace_not_found: "ワークスペースが見つからないか、現在は参加していません。一覧から選び直してください。",
    workspace_forbidden: "この操作はワークスペースの管理者だけが行えます。",
    admin_required: "この操作はワークスペースの管理者だけが行えます。",
    last_admin: "最後の管理者は変更・退出できません。先に別のメンバーを管理者にしてください。",
    last_admin_required: "管理者を1人以上残してください。先に別のメンバーを管理者にできます。",
    workspace_creation_limit: "作成できるワークスペースは3個までです。退出しても作成数は戻りません。招待されたワークスペースには引き続き参加できます。",
    workspace_limit_reached: "作成できるワークスペースは3個までです。退出しても作成数は戻りません。",
    invitation_not_found: "この招待は利用できません。期限切れ・取り消し・招待者の権限変更が考えられます。管理者に新しいリンクを依頼してください。",
    invitation_expired: "この招待の期限が切れています。管理者に新しいリンクを依頼してください。",
    invitation_email_mismatch: "この招待の宛先と、ログイン中のメールアドレスが一致しません。招待されたアカウントでログインしてください。",
    verified_email_required: "メールアドレスの確認が必要です。ログインサービスでメールを確認した後、ログアウトしてログインし直してください。",
    email_verification_required: "確認済みメールアドレスが必要です。ログインサービスで確認し、ログインし直してください。",
    group_not_found: "このグループは見つかりません。画面を更新してください。",
    member_not_found: "このメンバーは現在参加していません。画面を更新してください。",
    idempotency_conflict: "この受付キーは別の内容で使用済みです。画面を更新し、新しい操作として入力してください。",
    api_unavailable: "受付結果を確認できませんでした。画面を更新して状態を確認してください。同じ内容で再送しても作成は増えません。",
  };
  return messages[code] ?? runErrorMessage(code);
}
