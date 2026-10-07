import { createHash, randomUUID } from "node:crypto";
import { useEffect, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/agent";
import { agentAnswerSchema, agentStartSchema, type AgentRoot } from "../../shared/agent-contracts";
import type { ConversationDetail } from "../../shared/chat-contracts";
import { agentsClient } from "../lib/agents.server";
import { chatsClient, RunApiError } from "../lib/chats.server";
import { requireAuth } from "../lib/auth.server";
import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";
import { scopeHref } from "../lib/workspace-scope";
import { loadSession, pageHeaders, verifySubmission } from "../lib/security.server";
import { readLocalForm } from "../lib/forms.server";
import { runErrorMessage } from "../lib/run-copy";
import { Notice, useRunRefresh, Workspace } from "../components/workspace";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function draftKey(id: string, revision: number) {
  const bytes = createHash("sha256").update(`ax-agent:${id}:${revision}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const stateLabels: Record<AgentRoot["state"], string> = { running: "返答を準備しています", stopping: "停止を確認しています", waiting_input: "あなたの回答を待っています", succeeded: "完了しました", failed: "完了できませんでした", blocked_unknown: "実行の状態を確認する必要があります", stopped: "停止しました" };
function agentError(code: string) {
  const messages: Record<string, string> = {
    agent_not_found: "この対話は見つかりませんでした。",
    agent_conflict: "対話の状態が変わっています。読み直してから操作してください。",
    agent_expired: "続行できる期限を過ぎました。新しい対話を始めてください。",
    agent_grant_expired: "続行できる期限を過ぎました。対話を読み直すか、新しい対話を始めてください。",
    agent_grant_revoked: "このログインでの実行許可は失効しています。ログインし直してください。",
    agent_answer_conflict: "回答は受け付け済みか、対話の状態が変わっています。対話を読み直してください。",
    agent_stopped: "この対話は停止されています。新しい対話を始めてください。",
    agent_budget_exhausted: "この対話で扱える回数や時間の上限に達しました。",
    bridge_unavailable: "受付結果を確認できませんでした。同じ内容のまま再送するか、対話を更新してください。",
    idempotency_conflict: "同じ送信として異なる内容が届いています。対話を読み直してください。",
    api_unavailable: "受付結果を確認できませんでした。同じ内容のまま再送するか、対話を更新してください。",
  };
  return messages[code] ?? runErrorMessage(code);
}
export function meta() { return [{ title: "対話プレビュー | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  if (scope.legacy) return redirect("/workspaces");
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const url = new URL(request.url);
  const rootId = url.searchParams.get("root");
  const draft = url.searchParams.get("draft");
  if ((!rootId || !uuid.test(rootId)) && (!draft || !uuid.test(draft))) return redirect(scopeHref(`/agent?draft=${randomUUID()}`, scope), { headers });
  const api = agentsClient(user.accessToken, undefined, undefined, scope.workspaceId);
  let root: AgentRoot | null = null;
  let detail: ConversationDetail | null = null;
  let roots: AgentRoot[] = [];
  let titles: Record<string, string> = {};
  let error: string | null = null;
  try {
    const [list, conversations] = await Promise.all([api.list(), chatsClient(user.accessToken, undefined, undefined, scope.workspaceId).list()]);
    roots = list.roots;
    titles = Object.fromEntries(conversations.conversations.map(item => [item.id, item.title]));
    if (rootId && uuid.test(rootId)) {
      root = await api.get(rootId.toLowerCase());
      detail = await chatsClient(user.accessToken, undefined, undefined, scope.workspaceId).get(root.conversation_id);
    } else {
      const accepted = roots.find(item => item.conversation_id === draft);
      if (accepted) return redirect(scopeHref(`/agent?root=${accepted.id}`, scope), { headers });
    }
  } catch (cause) { error = cause instanceof RunApiError ? agentError(cause.code) : "対話を表示できませんでした。時間をおいて更新してください。"; }
  const id = root?.conversation_id ?? draft ?? "";
  return data({ scope, workspaceName: await workspaceTitle(user.accessToken, scope), csrf: session.csrf, id, key: draftKey(root?.id ?? id, root?.revision ?? 0), root, roots, titles, detail, error }, { headers });
}
export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  let submitted = { key: "", text: "", revision: 0, intent: "", rootId: "" };
  const failure = (error: string, status: number) => data({ error, submitted, uncertain: status === 503 }, { status, headers: pageHeaders() });
  try {
    const form = await readLocalForm(request, ["csrf", "intent", "key", "text", "conversation_id", "root_id", "question_id", "expected_revision"]);
    submitted = { key: form.get("key") ?? "", text: (form.get("text") ?? "").replace(/\r\n?/g, "\n"), revision: Number(form.get("expected_revision") ?? 0), intent: form.get("intent") ?? "", rootId: form.get("root_id") ?? "" };
    await verifySubmission(request, form.get("csrf"));
    if (scope.legacy) return failure("ワークスペースを選んでください。", 403);
    const api = agentsClient(user.accessToken, undefined, undefined, scope.workspaceId);
    const rootId = form.get("root_id") ?? "";
    let destination = rootId;
    if (form.get("intent") === "stop") await api.stop(rootId);
    else if (form.get("intent") === "answer") {
      const parsed = agentAnswerSchema.safeParse({ key: submitted.key, text: submitted.text, question_id: form.get("question_id"), expected_revision: submitted.revision });
      if (!parsed.success) return failure("回答の長さを確認し、対話を読み直してから送信してください。", 400);
      destination = (await api.answer(rootId, parsed.data)).root_id;
    } else if (form.get("intent") === "start") {
      const parsed = agentStartSchema.safeParse({ key: submitted.key, text: submitted.text, conversation_id: form.get("conversation_id") });
      if (!parsed.success) return failure("依頼を入力してください。日本語で約680文字までが目安です。", 400);
      destination = (await api.start(parsed.data)).root_id;
    } else return failure("操作を確認してください。", 400);
    return redirect(scopeHref(`/agent?root=${destination}`, scope), { status: 303, headers: pageHeaders() });
  } catch (cause) {
    return failure(cause instanceof Response ? await cause.text() : cause instanceof RunApiError ? agentError(cause.code) : agentError("api_unavailable"), cause instanceof Response || cause instanceof RunApiError ? cause.status : 503);
  }
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, actionHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};
function Composer({ csrf, root, id, draft, initial, uncertain, busy }: { csrf: string; root: AgentRoot | null; id: string; draft: string; initial: string; uncertain: boolean; busy: boolean }) {
  const [text, setText] = useState(() => {
    if (typeof document === "undefined") return initial;
    const field = document.getElementById("agent-text");
    return field instanceof HTMLTextAreaElement && field.dataset.draft === draft ? field.value : initial;
  });
  const bytes = new TextEncoder().encode(text).length;
  return <Form method="post" className="chat-composer">
    <input type="hidden" name="csrf" value={csrf} /><input type="hidden" name="intent" value={root ? "answer" : "start"} /><input type="hidden" name="key" value={draft} /><input type="hidden" name="conversation_id" value={id} /><input type="hidden" name="root_id" value={root?.id ?? ""} /><input type="hidden" name="question_id" value={root?.question_id ?? ""} /><input type="hidden" name="expected_revision" value={root?.revision ?? 0} />
    <label htmlFor="agent-text">{root ? "質問への回答" : "依頼内容"}</label><p id="agent-text-hint" className="composer-hint">日本語で約680文字までが目安です。</p>
    <textarea id="agent-text" name="text" data-draft={draft} value={text} onChange={event => setText(event.target.value)} required maxLength={2048} readOnly={uncertain} disabled={busy} aria-describedby="agent-text-hint agent-text-count" aria-invalid={bytes > 2048 || undefined} />
    <div className="composer-meta"><span>会話と成果物は本人だけが閲覧できます。</span><span id="agent-text-count">{bytes} / 2,048 バイト</span></div>
    <div className="composer-actions"><p>外部モデルの利用料金は発生しません。</p><button className="button button-primary" disabled={busy || bytes > 2048} type="submit">{uncertain ? "同じ内容を再送" : root ? "回答して続ける" : "対話を始める"}</button></div>
  </Form>;
}
export default function Agent({ loaderData, actionData }: Route.ComponentProps) {
  const { scope, root, detail } = loaderData;
  const navigation = useNavigation();
  const [retained, setRetained] = useState(actionData);
  useEffect(() => { if (actionData) setRetained(actionData); }, [actionData]);
  useEffect(() => { if (navigation.state === "submitting") setRetained(undefined); }, [navigation.state]);
  const response = actionData ?? retained;
  const active = root?.state === "running" || root?.state === "stopping";
  useRunRefresh(active || root?.state === "waiting_input" || !!response?.uncertain);
  const relevant = response && (!root || response.submitted.intent === "stop" && response.submitted.rootId === root.id || response.submitted.revision === root.revision) ? response : undefined;
  const composerResponse = relevant?.submitted.intent === "stop" ? undefined : relevant;
  const href = scopeHref(root ? `/agent?root=${root.id}` : `/agent?draft=${loaderData.id}`, scope);
  const last = detail?.turns.at(-1)?.summary;
  const sidebar = <div className="chat-history"><a className="new-chat-link" href={scopeHref("/agent", scope)}>＋ 新しい対話</a><details open><summary>最近の対話</summary><ul>{loaderData.roots.map(item => <li key={item.id}><a href={scopeHref(`/agent?root=${item.id}`, scope)} aria-current={root?.id === item.id ? "page" : undefined}><span>{loaderData.titles[item.conversation_id] ?? "対話プレビュー"}</span><small>{stateLabels[item.state]}</small></a></li>)}</ul></details></div>;
  return <Workspace workspaceName={loaderData.workspaceName} title="対話プレビュー" intro="質問に答えて、依頼をひとつずつ進める。" sidebar={sidebar} chat>
    <div className="chat-shell"><Notice title="模擬モデルで対話の流れを試せます"><p>現在は、決まった質問と返答で動きを確認するプレビューです。依頼を受け付け、質問への回答後にテキストの成果物を作ります。</p></Notice>
      <div className="chat-toolbar"><span>本人限定の対話</span><a href={href}>対話を更新</a></div>
      {loaderData.error && <Notice title="対話を表示できません" error><p>{loaderData.error}</p><a href="/workspaces">ワークスペースを選び直す</a></Notice>}
      <div className="chat-thread" aria-label="会話">{detail?.turns.map(turn => <div className="chat-turn" key={turn.summary.run_id}><article className="chat-message user-message" aria-label="あなたのメッセージ"><div className="message-author">あなた</div><p>{turn.user}</p></article>{turn.assistant !== null && <article className="chat-message assistant-message" aria-label="プレビューの返答"><div className="message-author">AX 対話プレビュー</div><p>{turn.assistant}</p><a className="message-detail" href={scopeHref(`/runs/${turn.summary.run_id}`, scope)}>実行の詳細</a></article>}</div>)}</div>
      {root && <div className="run-status-panel" role="status" aria-live="polite"><h2>{stateLabels[root.state]}</h2>{root.state === "waiting_input" && <p>{root.can_answer ? "処理は停止しています。回答すると、新しい実行で続けます。" : "回答できる期限が切れたか、続行する権限を確認できません。新しい対話を始めてください。"}</p>}{root.state === "stopping" && <p>停止を受け付けました。実際の停止が確認できるまでお待ちください。</p>}{root.state === "blocked_unknown" && <p>結果が不明なため、続行を保留しています。実行の詳細から確認してください。</p>}{last && ["blocked_unknown", "failed"].includes(root.state) && <a href={scopeHref(`/runs/${last.run_id}`, scope)}>実行の詳細を確認する</a>}{root.state === "succeeded" && last && <a className="button button-secondary" href={scopeHref(`/runs/${last.run_id}/artifact`, scope)}>成果物をダウンロード</a>}</div>}
      {relevant && <Notice title="送信を確認してください" error><p>{relevant.error}</p>{relevant.uncertain && <p>{relevant.submitted.intent === "stop" ? "停止の受付結果が不明です。対話を更新するか、停止操作をもう一度行ってください。" : "受付結果が不明です。内容を変えずに再送すると、受け付け済みの実行は増えません。"}</p>}</Notice>}
      {!loaderData.error && (!root || root.can_answer) && <Composer key={composerResponse?.submitted.key || loaderData.key} csrf={loaderData.csrf} root={root} id={loaderData.id} draft={composerResponse?.submitted.key || loaderData.key} initial={composerResponse?.submitted.text ?? ""} uncertain={!!composerResponse?.uncertain} busy={navigation.state !== "idle" || !!(relevant?.uncertain && relevant.submitted.intent === "stop")} />}
      {root && ["running", "waiting_input"].includes(root.state) && <Form method="post" className="chat-recovery"><input type="hidden" name="csrf" value={loaderData.csrf} /><input type="hidden" name="intent" value="stop" /><input type="hidden" name="root_id" value={root.id} /><button className="button button-secondary" type="submit" disabled={navigation.state !== "idle"}>この対話を停止する</button></Form>}
      {root && !active && !root.can_answer && <p><a href={scopeHref("/agent", scope)}>新しい対話を始める</a></p>}
    </div>
  </Workspace>;
}
