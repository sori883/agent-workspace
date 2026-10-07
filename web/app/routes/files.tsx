import { useEffect, useRef, useState } from "react";
import { data, redirect, useRevalidator } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/files";
import { fileCancelUnavailableSchema, fileInfoSchema, fileMutationSchema, fileWriteResultSchema, MAX_WORK_FILE_BYTES, WORK_FILE_CHUNK_BYTES, type FileInfo } from "../../shared/file-contracts";
import { decodeFileChunk, encodeFileChunk, fileChunkSchema } from "../../shared/file-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_RESPONSE_BYTES, runHttpErrorSchema } from "../../shared/run-contracts";
import { Notice, Workspace } from "../components/workspace";
import { requireAuth } from "../lib/auth.server";
import { fileErrorMessage } from "../lib/file-copy";
import { filesClient } from "../lib/files.server";
import { RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders } from "../lib/security.server";
import { scopeHref } from "../lib/workspace-scope";
import { requireWorkspaceScope, workspaceTitle } from "../lib/workspace-scope.server";

export function meta() { return [{ title: "作業ファイル | AX ワークスペース" }]; }
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  if (!scope.workspaceId) return redirect("/workspaces");
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const query = new URL(request.url).searchParams;
  const before = query.get("before");
  if (query.getAll("before").length > 1 || before !== null && !z.uuid().safeParse(before).success) throw new Response("一覧を最初から開き直してください。", { status: 400, headers });
  let files: FileInfo[] = [], next: string | null = null, error: string | null = null;
  try {
    const result = await filesClient(user.accessToken, scope.workspaceId).list(before ?? undefined);
    files = result.files; next = result.next_cursor;
  } catch (cause) { error = fileErrorMessage(cause instanceof RunApiError ? cause.code : "api_unavailable"); }
  return data({ files, next, before, error, scope, csrf: session.csrf, workspaceName: await workspaceTitle(user.accessToken, scope) }, { headers });
}
export const headers: Route.HeadersFunction = ({ loaderHeaders, errorHeaders }) => {
  const result = pageHeaders();
  for (const source of [loaderHeaders, errorHeaders]) source?.forEach((value, key) => result.set(key, value));
  return result;
};

function sizeLabel(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`; }
async function digest(bytes: Uint8Array<ArrayBuffer>) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join(""); }

export default function Files({ loaderData }: Route.ComponentProps) {
  const { scope, csrf } = loaderData;
  const input = useRef<HTMLInputElement>(null);
  const key = useRef<string | null>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [resume, setResume] = useState<FileInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  useEffect(() => { setHydrated(true); setSelected(input.current?.files?.[0] ?? null); }, []);
  async function transfer<T>(body: object, schema: z.ZodType<T>): Promise<T> {
    try {
      const response = await fetch(scopeHref("/files/transfer", scope), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, csrf }), credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000) });
      const value: unknown = JSON.parse(await readLimitedText(response, MAX_RUN_RESPONSE_BYTES));
      if (!response.ok) {
        const failure = runHttpErrorSchema.safeParse(value);
        throw new Error(fileErrorMessage(failure.success ? failure.data.error : "api_unavailable"));
      }
      return schema.parse(value);
    } catch (cause) {
      if (cause instanceof Error && !(cause instanceof TypeError) && !(cause instanceof z.ZodError) && cause.name !== "TimeoutError" && cause.name !== "SyntaxError") throw cause;
      throw new Error(fileErrorMessage("api_unavailable"));
    }
  }
  async function operation(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : fileErrorMessage("api_unavailable")); setProgress(""); }
    finally { setBusy(false); void revalidator.revalidate(); }
  }
  function resetSelection() { key.current = null; setSelected(null); setResume(null); if (input.current) input.current.value = ""; }
  async function upload() {
    const file = input.current?.files?.[0];
    if (!file || file.size < 1 || file.size > MAX_WORK_FILE_BYTES || !/\.(csv|xlsx)$/i.test(file.name)) { setError(fileErrorMessage("invalid_request")); return; }
    await operation(async () => {
      setProgress("ファイルを確認しています。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await digest(bytes);
      key.current ??= crypto.randomUUID();
      let saved = resume ? await transfer({ intent: "get", id: resume.id }, fileInfoSchema) : (await transfer({ intent: "begin", input: { key: key.current, name: file.name, size_bytes: file.size, sha256: hash } }, fileWriteResultSchema)).file;
      if (saved.name !== file.name || saved.size_bytes !== file.size || saved.sha256 !== hash) throw new Error("続きを送信するには、最初と同じ名前・内容のファイルを選んでください。");
      setResume(saved);
      if (saved.state !== "ready") {
        if (saved.state !== "uploading") throw new Error(fileErrorMessage("file_cancelled"));
        for (let index = 0; index < saved.chunk_count; index++) {
          await transfer({ intent: "put", id: saved.id, index, content_base64: encodeFileChunk(bytes.subarray(index * WORK_FILE_CHUNK_BYTES, (index + 1) * WORK_FILE_CHUNK_BYTES)) }, fileMutationSchema);
          setProgress(`送信中 ${Math.floor((index + 1) / saved.chunk_count * 100)}%`);
        }
        saved = (await transfer({ intent: "seal", id: saved.id }, fileWriteResultSchema)).file;
      }
      if (saved.state !== "ready" || saved.sha256 !== hash) throw new Error(fileErrorMessage("file_hash_mismatch"));
      setProgress(`${file.name}を保存しました。`); resetSelection();
    });
  }
  async function download(id: string) {
    await operation(async () => {
      const file = await transfer({ intent: "get", id }, fileInfoSchema);
      if (file.state !== "ready") throw new Error(fileErrorMessage("file_not_ready"));
      const bytes = new Uint8Array(file.size_bytes);
      for (let index = 0; index < file.chunk_count; index++) {
        const chunk = decodeFileChunk((await transfer({ intent: "read", id, index }, fileChunkSchema)).content_base64);
        if (chunk.length !== Math.min(WORK_FILE_CHUNK_BYTES, bytes.length - index * WORK_FILE_CHUNK_BYTES)) throw new Error(fileErrorMessage("file_hash_mismatch"));
        bytes.set(chunk, index * WORK_FILE_CHUNK_BYTES);
        setProgress(`取得中 ${Math.floor((index + 1) / file.chunk_count * 100)}%`);
      }
      if (await digest(bytes) !== file.sha256) throw new Error(fileErrorMessage("file_hash_mismatch"));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.media_type }));
      const link = document.createElement("a"); link.href = url; link.download = file.name;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProgress(`${file.name}をダウンロードしました。`);
    });
  }
  async function cancel(file: FileInfo) {
    await operation(async () => {
      await transfer({ intent: "cancel", id: file.id }, fileMutationSchema);
      if (resume?.id === file.id) resetSelection();
      setProgress(`${file.name}の送信を取り消しました。`);
    });
  }
  return <Workspace title="作業ファイル" intro="CSVやExcelを保存して、作業に備える。" workspaceName={loaderData.workspaceName}>
    <p className="org-private-note">このワークスペースのファイルは本人だけが利用できます。スキルやエージェントを共有しても、ここにあるファイルは共有されません。</p>
    {loaderData.error && <Notice title="一覧を表示できません" error><p>{loaderData.error}</p></Notice>}
    {error && <Notice title="ファイルの操作を確認してください" error><p>{error}</p></Notice>}
    <section className="org-section" aria-labelledby="upload-title">
      <h2 id="upload-title">{resume ? "送信を再開" : "ファイルを追加"}</h2>
      {resume && <p>「{resume.name}」と同じファイルを選んでください。</p>}
      <label htmlFor="work-file" className="file-label">CSV・Excelファイル</label>
      <p id="file-hint" className="field-hint">CSV（UTF-8）またはExcel（.xlsx）。1ファイル8 MiBまで。空のファイルは送信できません。</p>
      <input ref={input} type="file" id="work-file" accept=".csv,.xlsx" aria-describedby="file-hint file-selection" disabled={busy} onChange={event => { setSelected(event.target.files?.[0] ?? null); key.current = null; setError(null); setProgress(""); }} />
      <p id="file-selection">{selected ? `${selected.name}（${sizeLabel(selected.size)}）` : "ファイルは選択されていません。"}</p>
      <div className="org-actions"><button className="button button-primary" type="button" disabled={!hydrated || busy || !selected} onClick={() => void upload()}>{resume ? "続きを送信" : "保存する"}</button>{(resume || selected) && <button className="button button-secondary" type="button" disabled={busy} onClick={resetSelection}>選択を解除</button>}</div>
      <noscript><p>ファイルの送受信にはJavaScriptが必要です。</p></noscript>
      <p role="status" aria-live="polite" className="file-progress">{progress}</p>
      <p className="field-hint">保存できる容量は全ワークスペース合計で本人あたり256 MiBです。送信途中は4件まで。途中でページを閉じても、一覧から再開できます。</p>
      <details><summary>退出したワークスペースに送信途中のファイルがある場合</summary><p>所属を失ったワークスペースの未完了送信をまとめて取り消し、空き容量を戻せます。保存済みのファイルと、現在所属しているワークスペースの送信には影響しません。</p><button className="button button-secondary" type="button" disabled={!hydrated || busy} onClick={() => void operation(async () => { const result = await transfer({ intent: "cancel_unavailable" }, fileCancelUnavailableSchema); setProgress(`${result.cancelled_count}件の未完了送信を取り消しました。`); })}>利用できなくなった未完了送信を取り消す</button></details>
    </section>
    <section className="org-section" aria-labelledby="file-list-title"><div className="history-heading"><h2 id="file-list-title">本人のファイル</h2><button className="text-button" type="button" disabled={!hydrated || busy || revalidator.state !== "idle"} onClick={() => void revalidator.revalidate()}>一覧を更新</button></div>
      {loaderData.files.length === 0 && !loaderData.error ? <p>ファイルはまだありません。</p> : <ul className="org-cards">{loaderData.files.map(file => <li key={file.id}>
        <h3>{file.name}</h3><p>{sizeLabel(file.size_bytes)} · {file.state === "ready" ? "保存済み" : file.state === "uploading" ? `送信途中（${file.received_chunks} / ${file.chunk_count}）` : "送信取消済み"}</p>
        <div className="org-actions">{file.state === "ready" && <button className="button button-secondary" type="button" disabled={!hydrated || busy} aria-label={`${file.name}をダウンロード`} onClick={() => void download(file.id)}>ダウンロード</button>}
          {file.state === "uploading" && <><button className="button button-secondary" type="button" disabled={!hydrated || busy} aria-label={`${file.name}の送信を再開`} onClick={() => { resetSelection(); setResume(file); setError(null); input.current?.focus(); }}>送信を再開</button><button className="text-button" type="button" disabled={!hydrated || busy} aria-label={`${file.name}の送信を取り消す`} onClick={() => void cancel(file)}>送信を取り消す</button></>}
        </div>
      </li>)}</ul>}
      <div className="org-actions">{loaderData.before && <a href={scopeHref("/files", scope)}>最初のページ</a>}{loaderData.next && <a href={scopeHref(`/files?before=${loaderData.next}`, scope)}>次の50件</a>}</div>
    </section>
  </Workspace>;
}
