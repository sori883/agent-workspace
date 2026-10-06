import { requireAuth } from "../lib/auth.server";
import { useEffect, useRef, useState } from "react";
import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/home";
import { apiClient, ApiUnavailable } from "../lib/api.server";
import { assertLocalRequest, loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { checkInputSchema, MAX_MESSAGE_LENGTH, type CheckResult } from "../../shared/contracts";
import { readLimitedText } from "../../shared/http";

export function meta() {
  return [{ title: "接続を確かめる | AX ワークスペース" }, { name: "description", content: "AXワークスペースのローカル接続テスト。" }];
}
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const session = await loadSession(request);
  let connected = false;
  try { await apiClient(user.accessToken).status(); connected = true; }
  catch (error) { if (!(error instanceof ApiUnavailable)) throw error; }
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  return data({ connected, csrf: session.csrf }, { headers });
}
type Submission = { ok: true; result: CheckResult; submitted: string } | { ok: false; error: string; fieldError: boolean; submitted: string; connectionFailed: boolean };
export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  let submitted = "";
  const failure = (error: string, status: number, fieldError = false, connectionFailed = false) => data<Submission>({ ok: false, error, fieldError, submitted, connectionFailed }, { status, headers: pageHeaders() });
  try {
    assertLocalRequest(request);
    if (request.method !== "POST" || request.headers.get("origin") !== new URL(request.url).origin) return failure("このページから送信してください。", 403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") return failure("フォームからメッセージを送信してください。", 415);
    const form = new URLSearchParams(await readLimitedText(request));
    if (form.getAll("message").length !== 1 || form.getAll("csrf").length !== 1 || [...form.keys()].some((key) => key !== "message" && key !== "csrf")) return failure("入力内容を確認してください。", 400, true);
    submitted = form.get("message") ?? "";
    await verifySubmission(request, form.get("csrf"));
    const parsed = checkInputSchema.safeParse({ message: submitted });
    if (!parsed.success) return failure("メッセージを1〜200文字で入力してください。", 400, true);
    const result = await apiClient(user.accessToken).check(parsed.data);
    return data<Submission>({ ok: true, result, submitted }, { headers: pageHeaders() });
  } catch (error) {
    if (error instanceof Response) return failure(await error.text(), error.status);
    if (error instanceof ApiUnavailable) return failure(error.message, 503, false, true);
    return failure("送信を完了できませんでした。もう一度お試しください。", 500);
  }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};
function Mark({ kind = "check" }: { kind?: "check" | "arrow" | "info" | "grid" }) {
  const paths = { check: "m5 12 4 4L19 6", arrow: "M4 12h15m-6-6 6 6-6 6", info: "M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", grid: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" };
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const [message, setMessage] = useState(actionData?.submitted ?? "接続を確認します。");
  const [initialMessage] = useState(() => {
    if (typeof document === "undefined") return actionData?.submitted ?? "接続を確認します。";
    const input = document.getElementById("message");
    return input instanceof HTMLTextAreaElement ? input.value : actionData?.submitted ?? "接続を確認します。";
  });
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (messageRef.current) setMessage(messageRef.current.value); }, []);
  useEffect(() => { if (actionData && !pending) resultRef.current?.focus(); }, [actionData, pending]);
  const error = actionData?.ok === false ? actionData : null;
  const connected = actionData?.ok ? true : error?.connectionFailed ? false : loaderData.connected;
  return (
    <>
      <a className="skip-link" href="#main">本文へ移動</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="AX ワークスペース ホーム"><span className="brand-symbol" aria-hidden="true">ax<span>.</span></span><span className="brand-name">ワークスペース</span></a>
        <span className="environment-chip"><span className="status-dot" />ローカル環境</span>
      </header>
      <div className="page-frame">
        <aside className="sidebar">
          <p className="sidebar-label">WORKSPACE</p>
          <nav aria-label="ページ内ナビゲーション">
            <a className="nav-current" href="#main"><Mark kind="grid" />接続確認</a>
            <a href="#environment">利用環境<Mark kind="arrow" /></a>
            <a href="#about">この画面について<Mark kind="arrow" /></a>
          </nav>
          <div className="sidebar-foot"><span className="sidebar-rule" /><strong>小さく試して、<br />確かに進める。</strong><p>エージェントを使うための<br />最初のワークスペース。</p></div>
        </aside>
        <main id="main" tabIndex={-1}>
          <div className="page-heading"><p className="eyebrow">GETTING STARTED <span>01</span></p><h1>接続を確かめる</h1><p className="lead">短いメッセージを送って、<br className="mobile-break" />作業を始める準備をしましょう。</p></div>
          <div className="mode-notice"><Mark kind="info" /><p><strong>接続テスト用の画面です。</strong><span>入力したメッセージをそのまま返します。エージェントの実行やモデルの利用料金は発生しません。</span></p></div>
          <div className="workspace-grid">
            <section className="check-panel" aria-labelledby="check-title">
              <div className="section-heading"><span className="step-number">01</span><div><h2 id="check-title">メッセージを送る</h2><p>まずは、そのまま送信してみてください。</p></div></div>
              <Form method="post" noValidate>
                <input type="hidden" name="csrf" value={loaderData.csrf} />
                <label htmlFor="message">確認用のメッセージ<span className="required-label">必須</span></label>
                <p className="field-hint" id="message-hint">200文字以内で入力してください。</p>
                <textarea ref={messageRef} id="message" name="message" rows={5} maxLength={MAX_MESSAGE_LENGTH} defaultValue={initialMessage} onChange={(event) => setMessage(event.target.value)} aria-invalid={error?.fieldError || undefined} aria-describedby={`message-hint message-count${error?.fieldError ? " message-error" : ""}`} />
                <div className="field-bottom"><span>{error?.fieldError && <span id="message-error" className="field-error">{error.error}</span>}</span><span id="message-count" className="character-count">{message.length} / 200</span></div>
                <button className="button button-primary" type="submit" disabled={pending}>{pending ? "接続を確認しています…" : "送信して接続を確認"}<Mark kind="arrow" /></button>
              </Form>
              <div className="result-region" aria-live="polite" aria-atomic="true">
                {actionData ? <div ref={resultRef} tabIndex={-1} className={`result ${actionData.ok ? "result-success" : "result-error"}`}>
                  <div className="result-heading"><Mark kind={actionData.ok ? "check" : "info"} /><h3>{actionData.ok ? "メッセージが届きました" : "送信を完了できませんでした"}</h3></div>
                  {actionData.ok ? <><p className="result-caption">接続先から返ってきたメッセージ</p><p className="returned-message">{actionData.result.receivedText}</p><p className="receipt">確認番号 <span>{actionData.result.requestId}</span></p></> : <p>{actionData.error}</p>}
                </div> : <div className="empty-result"><span className="empty-result-line" /><p>送信すると、ここに確認結果が表示されます。</p></div>}
              </div>
            </section>
            <aside className="environment-panel" id="environment" aria-labelledby="environment-title">
              <p className="eyebrow">YOUR ENVIRONMENT</p><h2 id="environment-title">利用環境</h2>
              <div className={`connection-state ${connected ? "is-connected" : "is-disconnected"}`}><span className="status-dot" /><strong>{connected ? "接続の準備ができています" : "接続先を確認できません"}</strong></div>
              <dl className="environment-list"><div><dt>操作画面</dt><dd>利用できます</dd></div><div><dt>接続先</dt><dd>{connected ? "応答しています" : "応答がありません"}</dd></div><div><dt>実行モード</dt><dd>接続テスト</dd></div><div><dt>モデル利用</dt><dd>なし</dd></div></dl>
              <p className="environment-note">このパソコンの中だけで動作しています。</p>
            </aside>
          </div>
          <section className="about-section" id="about" aria-labelledby="about-title"><p className="eyebrow">NEXT STEP</p><h2 id="about-title">エージェントで作業を始める</h2><p>接続を確認できたら、指示を渡して実行と成果物の確認へ進めます。</p><a className="button button-primary" href="/">エージェントを実行する</a></section>
          <footer className="page-footer"><span>AX WORKSPACE</span><span>ローカルプレビュー</span></footer>
        </main>
      </div>
    </>
  );
}
