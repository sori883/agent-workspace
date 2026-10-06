import { randomUUID } from "node:crypto";
import { useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/workspace-manage";
import type { WorkspaceDetail, InvitationCreateResult } from "../../shared/workspace-contracts";
import { requireAuth } from "../lib/auth.server";
import { workspacesClient } from "../lib/workspaces.server";
import { RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { accessLabels, businessLabels, workspaceError } from "../lib/workspace-copy";
import { Workspace } from "../components/workspace";
import { ActionNotice, Csrf, NameField } from "../components/organization";
export function meta() { return [{ title: "メンバー・設定 | AX ワークスペース" }]; }
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const session = await loadSession(request);
  const headers = pageHeaders(); if (session.cookie) headers.set("Set-Cookie", session.cookie);
  let detail: WorkspaceDetail | null = null, error: string | null = null, status = 200;
  try { detail = await workspacesClient(user.accessToken).get(params.workspaceId); } catch (cause) { error = workspaceError(cause instanceof RunApiError ? cause.code : "api_unavailable"); status = cause instanceof RunApiError ? cause.status : 503; }
  return data({ detail, error, csrf: session.csrf, userId: user.userId, groupKey: randomUUID(), inviteKey: randomUUID() }, { status, headers });
}
export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireAuth(request);
  let submitted = { intent: "", key: "", name: "", email: "", group_id: "" };
  const answer = (error: string | null, status = 200, invitation: InvitationCreateResult | null = null, invalid = false) => data({ error, submitted, invalid, invitation, inviteUrl: invitation?.token ? `${new URL(request.url).origin}/join?token=${invitation.token}` : null, message: error ? null : invitation ? invitation.replayed ? "発行済みのリンクは再表示できません。必要なら取り消して再発行してください。" : "招待リンクを発行しました。宛先の方へ渡してください。" : "変更を保存しました。" }, { status, headers: pageHeaders() });
  try {
    const form = await readLocalForm(request, ["csrf", "intent", "key", "name", "email", "user_id", "group_id", "invitation_id", "access_level", "business_role", "member", "confirm"]);
    submitted = { intent: form.get("intent") ?? "", key: form.get("key") ?? "", name: form.get("name") ?? "", email: form.get("email") ?? "", group_id: form.get("group_id") ?? "" };
    await verifySubmission(request, form.get("csrf"));
    const api = workspacesClient(user.accessToken), id = params.workspaceId;
    if (["remove_member", "delete_group", "leave"].includes(submitted.intent) && form.get("confirm") !== "yes") return answer("変更内容を確認してチェックを入れてください。", 400);
    switch (submitted.intent) {
      case "rename": await api.rename(id, { name: submitted.name }); break;
      case "member": await api.member(id, form.get("user_id") ?? "", { access_level: form.get("access_level"), business_role: form.get("business_role") }); break;
      case "remove_member": await api.removeMember(id, form.get("user_id") ?? ""); break;
      case "leave": await api.leave(id); return redirect("/workspaces", { status: 303, headers: pageHeaders() });
      case "create_group": await api.createGroup(id, { key: submitted.key, name: submitted.name }); break;
      case "rename_group": await api.renameGroup(id, form.get("group_id") ?? "", { name: submitted.name }); break;
      case "delete_group": await api.deleteGroup(id, form.get("group_id") ?? ""); break;
      case "group_member": await api.groupMember(id, form.get("group_id") ?? "", form.get("user_id") ?? "", { member: form.get("member") === "yes" }); break;
      case "invite": return answer(null, 200, await api.invite(id, { key: submitted.key, email: submitted.email }));
      case "revoke_invitation": await api.revokeInvitation(id, form.get("invitation_id") ?? ""); break;
      default: return answer("操作を確認してください。", 400);
    }
    return answer(null);
  } catch (cause) { return answer(cause instanceof Response ? await cause.text() : cause instanceof RunApiError && cause.code === "invalid_request" && submitted.intent === "invite" ? "メールアドレスを254文字以内で正しく入力してください。" : workspaceError(cause instanceof RunApiError ? cause.code : "api_unavailable"), cause instanceof Response || cause instanceof RunApiError ? cause.status : 503, null, cause instanceof RunApiError && cause.code === "invalid_request"); }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => { const result = pageHeaders(); for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value)); return result; };
function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  return <div className="invite-link"><label htmlFor="invite-link">今回発行した招待リンク</label><p id="invite-link-hint">リンクはこの画面で一度だけ表示します。コピーして招待先へ渡してください。</p><input id="invite-link" className="text-input" value={url} readOnly aria-describedby="invite-link-hint" onFocus={(event) => event.currentTarget.select()} /><button className="button button-secondary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setFailed(false); } catch { setFailed(true); } }}>リンクをコピー</button><p role="status">{copied ? "コピーしました。" : failed ? "リンク欄を選択してコピーしてください。" : "手動でもリンク欄を選択してコピーできます。"}</p></div>;
}
export default function ManageWorkspace({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const detail = loaderData.detail, csrf = loaderData.csrf;
  const admin = detail?.workspace.access_level === "admin";
  const lastAdmin = detail?.members.filter((member) => member.access_level === "admin").length === 1;
  return <Workspace title={detail?.workspace.name ?? "ワークスペース"} intro="メンバー、グループ、参加の設定を確認できます。">
    <div className="org-actions"><a href="/workspaces">← ワークスペース一覧</a>{detail && <a className="button button-primary" href={`/?workspace=${detail.workspace.id}`}>チャットを開く</a>}</div>
    <ActionNotice error={actionData?.error ?? loaderData.error} message={actionData?.message} />
    {detail && <>
      <p className="org-private-note">会話と実行履歴は本人だけが閲覧できます。管理者にも他の人の会話は公開されません。</p>
      <section className="org-section" aria-labelledby="workspace-info"><h2 id="workspace-info">ワークスペースの設定</h2>{admin ? <Form method="post" className="org-form"><Csrf value={csrf} intent="rename" /><NameField id="workspace-name" label="ワークスペース名" value={actionData?.error && actionData.submitted.intent === "rename" ? actionData.submitted.name : detail.workspace.name} invalid={actionData?.invalid && actionData.submitted.intent === "rename"} /><button className="button button-secondary" disabled={pending}>名前を保存</button></Form> : <p>設定の変更は管理者に依頼してください。</p>}</section>
      <section className="org-section" aria-labelledby="members-title"><h2 id="members-title">メンバー</h2><p>操作権限と業務ロールは別の設定です。業務ロールだけで管理権限が増えることはありません。</p><ul className="org-cards">{detail.members.map((member) => <li key={`${member.user_id}:${member.access_level}:${member.business_role}`} data-testid="workspace-member"><h3>{member.display_name}{member.user_id === loaderData.userId && "（あなた）"}</h3><p>操作権限：{accessLabels[member.access_level]} ／ 業務ロール：{businessLabels[member.business_role]}</p>{admin && <><Form method="post" className="org-form"><Csrf value={csrf} intent="member" /><input type="hidden" name="user_id" value={member.user_id} /><fieldset className="org-options"><legend>操作権限</legend><label><input type="radio" name="access_level" value="admin" defaultChecked={member.access_level === "admin"} />管理者</label><label><input type="radio" name="access_level" value="member" defaultChecked={member.access_level === "member"} disabled={lastAdmin && member.access_level === "admin"} />一般メンバー</label></fieldset><fieldset className="org-options"><legend>業務ロール</legend><label><input type="radio" name="business_role" value="general" defaultChecked={member.business_role === "general"} />一般</label><label><input type="radio" name="business_role" value="developer" defaultChecked={member.business_role === "developer"} />開発者</label></fieldset>{lastAdmin && member.access_level === "admin" && <p className="field-hint">最後の管理者のため、一般メンバーへの変更や削除はできません。</p>}<button className="button button-secondary" disabled={pending}>メンバーの設定を保存</button></Form>{!(lastAdmin && member.access_level === "admin") && member.user_id !== loaderData.userId && <details className="org-danger"><summary>このメンバーを外す</summary><Form method="post"><Csrf value={csrf} intent="remove_member" /><input type="hidden" name="user_id" value={member.user_id} /><label className="org-check"><input type="checkbox" name="confirm" value="yes" required />所属とグループ参加を解除することを確認しました</label><button className="button button-secondary" disabled={pending}>メンバーを外す</button></Form></details>}</>}</li>)}</ul></section>
      <section className="org-section" aria-labelledby="groups-title"><h2 id="groups-title">グループ</h2><p>部署やプロジェクトなどのまとまりです。1人が複数のグループへ参加できます。</p>{detail.groups.length === 0 && <p>グループはまだありません。</p>}<ul className="org-cards">{detail.groups.map((group) => <li key={`${group.id}:${group.name}:${group.member_user_ids.join(",")}`} data-testid="workspace-group"><h3>{group.name}</h3>{admin && <Form method="post" className="org-form"><Csrf value={csrf} intent="rename_group" /><input type="hidden" name="group_id" value={group.id} /><NameField id={`group-${group.id}`} label="グループ名" value={actionData?.error && actionData.submitted.intent === "rename_group" && actionData.submitted.group_id === group.id ? actionData.submitted.name : group.name} invalid={actionData?.invalid && actionData.submitted.intent === "rename_group" && actionData.submitted.group_id === group.id} /><button className="button button-secondary" disabled={pending}>グループ名を保存</button></Form>}<h4>参加メンバー</h4>{admin ? detail.members.map((member) => <Form method="post" className="group-member-form" key={member.user_id}><Csrf value={csrf} intent="group_member" /><input type="hidden" name="group_id" value={group.id} /><input type="hidden" name="user_id" value={member.user_id} /><label className="org-check"><input type="checkbox" name="member" value="yes" defaultChecked={group.member_user_ids.includes(member.user_id)} />{member.display_name}</label><button className="button button-secondary" disabled={pending}>参加を保存<span className="visually-hidden">（{member.display_name}）</span></button></Form>) : <ul>{detail.members.filter((member) => group.member_user_ids.includes(member.user_id)).map((member) => <li key={member.user_id}>{member.display_name}</li>)}</ul>}{admin && <details className="org-danger"><summary>このグループを削除する</summary><Form method="post"><Csrf value={csrf} intent="delete_group" /><input type="hidden" name="group_id" value={group.id} /><label className="org-check"><input type="checkbox" name="confirm" value="yes" required />グループと参加設定を削除することを確認しました</label><button className="button button-secondary" disabled={pending}>グループを削除</button></Form></details>}</li>)}</ul>{admin && <Form method="post" className="org-form"><h3>グループを作成</h3><Csrf value={csrf} intent="create_group" /><input type="hidden" name="key" value={actionData?.error && actionData.submitted.intent === "create_group" ? actionData.submitted.key : loaderData.groupKey} /><NameField id="new-group-name" label="新しいグループ名" value={actionData?.error && actionData.submitted.intent === "create_group" ? actionData.submitted.name : ""} invalid={actionData?.invalid && actionData.submitted.intent === "create_group"} /><button className="button button-primary" disabled={pending}>グループを作成</button></Form>}</section>
      {admin && <section className="org-section" aria-labelledby="invitations-title"><h2 id="invitations-title">招待</h2><p>招待先のメールアドレスを指定します。リンクは7日間有効です。メールは自動送信されません。</p>{actionData?.inviteUrl && <InviteLink key={actionData.inviteUrl} url={actionData.inviteUrl} />}<Form method="post" className="org-form"><Csrf value={csrf} intent="invite" /><input type="hidden" name="key" value={actionData?.error && actionData.submitted.intent === "invite" ? actionData.submitted.key : loaderData.inviteKey} /><div className="run-field"><label htmlFor="invite-email">招待先メールアドレス<span className="required-label">必須</span></label><p className="field-hint" id="invite-email-hint">参加時に、確認済みのログインメールアドレスとの一致を確かめます。</p><input id="invite-email" className="text-input" name="email" type="email" required aria-invalid={actionData?.invalid && actionData.submitted.intent === "invite" || undefined} defaultValue={actionData?.error && actionData.submitted.intent === "invite" ? actionData.submitted.email : ""} aria-describedby="invite-email-hint" /></div><button className="button button-primary" disabled={pending}>招待リンクを発行</button></Form><h3>発行済みの招待</h3>{detail.invitations.length === 0 ? <p>招待はまだありません。</p> : <ul className="org-cards">{detail.invitations.map((invite) => <li key={invite.id}><strong>{invite.email}</strong><p>{({ pending: "参加待ち", accepted: "参加済み", revoked: "取り消し済み", expired: "期限切れ" })[invite.status]} ／ 期限：{invite.expires_at.replace("T", " ").replace("Z", " UTC")}</p>{invite.status === "pending" && <Form method="post"><Csrf value={csrf} intent="revoke_invitation" /><input type="hidden" name="invitation_id" value={invite.id} /><button className="button button-secondary" disabled={pending}>招待を取り消す</button></Form>}</li>)}</ul>}</section>}
      <section className="org-section"><h2>ワークスペースから退出</h2>{admin && lastAdmin ? <p>最後の管理者は退出できません。先に別のメンバーを管理者にしてください。</p> : <details><summary>退出の確認を開く</summary><Form method="post"><Csrf value={csrf} intent="leave" /><p>このワークスペースの履歴へのアクセスと、グループ参加が解除されます。記録は削除されません。</p><label className="org-check"><input type="checkbox" name="confirm" value="yes" required />退出することを確認しました</label><button className="button button-secondary" disabled={pending}>ワークスペースから退出する</button></Form></details>}</section>
    </>}
  </Workspace>;
}
