import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";
import { scopeHref } from "../lib/workspace-scope";
import { requireAuth } from "../lib/auth.server";
import { createHash, randomUUID } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/chat";
import { chatInputSchema, type ConversationDetail, type ConversationSummary } from "../../shared/chat-contracts";
import { chatsClient } from "../lib/chats.server";
import { runsClient, RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { runErrorMessage } from "../lib/run-copy";
import { LegacyNotice } from "../components/organization";
import { Notice, useRunRefresh, Workspace } from "../components/workspace";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function draftKey(id: string, head: string | null) {
  const bytes = createHash("sha256").update(`ax-chat:${id}:${head ?? "new"}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function chatError(code: string) {
  const messages: Record<string, string> = {
    conversation_conflict: "別の画面から会話が更新されています。会話を読み直してから続きを送ってください。",
    conversation_busy: "前の返答を待っています。完了してから続きを送れます。",
    conversation_context_full: "この会話で扱える長さに達しました。新しいチャットを始めてください。",
    invalid_conversation_state: "会話の記録を確認できませんでした。実行の詳細から状態を確認してください。",
    conversation_not_found: "この会話は見つかりませんでした。",
    idempotency_conflict: "この送信はすでに受け付けています。会話を読み直してから続きを送ってください。",
    bridge_unavailable: "受付結果を確認できませんでした。会話を更新するか、同じ内容で再送してください。",
    api_unavailable: "受付結果を確認できませんでした。会話を更新するか、同じ内容で再送してください。",
  };
  return messages[code] ?? runErrorMessage(code);
}
export function meta() { return [{ title: "チャット | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const selectedName = workspaceTitle(user.accessToken, scope);
  const rawId = new URL(request.url).searchParams.get("conversation");
  if (!rawId || !uuidPattern.test(rawId)) return redirect(scopeHref(`/?conversation=${randomUUID()}`, scope), { headers });
  const id = rawId.toLowerCase();
  let conversations: ConversationSummary[] = [];
  let conversation: ConversationDetail | null = null;
  let error: string | null = null;
  const client = chatsClient(user.accessToken, undefined, undefined, scope.workspaceId);
  const results = await Promise.allSettled([client.list(), client.get(id)]);
  if (results[0].status === "fulfilled") conversations = results[0].value.conversations;
  else error = results[0].reason instanceof RunApiError ? runErrorMessage(results[0].reason.code) : "会話一覧を取得できませんでした。接続を確認してから更新してください。";
  if (results[1].status === "fulfilled") conversation = results[1].value;
  else if (!(results[1].reason instanceof RunApiError && results[1].reason.code === "conversation_not_found")) error = results[1].reason instanceof RunApiError ? runErrorMessage(results[1].reason.code) : "会話を取得できませんでした。接続を確認してから更新してください。";
  if (conversation?.agent_root_id) return redirect(scopeHref(`/agent?root=${conversation.agent_root_id}`, scope), { headers });
  const head = conversation?.conversation.head_run_id ?? null;
  return data({ scope, workspaceName: await selectedName, csrf: session.csrf, id, key: draftKey(id, head), conversation, conversations, error }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  let submitted = { id: "", key: "", parent_run_id: null as string | null, text: "", allow_model: false };
  const failure = (error: string, status: number) => data({ error, submitted, uncertain: status === 503 }, { status, headers: pageHeaders() });
  try {
    const form = await readLocalForm(request, ["csrf", "id", "key", "parent_run_id", "text", "allow_model", "intent", "run_id"]);
    submitted = { id: form.get("id") ?? "", key: form.get("key") ?? "", parent_run_id: form.get("parent_run_id") || null, text: (form.get("text") ?? "").replace(/\r\n?/g, "\n"), allow_model: form.get("allow_model") === "yes" };
    await verifySubmission(request, form.get("csrf"));
    if (!uuidPattern.test(submitted.id)) return failure("会話を読み直してから送信してください。", 400);
    if (form.get("intent") === "recover") {
      const detail = await chatsClient(user.accessToken, undefined, undefined, scope.workspaceId).get(submitted.id);
      const last = detail.turns.at(-1)?.summary;
      if (!last || last.run_id !== form.get("run_id") || !last.can_recover) return failure("現在の状態を更新してから確認してください。", 409);
      await runsClient(user.accessToken, undefined, undefined, scope.workspaceId).recover(last.run_id);
    } else {
      if (scope.legacy) return failure("以前の履歴には送信できません。ワークスペースを選んで新しいチャットを始めてください。", 403);
      const { id, ...input } = submitted;
      const parsed = chatInputSchema.safeParse(input);
      if (!parsed.success) return failure("メッセージの長さと、モデル利用の確認を見直してください。", 400);
      await chatsClient(user.accessToken, undefined, undefined, scope.workspaceId).submit(id, parsed.data);
    }
    return redirect(scopeHref(`/?conversation=${submitted.id.toLowerCase()}`, scope), { status: 303, headers: pageHeaders() });
  } catch (cause) {
    if (cause instanceof Response) return failure(await cause.text(), cause.status);
    if (cause instanceof RunApiError) return failure(chatError(cause.code), cause.status);
    return failure("受付結果を確認できませんでした。同じ内容のまま再送するか、会話を更新してください。", 503);
  }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};

function Composer({ csrf, id, draft, parent, initial, consented, busy, waiting, uncertain }: { csrf: string; id: string; draft: string; parent: string | null; initial: string; consented: boolean; busy: boolean; waiting: boolean; uncertain: boolean }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [initialValue] = useState(() => {
    if (typeof document === "undefined") return initial;
    const field = document.getElementById("message");
    return field instanceof HTMLTextAreaElement && field.dataset.draft === draft ? field.value : initial;
  });
  const [count, setCount] = useState(new TextEncoder().encode(initial).length);
  useEffect(() => { if (textarea.current) setCount(new TextEncoder().encode(textarea.current.value).length); }, []);
  return <Form method="post" className="chat-composer" onKeyDown={(event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !busy) { event.preventDefault(); event.currentTarget.requestSubmit(); }
  }}>
    <input type="hidden" name="csrf" value={csrf} /><input type="hidden" name="id" value={id} /><input type="hidden" name="key" value={draft} /><input type="hidden" name="parent_run_id" value={parent ?? ""} />
    <label htmlFor="message">{uncertain ? "送信内容を確認" : "メッセージ"}</label>
    <p className="composer-hint" id="message-hint">質問や相談を書いてください。日本語で約680文字までが目安です。</p>
    <textarea ref={textarea} id="message" name="text" data-draft={draft} defaultValue={initialValue} required maxLength={2048} readOnly={uncertain} disabled={busy} aria-describedby="message-hint message-count" aria-invalid={count > 2048 || undefined} placeholder="今日は、何から考えましょうか。" onChange={(event) => setCount(new TextEncoder().encode(event.currentTarget.value).length)} />
    <div className="composer-meta"><span>Enterで改行 · Ctrl / ⌘ + Enterで送信</span><span id="message-count" className={count > 2048 ? "field-error" : ""}>{count.toLocaleString()} / 2,048 バイト</span></div>
    {consented ? <><input type="hidden" name="allow_model" value="yes" /><p className="chat-consent-note">送信すると、会話をGeminiへ送り、利用料金が発生します。</p></> : <div className="chat-consent"><label><input type="checkbox" name="allow_model" value="yes" required /><span>会話の外部送信とモデル利用料金を確認しました</span></label><p>会話をGeminiへ送信します。利用量には上限があり、送信した会話はこの環境に保存されます。</p></div>}
    <div className="composer-actions"><p>返答は完成すると表示されます。</p><button className="button button-primary" type="submit" disabled={busy || count > 2048}>{busy ? waiting ? "返答を待っています" : "送信できません" : uncertain ? "同じ内容を再送" : "送信する"}<span aria-hidden="true">↑</span></button></div>
  </Form>;
}

export default function Chat({ loaderData, actionData }: Route.ComponentProps) {
  const scope = loaderData.scope;
  const navigation = useNavigation();
  const [retainedAction, setRetainedAction] = useState(actionData);
  useEffect(() => { if (actionData) setRetainedAction(actionData); }, [actionData]);
  useEffect(() => { if (navigation.state === "submitting") setRetainedAction(undefined); }, [navigation.state]);
  const response = actionData ?? retainedAction;
  const detail = loaderData.conversation;
  const turns = detail?.turns ?? [];
  const last = turns.at(-1)?.summary;
  const working = !!last && (last.active || last.state === "accepted" || last.state === "running");
  const pending = navigation.state !== "idle";
  const end = useRef<HTMLDivElement>(null);
  const error = useRef<HTMLDivElement>(null);
  const previous = useRef(`${loaderData.id}:${turns.length}:${last?.state}`);
  useRunRefresh(working || !!response?.uncertain);
  useEffect(() => {
    const current = `${loaderData.id}:${turns.length}:${last?.state}`;
    if (previous.current !== current) { end.current?.scrollIntoView({ block: "nearest" }); previous.current = current; }
  }, [loaderData.id, turns.length, last?.state]);
  useEffect(() => { if (response) error.current?.focus(); }, [response]);
  const submitted = response?.submitted.key ? response.submitted : null;
  const blocked = !!loaderData.error || working || (detail !== null && !detail.can_send);
  const sidebar = <div className="chat-history">{!scope.legacy && <a href={scopeHref("/", scope)} className="new-chat-link"><span aria-hidden="true">＋</span> 新しいチャット</a>}<details open><summary>最近の会話</summary>{loaderData.conversations.length === 0 ? <p className="history-empty">送信すると、ここに<br />会話が並びます。</p> : <ul>{loaderData.conversations.map((item) => <li key={item.id}><a href={scopeHref(`/?conversation=${item.id}`, scope)} aria-current={item.id === loaderData.id ? "page" : undefined}><span>{item.title}</span><small>{item.turn_count}回のやり取り</small></a></li>)}</ul>}</details></div>;
  return <Workspace workspaceName={loaderData.workspaceName} title="チャット" intro="会話を重ねながら、一緒に考える。" sidebar={sidebar} chat>
    <div className="chat-shell">
      {scope.legacy && <LegacyNotice />}
      <div className="chat-toolbar"><span><span className="status-dot" /> AX エージェント <span className="chat-model">Gemini</span></span><a href={scopeHref(`/?conversation=${loaderData.id}`, scope)} className="chat-refresh">会話を更新</a></div>
      {loaderData.error && <Notice title="会話を表示できません" error><p>{loaderData.error}</p><p><a href="/workspaces">ワークスペースを選び直す</a></p><a href="/connection">接続確認を開く</a></Notice>}
      <div className="chat-thread" aria-label="会話">
        {turns.length === 0 && <div className="chat-welcome"><span className="chat-mark" aria-hidden="true">ax<span>.</span></span><h2>話してみることから、<br />始めましょう。</h2><p>考えを整理したり、文章を相談したり。<br />前のやり取りを踏まえて、会話を続けられます。</p><div className="chat-examples"><span>考えを整理する</span><span>文章を相談する</span><span>仕組みを理解する</span></div></div>}
        {turns.map((turn) => <div className="chat-turn" key={turn.summary.run_id}>
          <article className="chat-message user-message" aria-label="あなたのメッセージ"><div className="message-author">あなた</div><p>{turn.user}</p></article>
          {turn.assistant !== null && <article className="chat-message assistant-message" aria-label="エージェントの返答"><div className="message-author"><span className="agent-avatar" aria-hidden="true">ax.</span>AX エージェント</div><p>{turn.assistant}</p><a className="message-detail" href={scopeHref(`/runs/${turn.summary.run_id}`, scope)}>実行の詳細</a></article>}
          {turn.assistant === null && !turn.summary.active && !["accepted", "running"].includes(turn.summary.state) && <div className="chat-turn-error"><strong>{turn.summary.state === "not_started" ? "このメッセージは実行されませんでした" : "返答を完了できませんでした"}</strong><p>{turn.summary.can_recover ? "実行の終了状態を確認してから、続きを送れます。" : "この発言は、次の会話の文脈に含まれません。"}</p><a href={scopeHref(`/runs/${turn.summary.run_id}`, scope)}>実行の詳細を確認する</a></div>}
        </div>)}
        <div role="status" aria-live="polite" aria-atomic="true" className="chat-live-status">{working ? <p><span aria-hidden="true">⌛</span> エージェントが返答を準備しています。<small>この画面を閉じても処理は続きます。</small></p> : turns.length > 0 && last?.state === "succeeded" ? <span className="visually-hidden">返答が届きました。</span> : null}</div>
        <div ref={end} />
      </div>
      {last?.can_recover && <Form method="post" className="chat-recovery"><input type="hidden" name="csrf" value={loaderData.csrf} /><input type="hidden" name="id" value={loaderData.id} /><input type="hidden" name="intent" value="recover" /><input type="hidden" name="run_id" value={last.run_id} /><p>モデルを再実行せずに、終了状態を確認します。</p><button type="submit" className="button button-secondary" disabled={pending}>終了状態を確認する</button></Form>}
      {!scope.legacy && detail?.context_full && <Notice title="新しいチャットに続けましょう"><p>この会話で扱える長さに達しました。ここまでの会話は保存されています。</p><a href={scopeHref("/", scope)}>新しいチャットを始める</a></Notice>}
      {response && <div ref={error} tabIndex={-1} className="form-error"><Notice title="送信を確認してください" error><p>{response.error}</p>{response.uncertain && <p>受付結果が不明です。内容を変えずに再送すると、受け付け済みの実行は増えません。</p>}<a href={scopeHref(`/?conversation=${loaderData.id}`, scope)}>会話を読み直す</a></Notice></div>}
      {!scope.legacy && !detail?.context_full && <Composer key={submitted?.key ?? loaderData.key} csrf={loaderData.csrf} id={loaderData.id} draft={submitted?.key ?? loaderData.key} parent={submitted ? submitted.parent_run_id : detail?.conversation.head_run_id ?? null} initial={submitted?.text ?? ""} consented={submitted?.allow_model || turns.length > 0} busy={pending || blocked} waiting={pending || working} uncertain={response?.uncertain ?? false} />}
      {!scope.legacy && <p className="chat-footnote">短い会話に対応しています。会話が長くなると、新しいチャットをご案内します。</p>}
    </div>
  </Workspace>;
}
