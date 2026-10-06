import { data, Form } from "react-router";
import type { Route } from "./+types/account";
import { beginLogin, logout, requireAuth } from "../lib/auth.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { readAuthConfig } from "../../server/auth-config";
import { Workspace } from "../components/workspace";
export function meta() { return [{ title: "アカウント | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.append("Set-Cookie", session.cookie);
  return data({ displayName: user.displayName, csrf: session.csrf, accountUrl: `${readAuthConfig().issuer}/account/account-security/signing-in` }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  await requireAuth(request);
  const form = await readLocalForm(request, ["csrf", "intent"]);
  await verifySubmission(request, form.get("csrf"));
  if (form.get("intent") === "logout") return logout(request);
  if (form.get("intent") === "passkey") return beginLogin(request, true);
  throw new Response("操作を確認してください。", { status: 400, headers: pageHeaders() });
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};
export default function Account({ loaderData }: Route.ComponentProps) {
  return <Workspace title="アカウント" intro="ログイン方法を管理できます。"><section className="auth-card"><h2>ログイン中のアカウント</h2><p>{loaderData.displayName}</p><h2>パスキー</h2><p>端末の顔認証・指紋認証・画面ロックなどを使ってログインできます。</p>
    <Form method="post"><input type="hidden" name="csrf" value={loaderData.csrf} /><button className="button button-primary" name="intent" value="passkey">パスキーを登録する</button></Form>
    <p><a href={loaderData.accountUrl}>登録済みのパスキー・パスワードを管理する</a></p><p className="field-hint">パスキーを使えないときは、メールアドレスとパスワードでログインできます。</p><hr />
    <Form method="post"><input type="hidden" name="csrf" value={loaderData.csrf} /><button className="button button-secondary" name="intent" value="logout">ログアウト</button></Form>
  </section></Workspace>;
}
