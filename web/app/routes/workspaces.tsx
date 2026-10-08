import { randomUUID } from "node:crypto";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/workspaces";
import { requireAuth } from "../lib/auth.server";
import { workspacesClient } from "../lib/workspaces.server";
import { RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { accessLabels, businessLabels, workspaceError } from "../lib/workspace-copy";
import { Workspace } from "../components/workspace";
import { ActionNotice, Csrf, NameField } from "../components/organization";
import type { WorkspaceList } from "../../shared/workspace-contracts";
export function meta() { return [{ title: "ワークスペース | AX" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const session = await loadSession(request);
  const headers = pageHeaders(); if (session.cookie) headers.set("Set-Cookie", session.cookie);
  let list: WorkspaceList | null = null, error: string | null = null;
  try { list = await workspacesClient(user.accessToken).list(); } catch (cause) { error = workspaceError(cause instanceof RunApiError ? cause.code : "api_unavailable"); }
  return data({ list, error, csrf: session.csrf, key: randomUUID(), userId: user.userId }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  let submitted = { key: "", name: "" };
  try {
    const form = await readLocalForm(request, ["csrf", "key", "name"]);
    submitted = { key: form.get("key") ?? "", name: form.get("name") ?? "" };
    await verifySubmission(request, form.get("csrf"));
    const result = await workspacesClient(user.accessToken).create(submitted);
    return redirect(`/workspaces/${result.workspace.id}`, { status: 303, headers: pageHeaders() });
  } catch (cause) { return data({ submitted, invalid: cause instanceof RunApiError && cause.code === "invalid_request", error: cause instanceof Response ? await cause.text() : workspaceError(cause instanceof RunApiError ? cause.code : "api_unavailable") }, { status: cause instanceof Response || cause instanceof RunApiError ? cause.status : 503, headers: pageHeaders() }); }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => { const result = pageHeaders(); for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value)); return result; };
export default function Workspaces({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  const list = loaderData.list;
  return <Workspace title="ワークスペース" intro="会社や組織ごとに、参加する場所を選びます。">
    <ActionNotice error={actionData?.error ?? loaderData.error} />
    <section className="org-section" aria-labelledby="joined-title"><h2 id="joined-title">参加中のワークスペース</h2>
      {list?.workspaces.length === 0 && <p className="empty-result">まだ参加していません。新しく作成するか、管理者から招待リンクを受け取ってください。</p>}
      <ul className="org-cards">{list?.workspaces.map((workspace) => <li key={workspace.id}><h3>{workspace.name}</h3>{workspace.owner_user_id === loaderData.userId && <p>あなたが所有しています</p>}<p>操作権限：{accessLabels[workspace.access_level]} ／ 業務ロール：{businessLabels[workspace.business_role]}</p><div className="org-actions"><a className="button button-primary" href={`/workbench?workspace=${workspace.id}`}>エージェントを開く</a><a href={`/workspaces/${workspace.id}`}>メンバー・設定</a></div></li>)}</ul>
    </section>
    <section className="org-section" aria-labelledby="create-title"><h2 id="create-title">ワークスペースを作成</h2><p>1人につき50個まで所有できます。譲渡が承諾されると、また1個所有できるようになります。招待での参加数に上限はありません。</p>{list && <p>所有中：{list.owned_count} / {list.ownership_limit}</p>}
      {list && list.owned_count < list.ownership_limit ? <Form method="post" className="org-form"><Csrf value={loaderData.csrf} /><input type="hidden" name="key" value={actionData?.submitted.key || loaderData.key} /><NameField id="workspace-name" label="ワークスペース名" value={actionData?.submitted.name ?? ""} invalid={actionData?.invalid} /><button className="button button-primary" disabled={pending}>作成する</button></Form> : list && <p>所有できる上限に達しています。新しく作成するには、所有中のワークスペースを他のメンバーへ譲渡してください。</p>}
    </section><section className="org-section"><h2>以前の本人限定履歴</h2><p>所属を導入する前の会話や実行は、他のメンバーに共有されません。読み取りと終了確認ができます。</p><div className="org-actions"><a href="/?legacy=1">以前のチャット</a><a href="/tasks?legacy=1">以前の実行</a></div></section>
  </Workspace>;
}
