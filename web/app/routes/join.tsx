import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/join";
import { invitationTokenSchema } from "../../shared/workspace-contracts";
import { requireAuth } from "../lib/auth.server";
import { workspacesClient } from "../lib/workspaces.server";
import { RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { workspaceError } from "../lib/workspace-copy";
import { Workspace } from "../components/workspace";
import { ActionNotice, Csrf } from "../components/organization";
export function meta() { return [{ title: "招待への参加 | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const session = await loadSession(request), headers = pageHeaders(); if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const tokens = new URL(request.url).searchParams.getAll("token");
  const token = tokens.length === 1 ? invitationTokenSchema.safeParse(tokens[0]) : null;
  return data({ csrf: session.csrf, token: token?.success ? token.data : null, email: user.verifiedEmail, name: user.displayName }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  try { const form = await readLocalForm(request, ["csrf", "token"]); await verifySubmission(request, form.get("csrf")); const result = await workspacesClient(user.accessToken).accept({ token: form.get("token") }); return redirect(`/workspaces/${result.workspace.id}`, { status: 303, headers: pageHeaders() }); }
  catch (cause) { return data({ error: cause instanceof Response ? await cause.text() : workspaceError(cause instanceof RunApiError ? cause.code : "api_unavailable") }, { status: cause instanceof Response || cause instanceof RunApiError ? cause.status : 503, headers: pageHeaders() }); }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => { const result = pageHeaders(); for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value)); return result; };
export default function Join({ loaderData, actionData }: Route.ComponentProps) {
  const pending = useNavigation().state !== "idle";
  return <Workspace title="ワークスペースへの招待" intro="招待されたメールアドレスで参加してください。"><ActionNotice error={actionData?.error} /><section className="org-section"><h2>参加するアカウント</h2><p>{loaderData.name}</p>{loaderData.email ? <p>確認済みメール：{loaderData.email}</p> : <p>メールアドレスの確認が必要です。ログインサービスで確認してから、ログアウトしてログインし直してください。</p>}{loaderData.token ? <><p>「参加する」を押すと招待の有効性と宛先を確認します。一般メンバー・業務ロール「一般」として参加します。</p><Form method="post"><Csrf value={loaderData.csrf} /><input type="hidden" name="token" value={loaderData.token} /><button className="button button-primary" disabled={pending || !loaderData.email}>参加する</button></Form></> : <p>招待リンクが正しくありません。管理者に新しいリンクを依頼してください。</p>}<p><a href="/account">アカウントを確認する・ログアウト</a></p><p><a href="/workspaces">ワークスペース一覧へ戻る</a></p></section></Workspace>;
}
