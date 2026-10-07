import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { agentContentSchema, definitionCreateSchema, definitionListSchema, definitionMutationResultSchema, skillContentSchema, type AgentContent, type DefinitionContent, type DefinitionDetail, type DefinitionList, type SkillContent } from "../../shared/definition-contracts";
import { MAX_DEFINITION_REQUEST_BYTES } from "../../shared/definition-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_RESPONSE_BYTES, runHttpErrorSchema } from "../../shared/run-contracts";
import { definitionErrorMessage, definitionKindLabel, definitionVisibilityLabel } from "../lib/definition-copy";
import { scopeHref, type WorkspaceScope } from "../lib/workspace-scope";
import { Workspace } from "./workspace";

type Initial = { scope: WorkspaceScope; csrf: string; workspaceName: string | null; detail: DefinitionDetail | null; kind: "skill" | "agent"; visibility: "personal" | "workspace"; content: DefinitionContent; draftKey: string; selectedSkills: Record<string, string>; copied: boolean };
type Mutation = { intent: "create" | "update" | "publish" | "archive"; id?: string; input: object };
const bytes = (text: string) => new TextEncoder().encode(text).length;
class DefinitionRequestError extends Error {
  constructor(message: string, readonly definite = false) { super(message); }
}

function Input({ id, label, value, change, limit, hint, required = false, multiline = false }: { id: string; label: string; value: string; change: (value: string) => void; limit: number; hint?: string; required?: boolean; multiline?: boolean }) {
  const count = bytes(value);
  const props = { id, value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(event.target.value), required, "aria-describedby": `${id}-hint ${id}-count`, "aria-invalid": count > limit || undefined };
  return <div className="run-field"><label htmlFor={id}>{label}{required && <span className="required-label">必須</span>}</label>
    <p className="field-hint" id={`${id}-hint`}>{hint} {limit.toLocaleString()}バイトまで。</p>
    {multiline ? <textarea {...props} rows={6} /> : <input {...props} type="text" />}
    <p className={count > limit ? "field-error" : "input-count"} id={`${id}-count`}>{count.toLocaleString()} / {limit.toLocaleString()} バイト{count > limit ? " ＊上限を超えています。内容を短くしてください。" : ""}</p>
  </div>;
}

export function DefinitionEditor({ initial }: { initial: Initial }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState(initial.detail);
  const [content, setContent] = useState(initial.content);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [saved, setSaved] = useState(JSON.stringify(initial.content));
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Mutation | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [skills, setSkills] = useState<DefinitionList | null>(null);
  const [skillNames, setSkillNames] = useState(initial.selectedSkills);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillError, setSkillError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  useEffect(() => setHydrated(true), []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const dirty = JSON.stringify(content) !== saved;
  const editable = !detail || detail.definition.can_edit && !detail.definition.archived_at;
  const kind = initial.kind;
  const isSkill = kind === "skill";
  const skill = isSkill ? content as SkillContent : null;
  const agent = !isSkill ? content as AgentContent : null;
  const label = definitionKindLabel[kind];
  const blocked = busy || pending !== null;

  async function transfer<T>(body: object, schema: z.ZodType<T>): Promise<T> {
    const text = JSON.stringify({ ...body, csrf: initial.csrf });
    if (bytes(text) > MAX_DEFINITION_REQUEST_BYTES) throw new DefinitionRequestError(definitionErrorMessage("request_too_large"), true);
    try {
      const response = await fetch(scopeHref("/library/transfer", initial.scope), { method: "POST", headers: { "Content-Type": "application/json" }, body: text, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000) });
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_RUN_RESPONSE_BYTES));
      if (!response.ok) {
        const failure = runHttpErrorSchema.safeParse(value);
        throw new DefinitionRequestError(definitionErrorMessage(failure.success ? failure.data.error : "api_unavailable"), failure.success && [400, 401, 403, 404, 409, 413, 415, 422].includes(response.status));
      }
      return schema.parse(value);
    } catch (cause) {
      if (cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof z.ZodError) && cause.name !== "TimeoutError" && cause.name !== "SyntaxError") throw cause;
      throw new Error(definitionErrorMessage("api_unavailable"));
    }
  }
  async function mutate(packet: Mutation) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setStatus(""); setPending(packet);
    try {
      const result = await transfer(packet, definitionMutationResultSchema);
      if (packet.intent !== "create" && result.definition.id !== detail?.definition.id) throw new Error(definitionErrorMessage("api_unavailable"));
      setPending(null);
      if (packet.intent === "create") {
        await navigate(scopeHref(`/library/${result.definition.id}`, initial.scope));
        return;
      }
      const newContent = packet.intent === "update" ? (packet.input as { content: DefinitionContent }).content : detail!.draft!.content;
      setContent(newContent);
      setDetail({ definition: result.definition, draft: result.definition.can_edit ? { revision: result.definition.revision!, content: newContent } : null, version: result.version ?? detail?.version ?? null });
      setSaved(JSON.stringify(newContent));
      setStatus(packet.intent === "publish" ? `第${result.version!.version}版を公開しました。` : packet.intent === "archive" ? "この設定の利用を終了しました。" : "下書きを保存しました。公開すると実行時に選べるようになります。");
      setConfirmArchive(false);
    } catch (cause) { if (cause instanceof DefinitionRequestError && cause.definite) setPending(null); setError(cause instanceof Error ? cause.message : definitionErrorMessage("api_unavailable")); }
    finally { lock.current = false; setBusy(false); }
  }
  function save() {
    if (pending || lock.current) return;
    const parsed = (isSkill ? skillContentSchema : agentContentSchema).safeParse(content);
    if (!parsed.success) {
      setError(isSkill ? "名前は半角英小文字・数字・ハイフンで64文字以内にし、指示を入力してください。各項目の容量と、補助ファイルのパスの形式・重複を確認してください。" : "名前と指示を入力し、各項目の容量を確認してください。スキルは重複なしで8個まで選べます。");
      return;
    }
    if (detail) void mutate({ intent: "update", id: detail.definition.id, input: { key: crypto.randomUUID(), expected_revision: detail.definition.revision, content: parsed.data } });
    else {
      const input = definitionCreateSchema.parse({ key: initial.draftKey, kind, visibility, content: parsed.data });
      void mutate({ intent: "create", input });
    }
  }
  async function loadSkills(before?: string) {
    if (skillBusy) return;
    setSkillBusy(true); setSkillError("");
    try {
      const page = await transfer({ intent: "list", options: { kind: "skill", filter: visibility === "workspace" ? "workspace" : "all", ...(before ? { before } : {}) } }, definitionListSchema);
      setSkills(page);
    } catch (cause) { setSkillError(cause instanceof Error ? cause.message : definitionErrorMessage("api_unavailable")); }
    finally { setSkillBusy(false); }
  }
  function selectSkill(id: string, name: string) {
    if (!agent || agent.skill_version_ids.includes(id) || agent.skill_version_ids.length >= 8) return;
    setContent({ ...agent, skill_version_ids: [...agent.skill_version_ids, id] });
    setSkillNames(names => ({ ...names, [id]: name }));
  }

  return <Workspace title={detail ? detail.definition.name : `${label}を登録`} intro={isSkill ? "作業の手順と、必要な補助資料をまとめる。" : "エージェントへの指示と、使うスキルを選ぶ。"} workspaceName={initial.workspaceName}>
    <p><a href={scopeHref("/library", initial.scope)}>スキル・エージェント一覧へ</a></p>
    {detail && <p>{definitionVisibilityLabel[detail.definition.visibility]} · {detail.definition.archived_at ? "利用終了" : detail.version ? `第${detail.version.version}版を公開中` : "下書き"}</p>}
    {initial.copied && <p className="org-private-note">表示している内容を新しい設定として登録します。公開範囲を確認してください。作業ファイルや実行結果はコピーされません。</p>}
    {error && <div className="result result-error" ref={errorRef} tabIndex={-1}><h2>操作を確認してください</h2><p>{error}</p>{pending && <p>送信結果を確認するには、下の「同じ内容で再確認する」を押してください。</p>}</div>}
    {status && <p role="status" className="org-private-note">{status}</p>}
    {pending && <button className="button button-primary" type="button" disabled={busy} onClick={() => void mutate(pending)}>同じ内容で再確認する</button>}
    {editable ? <form className="org-form library-editor" onSubmit={event => { event.preventDefault(); save(); }}>
      <fieldset disabled={blocked} className="library-fields"><legend>{detail ? "下書きを編集" : "設定内容"}</legend>
        {!detail && <fieldset className="org-options"><legend>公開範囲</legend>
          <label><input type="radio" name="visibility" checked={visibility === "personal"} onChange={() => { setVisibility("personal"); setSkills(null); }} />自分だけで使う</label>
          <label><input type="radio" name="visibility" checked={visibility === "workspace"} onChange={() => { setVisibility("workspace"); setSkills(null); }} />ワークスペースで共有する</label>
          <p>共有すると、公開した指示や補助資料を全メンバーが閲覧できます。作成者と管理者が編集できます。秘密情報を含めないでください。</p>
        </fieldset>}
        <Input id="definition-name" label={isSkill ? "スキル名" : "エージェント名"} value={content.name} change={name => setContent({ ...content, name })} limit={isSkill ? 64 : 256} required hint={isSkill ? "半角英小文字・数字・ハイフン。例：sales-summary" : "例：月次売上レポート"} />
        {skill && <Input id="definition-description" label="スキルの説明" value={skill.description} change={description => setContent({ ...skill, description })} limit={1024} hint="どのような依頼に使う手順かを説明してください。" />}
        <Input id="definition-instructions" label="指示" value={content.instructions} change={instructions => setContent({ ...content, instructions })} limit={16384} multiline required hint="目的、作業の順序、結果のまとめ方を記入してください。" />
        {skill && <section aria-labelledby="supplements-heading"><h2 id="supplements-heading">補助ファイル</h2><p className="field-hint">必要な場合だけ追加してください。UTF-8のテキストを16件まで、1件32 KiB、設定全体で128 KiBまで保存できます。CSV・Excelの作業データは「作業ファイル」から追加します。</p>
          {skill.files.map((file, index) => <fieldset className="library-supplement" key={index}><legend>補助ファイル {index + 1}</legend>
            <Input id={`supplement-path-${index}`} label="ファイル名" value={file.path} limit={255} required hint="references/、scripts/、assets/のいずれかで始まる半角英数字のパス。例：references/columns.md" change={path => setContent({ ...skill, files: skill.files.map((f, i) => i === index ? { ...f, path } : f) })} />
            <Input id={`supplement-content-${index}`} label="内容" value={file.content} limit={32768} multiline change={text => setContent({ ...skill, files: skill.files.map((f, i) => i === index ? { ...f, content: text } : f) })} />
            <button className="text-button" type="button" onClick={() => setContent({ ...skill, files: skill.files.filter((_, i) => i !== index) })}>補助ファイル {index + 1}を削除</button>
          </fieldset>)}
          <button className="button button-secondary" type="button" disabled={skill.files.length >= 16} onClick={() => setContent({ ...skill, files: [...skill.files, { path: "", content: "" }] })}>補助ファイルを追加</button><p className="field-hint">スクリプトを登録しても自動では実行されません。</p>
        </section>}
        {agent && <>
          <section aria-labelledby="skills-heading"><h2 id="skills-heading">使用するスキル</h2><p>公開済みの版を8個まで選べます。後から新しい版が公開されても、この選択は変わりません。</p>
            {agent.skill_version_ids.length > 0 ? <ul className="library-selected">{agent.skill_version_ids.map(id => <li key={id}>{skillNames[id] ?? "選択済みスキル"}<button className="text-button" type="button" onClick={() => setContent({ ...agent, skill_version_ids: agent.skill_version_ids.filter(value => value !== id) })}>選択を外す<span className="sr-only">：{skillNames[id] ?? "スキル"}</span></button></li>)}</ul> : <p>まだ選択していません。</p>}
            <button className="button button-secondary" type="button" disabled={skillBusy || !hydrated} onClick={() => void loadSkills()}>スキルを探す</button>
            {skillError && <p className="field-error">＊{skillError}</p>}
            {skills && <div className="library-picker"><ul>{skills.definitions.filter(item => item.latest_version !== null).map(item => <li key={item.id}><span>{item.latest_version!.name}（第{item.latest_version!.version}版） · {definitionVisibilityLabel[item.visibility]}</span><button className="button button-secondary" type="button" disabled={agent.skill_version_ids.length >= 8 || agent.skill_version_ids.includes(item.latest_version!.id)} onClick={() => selectSkill(item.latest_version!.id, `${item.latest_version!.name}（第${item.latest_version!.version}版）`)}>選ぶ<span className="sr-only">：{item.latest_version!.name}</span></button></li>)}</ul>{skills.definitions.every(item => item.latest_version === null) && <p>このページに公開済みのスキルはありません。</p>}{skills.next_cursor && <button className="text-button" type="button" disabled={skillBusy} onClick={() => void loadSkills(skills.next_cursor!)}>次の50件</button>}</div>}
          </section>
          <fieldset className="org-options"><legend>使える道具</legend><label><input type="checkbox" checked={agent.allowed_tools.includes("python")} onChange={event => setContent({ ...agent, allowed_tools: event.target.checked ? ["python"] : [] })} />Pythonでファイルを集計・作成する</label><p>実行時の権限と上限の範囲で利用します。指示を記入しても、この許可を広げることはできません。</p></fieldset>
        </>}
      </fieldset>
      <button className="button button-primary" type="submit" disabled={!hydrated || blocked}>{detail ? "下書きを保存" : "下書きを登録"}</button>
      <noscript><p>設定の登録・編集にはJavaScriptが必要です。</p></noscript>
    </form> : <section className="org-section"><h2>保存されている内容</h2><ContentView content={content} skillNames={skillNames} /></section>}
    {detail && editable && <section className="org-section" aria-labelledby="publish-heading"><h2 id="publish-heading">公開する</h2><p>保存した下書きを新しい版として公開します。{visibility === "workspace" ? "ワークスペースの全メンバーが選んで使えるようになります。" : "自分の作業で選んで使えるようになります。"}すでに始まった作業は、開始時に選んだ版を使い続けます。</p>{dirty && <p>先に下書きを保存してください。</p>}<button className="button button-primary" type="button" disabled={!hydrated || blocked || dirty} onClick={() => void mutate({ intent: "publish", id: detail.definition.id, input: { key: crypto.randomUUID(), expected_revision: detail.definition.revision } })}>保存した下書きを公開</button></section>}
    {detail?.version && editable && <details className="org-section"><summary>公開中の第{detail.version.version}版を確認</summary><ContentView content={detail.version.content} skillNames={skillNames} /></details>}
    {detail && <section className="org-section"><h2>コピーして登録</h2><p>名前や公開範囲を変えたい場合は、新しい設定としてコピーできます。</p><a className="button button-secondary" href={scopeHref(`/library/new?copy=${detail.definition.id}&draft=${initial.draftKey}`, initial.scope)}>コピーして新規登録</a></section>}
    {detail && editable && <section className="org-section"><h2>利用を終了する</h2><p>新しい作業では使えなくなります。過去の版と実行記録は残ります。</p><label className="org-check"><input type="checkbox" checked={confirmArchive} disabled={blocked} onChange={event => setConfirmArchive(event.target.checked)} />この設定の利用を終了する</label><button className="button button-secondary" type="button" disabled={!hydrated || blocked || !confirmArchive} onClick={() => void mutate({ intent: "archive", id: detail.definition.id, input: { key: crypto.randomUUID(), expected_revision: detail.definition.revision } })}>利用終了にする</button></section>}
  </Workspace>;
}

function ContentView({ content, skillNames }: { content: DefinitionContent; skillNames: Record<string, string> }) {
  return <div className="library-content"><h3>{content.name}</h3>{"description" in content && <p>{content.description}</p>}<h4>指示</h4><pre>{content.instructions}</pre>{"files" in content ? content.files.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>) : <><h4>使用するスキル</h4><ul>{content.skill_version_ids.map(id => <li key={id}>{skillNames[id] ?? "選択済みスキル"}</li>)}</ul><p>Pythonによる集計・作成：{content.allowed_tools.includes("python") ? "許可" : "許可しない"}</p></>}</div>;
}
