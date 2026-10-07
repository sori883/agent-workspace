import { createHash } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { data, redirect, useNavigate, useRevalidator } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/workbench";
import { workbenchAnswerSchema, workbenchMutationSchema, workbenchStartSchema, workbenchSubmitSchema, type WorkbenchRoot } from "../../shared/workbench-contracts";
import { MAX_WORKBENCH_RESPONSE_BYTES } from "../../shared/workbench-transfer";
import { definitionListSchema, type DefinitionSummary } from "../../shared/definition-contracts";
import { fileListSchema, type FileInfo } from "../../shared/file-contracts";
import { readLimitedText } from "../../shared/http";
import { runHttpErrorSchema } from "../../shared/run-contracts";
import { FileDownload } from "../components/file-download";
import { Notice, useRunRefresh, Workspace } from "../components/workspace";
import { requireAuth } from "../lib/auth.server";
import { definitionsClient } from "../lib/definitions.server";
import { filesClient } from "../lib/files.server";
import { RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders } from "../lib/security.server";
import { workbenchClient } from "../lib/workbench.server";
import { workbenchError, workbenchStateLabels } from "../lib/workbench-copy";
import { scopeHref } from "../lib/workspace-scope";
import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";

export function meta() { return [{ title: "ファイルを使って依頼 | AX ワークスペース" }]; }
function answerKey(id: string, revision: number) {
  const bytes = createHash("sha256").update(`ax-workbench:${id}:${revision}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request), scope = requireWorkspaceScope(request);
  if (!scope.workspaceId) throw redirect("/workspaces");
  const session = await loadSession(request), headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const url = new URL(request.url), rootId = url.searchParams.get("root"), draft = url.searchParams.get("draft"), before = url.searchParams.get("before");
  for (const key of ["root", "draft", "before"]) if (url.searchParams.getAll(key).length > 1 || url.searchParams.has(key) && !z.uuid().safeParse(url.searchParams.get(key)).success) throw new Response("作業一覧から開き直してください。", { status: 400, headers });
  if (!rootId && !draft) { url.searchParams.set("draft", crypto.randomUUID()); throw redirect(url.pathname + url.search, { headers }); }
  const api = workbenchClient(user.accessToken, scope.workspaceId);
  let root: WorkbenchRoot | null = null, roots: WorkbenchRoot[] = [], next: string | null = null, error: string | null = null;
  let files: FileInfo[] = [], fileNext: string | null = null, definitions: DefinitionSummary[] = [], definitionNext: string | null = null;
  const jobs = await Promise.allSettled([api.list(before ?? undefined), rootId ? api.get(rootId) : Promise.resolve(null),
    rootId ? Promise.resolve(null) : filesClient(user.accessToken, scope.workspaceId).list(),
    rootId ? Promise.resolve(null) : definitionsClient(user.accessToken, scope.workspaceId).list({ filter: "all", limit: 50 })]);
  const list = jobs[0], detail = jobs[1], fileList = jobs[2], definitionList = jobs[3];
  if (list.status === "fulfilled") { roots = list.value.roots; next = list.value.next_cursor; }
  if (detail.status === "fulfilled") root = detail.value;
  if (fileList.status === "fulfilled" && fileList.value) { files = fileList.value.files; fileNext = fileList.value.next_cursor; }
  if (definitionList.status === "fulfilled" && definitionList.value) { definitions = definitionList.value.definitions; definitionNext = definitionList.value.next_cursor; }
  const failed = jobs.find(result => result.status === "rejected");
  if (failed?.status === "rejected") error = workbenchError(failed.reason instanceof RunApiError ? failed.reason.code : "api_unavailable");
  return data({ scope, workspaceName: await workspaceTitle(user.accessToken, scope), csrf: session.csrf, rootId, root, roots, next, before, error, files, fileNext, definitions, definitionNext, draftKey: root ? answerKey(root.id, root.revision) : draft! }, { headers });
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, errorHeaders }) => { const value = pageHeaders(); for (const source of [loaderHeaders, errorHeaders]) source?.forEach((v, k) => value.set(k, v)); return value; };

class TransferError extends Error { constructor(readonly code: string, readonly status: number) { super(workbenchError(code)); } }
export default function WorkbenchPage({ loaderData }: Route.ComponentProps) { return <Workbench key={loaderData.rootId ?? loaderData.draftKey} initial={loaderData} />; }
function Workbench({ initial }: { initial: Route.ComponentProps["loaderData"] }) {
  const { root, scope, csrf } = initial;
  const navigate = useNavigate(), revalidator = useRevalidator();
  const [text, setText] = useState(""), [mode, setMode] = useState<"preview" | "model">("preview"), [consent, setConsent] = useState(false);
  const [files, setFiles] = useState(initial.files), [fileNext, setFileNext] = useState(initial.fileNext), [definitions, setDefinitions] = useState(initial.definitions), [definitionNext, setDefinitionNext] = useState(initial.definitionNext);
  const [fileIds, setFileIds] = useState<string[]>([]), [skillIds, setSkillIds] = useState<string[]>([]), [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<object | null>(null), [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null), gate = useRef(false);
  const revision = useRef(root?.revision);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (root && revision.current !== root.revision) { revision.current = root.revision; setText(""); setPending(null); setError(null); }
  }, [root]);
  useRunRefresh(!!initial.rootId && (!root || ["running", "stopping", "waiting_input"].includes(root.state)));
  const readonly = busy || pending !== null;
  const published = definitions.filter(item => item.latest_version && !item.archived_at);
  const selectedBytes = files.filter(file => fileIds.includes(file.id)).reduce((sum, file) => sum + file.size_bytes, 0);
  async function transfer<T>(path: string, packet: object, schema: z.ZodType<T>): Promise<T> {
    try {
      const response = await fetch(scopeHref(path, scope), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000), body: JSON.stringify({ ...packet, csrf }) });
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_WORKBENCH_RESPONSE_BYTES));
      if (!response.ok) { const parsed = runHttpErrorSchema.safeParse(value); throw new TransferError(parsed.success ? parsed.data.error : "api_unavailable", response.status); }
      return schema.parse(value);
    } catch (cause) { if (cause instanceof TransferError) throw cause; throw new TransferError("api_unavailable", 503); }
  }
  async function submit(intent: "start" | "answer" | "stop" | "recover") {
    if (gate.current) return;
    let packet = pending;
    if (!packet) {
      if (intent === "start") {
        const parsed = workbenchStartSchema.safeParse({ key: initial.draftKey, text, mode, ...(mode === "model" ? { allow_model: consent } : {}), input_file_ids: fileIds, ...(agent ? { agent_version_id: agent } : { skill_version_ids: skillIds }) });
        if (!parsed.success || selectedBytes > 8388608) { setError("依頼を入力し、ファイルを4件・合計8 MiB以内で選んでください。実モデルでは外部送信と料金への確認も必要です。"); return; }
        packet = { intent, input: parsed.data };
      } else if (intent === "answer") {
        const parsed = workbenchAnswerSchema.safeParse({ key: initial.draftKey, question_id: root?.question_id, expected_revision: root?.revision, text });
        if (!parsed.success) { setError("回答を入力してください。日本語で約680文字までが目安です。"); return; }
        packet = { intent, id: root!.id, input: parsed.data };
      } else { if (!root) return; packet = { intent, id: root.id }; }
    }
    gate.current = true; setBusy(true); setError(null); setPending(packet);
    try {
      const operation = packet as { intent: string };
      if (operation.intent === "start" || operation.intent === "answer") {
        const value = await transfer("/workbench/transfer", packet, workbenchSubmitSchema);
        setPending(null); setText(""); await navigate(scopeHref(`/workbench?root=${value.root_id}`, scope));
      } else { await transfer("/workbench/transfer", packet, workbenchMutationSchema); setPending(null); void revalidator.revalidate(); }
    } catch (cause) {
      const uncertain = !(cause instanceof TransferError) || cause.status >= 500;
      if (!uncertain) setPending(null);
      setError(uncertain ? "受付結果を確認できませんでした。「同じ内容で再確認する」を押すと、作業を重複させずに確認できます。" : (cause as Error).message);
    } finally { gate.current = false; setBusy(false); }
  }
  async function more(kind: "files" | "definitions") {
    if (gate.current || readonly) return;
    gate.current = true; setBusy(true); setError(null);
    try {
      if (kind === "files" && fileNext) {
        const value = await transfer("/files/transfer", { intent: "list", before: fileNext }, fileListSchema);
        setFiles(prior => [...new Map([...prior, ...value.files].map(file => [file.id, file])).values()]); setFileNext(value.next_cursor);
      } else if (kind === "definitions" && definitionNext) {
        const value = await transfer("/library/transfer", { intent: "list", options: { filter: "all", before: definitionNext, limit: 50 } }, definitionListSchema);
        setDefinitions(prior => [...new Map([...prior, ...value.definitions].map(item => [item.id, item])).values()]); setDefinitionNext(value.next_cursor);
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { gate.current = false; setBusy(false); }
  }
  function toggle(values: string[], id: string, checked: boolean) { return checked ? [...values, id] : values.filter(value => value !== id); }
  const pageIdentity = initial.rootId ? `root=${initial.rootId}` : `draft=${initial.draftKey}`;
  const sidebar = <div className="chat-history"><a className="new-chat-link" href={scopeHref("/workbench", scope)}>＋ 新しい作業</a><details open><summary>本人の作業履歴</summary><ul>{initial.roots.map(item => <li key={item.id}><a href={scopeHref(`/workbench?root=${item.id}`, scope)} aria-current={root?.id === item.id ? "page" : undefined}><span>{item.messages[0]?.text.slice(0, 45) ?? "ファイルを使う作業"}</span><small>{item.mode === "preview" ? "模擬応答 · " : ""}{workbenchStateLabels[item.state]}</small></a></li>)}</ul></details>{initial.next && <a href={scopeHref(`/workbench?before=${initial.next}&${pageIdentity}`, scope)}>次の50件</a>}{initial.before && <a href={scopeHref(`/workbench?${pageIdentity}`, scope)}>最初のページ</a>}</div>;
  return <Workspace workspaceName={initial.workspaceName} title="ファイルを使って依頼" intro="CSVやExcelの集計を頼み、結果をファイルで受け取る。" sidebar={sidebar} chat>
    <div className="chat-shell"><p className="org-private-note">依頼・入力ファイル・実行結果は本人だけが見られます。共有スキルやエージェントを選んでも、作業内容は共有されません。</p>
      {initial.error && <Notice title="作業を表示できません" error><p>{initial.error}</p><button type="button" className="text-button" onClick={() => void revalidator.revalidate()}>もう一度読み込む</button></Notice>}
      {root && <><div className="chat-toolbar"><span>{root.mode === "preview" ? "模擬応答 · 無料" : "実モデルでの作業"}</span><button type="button" className="text-button" onClick={() => void revalidator.revalidate()}>作業を更新</button></div>
        <div className="chat-thread" aria-label="作業の会話">{root.messages.map((message, i) => <article key={`${message.run_id}:${message.kind}:${i}`} className={`chat-message ${message.kind.startsWith("user_") ? "user-message" : "assistant-message"}`} aria-label={message.kind.startsWith("user_") ? "あなたのメッセージ" : "エージェントの返答"}><div className="message-author">{message.kind.startsWith("user_") ? "あなた" : message.kind === "python_result" ? "ファイル処理の結果" : "AX エージェント"}</div><p>{message.text}</p></article>)}</div>
        <div className="run-status-panel" role="status"><h2>{workbenchStateLabels[root.state]}</h2>{root.state === "running" && <p>{root.stage === "python" ? "選んだファイルを処理しています。" : "依頼内容を確認しています。"}</p>}{root.state === "waiting_input" && <p>{root.can_answer ? "回答すると作業を続けます。" : "回答を続けられる期限や権限を確認できません。"}</p>}{root.state === "blocked_unknown" && <p>実行結果が不明なため、追加の処理を止めています。停止を確認して、回収できる結果を取得してください。</p>}{root.state === "stopping" && <p>実際の停止が確認できるまでお待ちください。</p>}</div>
        {root.output_files.length > 0 && <section className="org-section" aria-labelledby="workbench-outputs"><h2 id="workbench-outputs">保存済みの結果ファイル</h2>{root.output_files.map(file => <FileDownload key={file.file_id} id={file.file_id} name={file.name} csrf={csrf} scope={scope} />)}</section>}
        <p className="agent-usage">{root.mode === "preview" ? "外部モデルの利用料金は発生しません。" : `この作業のモデル料金の目安：${root.estimated_usd === null ? "確認中" : `${root.estimated_usd.toFixed(8)} USD`}`}</p>
      </>}
      {error && <div className="result result-error" tabIndex={-1} ref={errorRef}><h2>操作を確認してください</h2><p>{error}</p></div>}
      {!initial.error && (!root || root.can_answer) && <form className="chat-composer" onSubmit={event => { event.preventDefault(); void submit(root ? "answer" : "start"); }}>
        {!root && <>
          <fieldset className="agent-mode" disabled={readonly}><legend>応答の種類</legend><label><input type="radio" name="workbench-mode" checked={mode === "preview"} onChange={() => setMode("preview")} />模擬応答で操作を試す（無料）</label><label><input type="radio" name="workbench-mode" checked={mode === "model"} onChange={() => setMode("model")} />実モデルで作業を進める</label></fieldset>
          {mode === "preview" && <p className="field-hint">決まった質問と回答で操作を確認します。選んだファイルの集計は行いません。</p>}
          {mode === "model" && <div className="chat-consent"><label><input type="checkbox" checked={consent} disabled={readonly} onChange={event => setConsent(event.target.checked)} /><span>外部送信とモデル利用料金を確認しました</span></label><p>依頼・選択した設定・ファイル名・処理の要約をGeminiへ送信します。処理で抽出したファイルの内容が要約に含まれる場合があります。</p></div>}
          <div className="definition-field"><label htmlFor="workbench-agent">使用するエージェント</label><select id="workbench-agent" value={agent} disabled={readonly} onChange={event => { setAgent(event.target.value); setSkillIds([]); }}><option value="">標準のファイル集計</option>{published.filter(item => item.kind === "agent").map(item => <option key={item.id} value={item.latest_version!.id}>{item.latest_version!.name}（第{item.latest_version!.version}版）</option>)}</select><p className="field-hint">公開済みの版を使用します。作業中に設定が変わることはありません。</p></div>
          {!agent && <fieldset className="definition-choice" disabled={readonly}><legend>追加するスキル（8件まで）</legend>{published.filter(item => item.kind === "skill").map(item => <label key={item.id}><input type="checkbox" checked={skillIds.includes(item.latest_version!.id)} disabled={!skillIds.includes(item.latest_version!.id) && skillIds.length >= 8} onChange={event => setSkillIds(toggle(skillIds, item.latest_version!.id, event.target.checked))} /><span>{item.latest_version!.name}（第{item.latest_version!.version}版）</span></label>)}{!published.some(item => item.kind === "skill") && <p>このページに公開済みのスキルはありません。</p>}</fieldset>}
          {definitionNext && <button type="button" className="text-button" disabled={readonly} onClick={() => void more("definitions")}>設定をさらに表示</button>}
          <fieldset className="definition-choice" disabled={readonly}><legend>使用するファイル（4件・合計8 MiBまで）</legend>{files.filter(file => file.state === "ready").map(file => <label key={file.id}><input type="checkbox" checked={fileIds.includes(file.id)} disabled={!fileIds.includes(file.id) && (fileIds.length >= 4 || selectedBytes + file.size_bytes > 8388608)} onChange={event => setFileIds(toggle(fileIds, file.id, event.target.checked))} /><span>{file.name}（{Math.ceil(file.size_bytes / 1024)} KiB）</span></label>)}{!files.some(file => file.state === "ready") && <p>このページに保存済みのファイルはありません。</p>}</fieldset>
          {fileNext && <button type="button" className="text-button" disabled={readonly} onClick={() => void more("files")}>ファイルをさらに表示</button>}
          <p><a href={scopeHref("/files", scope)}>ファイルを追加する</a> · <a href={scopeHref("/library", scope)}>スキル・エージェントを登録する</a></p>
        </>}
        <label htmlFor="workbench-text">{root ? "質問への回答" : "依頼内容"}</label><p id="workbench-text-hint" className="composer-hint">集計したい項目や、作成したいファイルを教えてください。日本語で約680文字までが目安です。</p><textarea id="workbench-text" rows={5} value={text} readOnly={readonly} onChange={event => setText(event.target.value)} aria-describedby="workbench-text-hint" />
        <div className="composer-actions"><span>{new TextEncoder().encode(text).length} / 2,048 バイト</span><button className="button button-primary" type="submit" disabled={busy}>{pending ? "同じ内容で再確認する" : root ? "回答して続ける" : "作業を始める"}</button></div>
      </form>}
      {root && ["running", "waiting_input", "blocked_unknown"].includes(root.state) && <div className="org-actions"><button type="button" className="button button-secondary" disabled={busy || pending !== null} onClick={() => void submit("stop")}>この作業を停止する</button>{root.state === "blocked_unknown" && <button type="button" className="button button-secondary" disabled={busy || pending !== null} onClick={() => void submit("recover")}>停止と結果の回収を確認する</button>}</div>}
      {pending && root && !root.can_answer && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void submit("stop")}>同じ内容で再確認する</button>}
      <noscript><p>作業の送信とファイルのダウンロードにはJavaScriptが必要です。</p></noscript>
    </div>
  </Workspace>;
}
