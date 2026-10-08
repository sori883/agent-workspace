import { createHash } from "node:crypto";
import { useEffect, useRef, useState } from "react";
import { data, redirect, useNavigate, useRevalidator } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/workbench";
import { workbenchAnswerSchema, workbenchMutationSchema, workbenchStartSchema, workbenchSubmitSchema, type WorkbenchRoot } from "../../shared/workbench-contracts";
import { MAX_WORKBENCH_RESPONSE_BYTES } from "../../shared/workbench-transfer";
import { definitionListSchema, type DefinitionSummary, type DefinitionVersion } from "../../shared/definition-contracts";
import { fileListSchema, type FileInfo } from "../../shared/file-contracts";
import { readLimitedText } from "../../shared/http";
import { runHttpErrorSchema } from "../../shared/run-contracts";
import { SkillComposer, hasUnselectedSkillCommand, type SkillChoice } from "../components/skill-composer";
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
import { definitionErrorMessage } from "../lib/definition-copy";
import { builtinCatalog } from "../lib/builtin-catalog";

export function meta() { return [{ title: "エージェント | AX ワークスペース" }]; }
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
  const url = new URL(request.url), builtin = url.searchParams.get("builtin"), rootId = url.searchParams.get("root"), draft = url.searchParams.get("draft"), before = url.searchParams.get("before");
  for (const key of ["root", "draft", "before", "agent", "skill"]) if (url.searchParams.getAll(key).length > 1 || url.searchParams.has(key) && !z.uuid().safeParse(url.searchParams.get(key)).success) throw new Response("依頼またはスキルの一覧から開き直してください。", { status: 400, headers });
  if (url.searchParams.getAll("builtin").length > 1 || builtin !== null && !builtinCatalog.skills.some(skill => skill.id === builtin) || ["agent", "skill", "builtin"].filter(key => url.searchParams.has(key)).length > 1 || rootId && ["agent", "skill", "builtin"].some(key => url.searchParams.has(key))) throw new Response("スキルを一つ選んで開いてください。", { status: 400, headers });
  if (!rootId && !draft) { url.searchParams.set("draft", crypto.randomUUID()); throw redirect(url.pathname + url.search, { headers }); }
  const api = workbenchClient(user.accessToken, scope.workspaceId);
  let root: WorkbenchRoot | null = null, roots: WorkbenchRoot[] = [], next: string | null = null, error: string | null = null;
  let files: FileInfo[] = [], fileNext: string | null = null, definitions: DefinitionSummary[] = [], definitionNext: string | null = null;
  const jobs = await Promise.allSettled([api.list(before ?? undefined), rootId ? api.get(rootId) : Promise.resolve(null),
    rootId ? Promise.resolve(null) : filesClient(user.accessToken, scope.workspaceId).list(),
    rootId ? Promise.resolve(null) : definitionsClient(user.accessToken, scope.workspaceId).list({ kind: "skill", filter: "all", limit: 50 })]);
  const list = jobs[0], detail = jobs[1], fileList = jobs[2], definitionList = jobs[3];
  if (list.status === "fulfilled") { roots = list.value.roots; next = list.value.next_cursor; }
  if (detail.status === "fulfilled") root = detail.value;
  if (fileList.status === "fulfilled" && fileList.value) { files = fileList.value.files; fileNext = fileList.value.next_cursor; }
  if (definitionList.status === "fulfilled" && definitionList.value) { definitions = definitionList.value.definitions; definitionNext = definitionList.value.next_cursor; }
  const failed = jobs.find(result => result.status === "rejected");
  if (failed?.status === "rejected") error = workbenchError(failed.reason instanceof RunApiError ? failed.reason.code : "api_unavailable");
  let selection: DefinitionVersion | null = null;
  const selectionKind = url.searchParams.has("skill") ? "skill" : null;
  if (url.searchParams.has("agent")) error = "エージェントの選択は終了しました。標準エージェントに依頼し、必要なスキルを指定してください。";
  let selectionVisibility: "personal" | "workspace" | null = null;
  if (selectionKind) {
    try {
      const client = definitionsClient(user.accessToken, scope.workspaceId);
      const version = await client.getVersion(url.searchParams.get(selectionKind)!);
      if (version.kind !== selectionKind) throw new RunApiError("definition_version_not_found", 404);
      const detail = await client.get(version.definition_id);
      if (detail.definition.archived_at) throw new RunApiError("definition_archived", 409);
      selection = version; selectionVisibility = detail.definition.visibility;
    } catch (cause) { error = definitionErrorMessage(cause instanceof RunApiError ? cause.code : "api_unavailable"); }
  }
  return data({ scope, workspaceName: await workspaceTitle(user.accessToken, scope), csrf: session.csrf, rootId, root, roots, next, before, error, files, fileNext, definitions, definitionNext, selection, selectionVisibility, builtin, draftKey: root ? answerKey(root.id, root.revision) : draft! }, { headers });
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, errorHeaders }) => { const value = pageHeaders(); for (const source of [loaderHeaders, errorHeaders]) source?.forEach((v, k) => value.set(k, v)); return value; };

class TransferError extends Error { constructor(readonly code: string, readonly status: number) { super(workbenchError(code)); } }
export default function WorkbenchPage({ loaderData }: Route.ComponentProps) { return <Workbench key={`${loaderData.scope.workspaceId}:${loaderData.rootId ?? loaderData.draftKey}`} initial={loaderData} />; }
function Workbench({ initial }: { initial: Route.ComponentProps["loaderData"] }) {
  const { root, scope, csrf } = initial;
  const navigate = useNavigate(), revalidator = useRevalidator();
  const [text, setText] = useState(""), [mode, setMode] = useState<"preview" | "model">("preview"), [consent, setConsent] = useState(false);
  const [files, setFiles] = useState(initial.files), [fileNext, setFileNext] = useState(initial.fileNext), [definitions, setDefinitions] = useState(initial.definitions), [definitionNext, setDefinitionNext] = useState(initial.definitionNext);
  const [fileIds, setFileIds] = useState<string[]>([]), [skillIds, setSkillIds] = useState<string[]>(initial.selection?.kind === "skill" ? [initial.selection.id] : []), [builtinIds, setBuiltinIds] = useState<string[]>(initial.builtin ? [initial.builtin] : []);
  const [filesOpen, setFilesOpen] = useState(false);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<object | null>(null), [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null), gate = useRef(false);
  const revision = useRef(root?.revision);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    setFiles(prior => [...new Map([...prior, ...initial.files].map(file => [file.id, file])).values()]);
    setFileNext(initial.fileNext);
  }, [initial.files, initial.fileNext]);
  useEffect(() => {
    if (root && revision.current !== root.revision) { revision.current = root.revision; setText(""); setPending(null); setError(null); }
  }, [root]);
  useRunRefresh(!!initial.rootId && (!root || ["running", "stopping", "waiting_input"].includes(root.state)));
  const readonly = busy || pending !== null;
  const choices: SkillChoice[] = builtinCatalog.skills.map(skill => ({ id: skill.id, name: skill.name, kind: "builtin", detail: `組み込み · /${skill.id}` }));
  for (const item of definitions) if (item.kind === "skill" && item.latest_version && !item.archived_at) choices.push({ id: item.latest_version.id, kind: "skill", name: item.latest_version.name, detail: `${item.visibility === "personal" ? "自分だけ" : "ワークスペース共有"} · 第${item.latest_version.version}版`, href: scopeHref(`/library/${item.id}?version=${item.latest_version.id}`, scope) });
  if (initial.selection && !choices.some(item => item.id === initial.selection!.id)) choices.push({ id: initial.selection.id, kind: "skill", name: initial.selection.content.name, detail: `${initial.selectionVisibility === "personal" ? "自分だけ" : "ワークスペース共有"} · 第${initial.selection.version}版`, href: scopeHref(`/library/${initial.selection.definition_id}?version=${initial.selection.id}`, scope) });
  const selectedSkills = choices.filter(item => (item.kind === "builtin" ? builtinIds : skillIds).includes(item.id));
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
        if (hasUnselectedSkillCommand(text)) { setError("「/」で入力したスキルを候補から選ぶか、コマンドを削除してから送信してください。"); return; }
        const parsed = workbenchStartSchema.safeParse({ key: initial.draftKey, text, mode, ...(mode === "model" ? { allow_model: consent } : {}), input_file_ids: fileIds, skill_version_ids: skillIds, builtin_skill_ids: builtinIds });
        if (!parsed.success || selectedBytes > 8388608) { setError("依頼内容と、AI利用時の外部送信・料金への確認を見直してください。ファイルは任意で、4件・合計8 MiBまで選べます。"); return; }
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
        const value = await transfer("/library/transfer", { intent: "list", options: { kind: "skill", filter: "all", before: definitionNext, limit: 50 } }, definitionListSchema);
        setDefinitions(prior => [...new Map([...prior, ...value.definitions].map(item => [item.id, item])).values()]); setDefinitionNext(value.next_cursor);
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { gate.current = false; setBusy(false); }
  }
  function toggle(values: string[], id: string, checked: boolean) { return checked ? [...values, id] : values.filter(value => value !== id); }
  const pageIdentity = initial.rootId ? `root=${initial.rootId}` : `draft=${initial.draftKey}`;
  const sidebar = <div className="chat-history request-history"><details open><summary>依頼の履歴</summary>{initial.roots.length === 0 && <p className="history-empty">依頼を送ると、ここに履歴が残ります。</p>}<ul>{initial.roots.map(item => <li key={item.id}><a href={scopeHref(`/workbench?root=${item.id}`, scope)} aria-current={root?.id === item.id ? "page" : undefined}><span>{item.messages[0]?.text.slice(0, 45) ?? "エージェントへの依頼"}</span><small>{item.mode === "preview" ? "操作テスト · " : ""}{workbenchStateLabels[item.state]}</small></a></li>)}</ul></details>{initial.next && <a href={scopeHref(`/workbench?before=${initial.next}&${pageIdentity}`, scope)}>次の50件</a>}{initial.before && <a href={scopeHref(`/workbench?${pageIdentity}`, scope)}>最初のページ</a>}</div>;
  return <Workspace workspaceName={initial.workspaceName} title={root ? "依頼の内容" : "何を手伝いましょうか"} intro={root ? "やり取りと結果は、この依頼に保存されます。" : "相談や文章作成から、計算・ファイル作業まで。"} sidebar={sidebar} chat>
    <div className="chat-shell workbench-shell">
      {initial.error && <Notice title="依頼を表示できません" error><p>{initial.error}</p><button type="button" className="text-button" onClick={() => void revalidator.revalidate()}>もう一度読み込む</button><p><a href={scopeHref("/workbench", scope)}>標準エージェントで新しい依頼を開く</a></p></Notice>}
      {root && <><div className="chat-toolbar"><span>{root.mode === "preview" ? "操作テスト · AIは利用していません" : "エージェントへの依頼"}</span><button type="button" className="text-button" onClick={() => void revalidator.revalidate()}>表示を更新</button></div>
        <div className="chat-thread" aria-label="作業の会話">{root.messages.map((message, i) => <article key={`${message.run_id}:${message.kind}:${i}`} className={`chat-message ${message.kind.startsWith("user_") ? "user-message" : "assistant-message"}`} aria-label={message.kind.startsWith("user_") ? "あなたのメッセージ" : "エージェントの返答"}><div className="message-author">{message.kind.startsWith("user_") ? "あなた" : message.kind === "python_result" ? "計算・ファイル処理の結果" : "AX エージェント"}</div><p>{message.text}</p></article>)}</div>
        <div className="run-status-panel" role="status"><h2>{workbenchStateLabels[root.state]}</h2>{root.state === "running" && <p>{root.stage === "python" ? "計算・ファイル処理を進めています。" : "依頼内容を確認しています。"}</p>}{root.state === "waiting_input" && <p>{root.can_answer ? "回答すると依頼を続けます。" : "回答を続けられる期限や権限を確認できません。"}</p>}{root.state === "blocked_unknown" && <p>実行結果が不明なため、追加の処理を止めています。停止を確認して、回収できる結果を取得してください。</p>}{root.state === "stopping" && <p>実際の停止が確認できるまでお待ちください。</p>}</div>
        {root.failure_reason && ["failed", "stopped"].includes(root.state) && <p className="field-error">{workbenchError(root.failure_reason)}</p>}
        {root.output_files.length > 0 && <section className="org-section" aria-labelledby="workbench-outputs"><h2 id="workbench-outputs">結果ファイル</h2>{root.output_files.map(file => <FileDownload key={file.file_id} id={file.file_id} name={file.name} csrf={csrf} scope={scope} />)}</section>}
        <p className="agent-usage">{root.mode === "preview" ? "外部モデルの利用料金は発生しません。" : `この依頼のモデル料金の目安：${root.estimated_usd === null ? "確認中" : `${root.estimated_usd.toFixed(8)} USD`}`}</p>
        {["succeeded", "failed", "stopped"].includes(root.state) && <div className="request-next"><a className="button button-primary" href={scopeHref("/workbench", scope)}>新しい依頼を始める</a><p>次の依頼には、このやり取りは自動で引き継がれません。</p></div>}
      </>}
      {!!root?.skill_catalog_omitted && <p className="org-private-note">利用できるスキルが多いため、自動選択の候補を一部に絞っています。指定したいスキルは「/」から選んでください。</p>}
      {error && <div className="result result-error" tabIndex={-1} ref={errorRef}><h2>操作を確認してください</h2><p>{error}</p></div>}
      {!initial.error && (!root || root.can_answer) && <form className="chat-composer request-composer" onSubmit={event => { event.preventDefault(); void submit(root ? "answer" : "start"); }} onKeyDown={event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !busy) { event.preventDefault(); event.currentTarget.requestSubmit(); }
      }}>
        {!root && <div className="request-agent"><span>{builtinCatalog.defaultAgent.name}</span></div>}
        <label htmlFor="workbench-text">{root ? "質問への回答" : "依頼内容"}</label>
        <p id="workbench-text-hint" className="composer-hint">{root ? "エージェントからの質問に回答してください。" : "相談したいことや、作りたいものを教えてください。ファイルなしでも依頼できます。"}</p>
        {root ? <textarea id="workbench-text" rows={5} value={text} readOnly={readonly} onChange={event => setText(event.target.value)} aria-describedby="workbench-text-hint workbench-text-count" /> : <SkillComposer text={text} change={setText} choices={choices} selected={selectedSkills} readOnly={readonly} hasMore={!!definitionNext} loadMore={() => void more("definitions")}
          choose={choice => { if (selectedSkills.length < 8) (choice.kind === "builtin" ? setBuiltinIds : setSkillIds)(prior => [...prior, choice.id]); }}
          remove={choice => (choice.kind === "builtin" ? setBuiltinIds : setSkillIds)(prior => prior.filter(id => id !== choice.id))} />}

        <div className="composer-meta"><span>Ctrl / ⌘ + Enterで送信</span><span id="workbench-text-count">{new TextEncoder().encode(text).length} / 2,048 バイト</span></div>
        {!root && <>
          <div className="request-tools"><button type="button" className="text-button" disabled={readonly} aria-expanded={filesOpen} aria-controls="request-files" onClick={() => setFilesOpen(value => !value)}>ファイルを添付{fileIds.length > 0 ? `（${fileIds.length}件）` : "（任意）"}</button><a href={scopeHref("/library", scope)}>使えるスキルを見る</a></div>
          {fileIds.length > 0 && <p className="request-selection">添付：{files.filter(file => fileIds.includes(file.id)).map(file => file.name).join("、")}</p>}
          <div id="request-files" className="request-options" hidden={!filesOpen}>
            <fieldset className="definition-choice" disabled={readonly}><legend>使用するファイル（任意・4件、合計8 MiBまで）</legend>{files.filter(file => file.state === "ready").map(file => <label key={file.id}><input type="checkbox" checked={fileIds.includes(file.id)} disabled={!fileIds.includes(file.id) && (fileIds.length >= 4 || selectedBytes + file.size_bytes > 8388608)} onChange={event => setFileIds(toggle(fileIds, file.id, event.target.checked))} /><span>{file.name}（{Math.ceil(file.size_bytes / 1024)} KiB）</span></label>)}{!files.some(file => file.state === "ready") && <p>保存済みのファイルはありません。必要な場合は「作業ファイル」でCSV・Excelを追加してください。</p>}</fieldset>
            {fileNext && <button type="button" className="text-button" disabled={readonly} onClick={() => void more("files")}>ファイルをさらに表示</button>}
            <p><a href={scopeHref("/files", scope)} target="_blank" rel="noopener">ファイルを追加・管理する（別タブ）</a></p><button type="button" className="text-button" disabled={readonly} onClick={() => void revalidator.revalidate()}>追加したファイルを読み込む</button>
          </div>
          <fieldset className="agent-mode request-mode" disabled={readonly}><legend>利用方法</legend><label><input type="radio" name="workbench-mode" checked={mode === "model"} onChange={() => setMode("model")} />AIに依頼する</label><label><input type="radio" name="workbench-mode" checked={mode === "preview"} onChange={() => setMode("preview")} />画面の操作を試す（無料）</label></fieldset>
          {mode === "preview" && <p className="field-hint request-mode-note">操作テストでは決まった質問と回答を表示します。AIの回答や計算・ファイル処理は行いません。</p>}
          {mode === "model" && <div className="chat-consent"><label><input type="checkbox" checked={consent} disabled={readonly} onChange={event => setConsent(event.target.checked)} /><span>外部送信とモデル利用料金を確認しました</span></label><p>依頼・利用できるスキルの名前と説明・使用するスキルの指示や参照資料・ファイル名・処理の要約をGeminiへ送信します。処理で抽出したファイルの内容が要約に含まれる場合があります。</p></div>}
        </>}
        <div className="composer-actions"><p>返答は完成すると表示されます。</p><button className="button button-primary" type="submit" disabled={busy}>{pending ? "同じ内容で再確認する" : root ? "回答して続ける" : mode === "preview" ? "操作を試す" : "依頼を送る"}</button></div>
      </form>}
      {!root && !initial.error && <section className="request-examples" aria-label="依頼の例"><p>例えば、こんなことを頼めます</p><div>{["考えを整理する", "文章を作る・直す", "計算・データをまとめる"].map(example => <button className="example-prompt" type="button" key={example} disabled={readonly} onClick={() => { setText(example === "考えを整理する" ? "新しい企画のアイデアを一緒に整理してください。" : example === "文章を作る・直す" ? "社内向けのお知らせの文章を考えてください。" : "計算やデータ整理を手伝ってください。"); document.getElementById("workbench-text")?.focus(); }}>{example}</button>)}</div></section>}
      <p className="request-privacy">依頼・ファイル・結果は本人だけが見られます。共有スキルを使っても公開されません。</p>
      {root && ["running", "waiting_input", "blocked_unknown"].includes(root.state) && <div className="org-actions"><button type="button" className="button button-secondary" disabled={busy || pending !== null} onClick={() => void submit("stop")}>この作業を停止する</button>{root.state === "blocked_unknown" && <button type="button" className="button button-secondary" disabled={busy || pending !== null} onClick={() => void submit("recover")}>停止と結果の回収を確認する</button>}</div>}
      {pending && root && !root.can_answer && <button type="button" className="button button-secondary" disabled={busy} onClick={() => void submit("stop")}>同じ内容で再確認する</button>}
      <noscript><p>依頼の送信とファイルのダウンロードにはJavaScriptが必要です。</p></noscript>
    </div>
  </Workspace>;
}
