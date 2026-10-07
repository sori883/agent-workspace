export function definitionErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    invalid_request: "入力条件を確認してください。名前・指示・補助ファイルの長さや形式が上限を超えている可能性があります。",
    request_too_large: "保存できる大きさを超えています。指示や補助ファイルの内容を短くしてください。",
    definition_not_found: "この設定は見つからないか、閲覧できません。",
    definition_version_not_found: "選んだスキルの版は見つからないか、閲覧できません。",
    workspace_not_found: "このワークスペースを利用できません。所属を確認してください。",
    definition_forbidden: "共有設定を編集できるのは、作成者とワークスペース管理者です。本人用設定は作成者だけが編集できます。",
    definition_revision_conflict: "別の変更が保存されています。入力内容を控えてからページを再読み込みし、変更を確認してください。",
    idempotency_conflict: "前の送信と内容が異なります。入力内容を控えてからページを再読み込みしてください。",
    definition_archived: "この設定は利用を終了しています。必要ならコピーして新しく登録してください。",
    definition_dependency_unavailable: "選んだスキルを利用できません。共有範囲や利用終了の状態を確認し、選び直してください。",
    definition_count_limit: "このワークスペースで登録できる数（本人が作成した設定100件）に達しました。利用終了した設定も含みます。",
    definition_version_limit: "この設定の公開回数（100回）に達しました。コピーして新しく登録してください。",
    definition_quota_exceeded: "設定の保存容量が上限に達しました。管理者にお問い合わせください。",
    submission_expired: "ページの有効期限が切れた可能性があります。入力内容を控えてから再読み込みしてください。",
    unauthorized: "ログインの有効期限が切れました。もう一度ログインしてください。",
  };
  return messages[code] ?? "保存・取得の結果を確認できませんでした。入力内容を変えずにもう一度お試しください。";
}
export const definitionKindLabel = { skill: "スキル", agent: "エージェント" };
export const definitionVisibilityLabel = { personal: "自分だけ", workspace: "ワークスペース共有" };
