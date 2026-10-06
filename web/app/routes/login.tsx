import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { beginLogin } from "../lib/auth.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";

export function meta() { return [{ title: "ログイン | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.append("Set-Cookie", session.cookie);
  const params = new URL(request.url).searchParams;
  return data({ csrf: session.csrf, error: params.has("error"), expired: params.has("expired") }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  const form = await readLocalForm(request, ["csrf"]);
  await verifySubmission(request, form.get("csrf"));
  try { return await beginLogin(request); }
  catch { return data({ error: "ログインサービスに接続できませんでした。しばらくしてからもう一度お試しください。" }, { status: 503, headers: pageHeaders() }); }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};
export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  return <><a className="skip-link" href="#main">本文へ移動</a><header className="site-header"><a className="brand" href="/login"><span className="brand-symbol" aria-hidden="true">ax<span>.</span></span><span className="brand-name">ワークスペース</span></a><span className="environment-chip">ローカル環境</span></header>
    <main id="main" className="auth-page" tabIndex={-1}><p className="eyebrow">YOUR WORKSPACE</p><h1>会話を、あなたの場所に。</h1><p className="lead">ログインして、質問や相談の続きを始めましょう。会話と実行結果は、あなたのアカウントで確認できます。</p>
      <section className="auth-card" aria-labelledby="login-heading"><h2 id="login-heading">ワークスペースにログイン</h2><p>メールアドレスとパスワード、または登録済みのパスキーを使えます。</p>
        {(actionData?.error || loaderData.error) && <p className="field-error" role="alert">{actionData?.error ?? "ログインを確認できませんでした。もう一度、ログインからやり直してください。"}</p>}
        {loaderData.expired && <p role="status">ログインの有効期限が切れました。もう一度ログインしてください。</p>}
        <Form method="post"><input type="hidden" name="csrf" value={loaderData.csrf} /><button className="button button-primary" type="submit" disabled={navigation.state !== "idle"}>{navigation.state === "idle" ? "ログインへ進む" : "ログイン画面を開いています"}</button></Form>
        <p className="field-hint">初めての方は、管理者から案内されたアカウントをお使いください。パスキーはログイン後の「アカウント」から登録できます。</p>
      </section><p className="field-hint">安全のため、ログインは最大30分で有効期限が切れます。</p>
    </main></>;
}
