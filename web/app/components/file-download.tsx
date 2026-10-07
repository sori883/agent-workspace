import { useState } from "react";
import { fileInfoSchema } from "../../shared/file-contracts";
import { decodeFileChunk, fileChunkSchema } from "../../shared/file-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_RESPONSE_BYTES } from "../../shared/run-contracts";
import { scopeHref, type WorkspaceScope } from "../lib/workspace-scope";

export function FileDownload({ id, name, csrf, scope }: { id: string; name: string; csrf: string; scope: WorkspaceScope }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function request(body: object) {
    const response = await fetch(scopeHref("/files/transfer", scope), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000), body: JSON.stringify({ ...body, csrf }) });
    if (!response.ok) throw new Error("ファイルを取得できませんでした。画面を更新してから、もう一度お試しください。");
    return JSON.parse(await readLimitedText(response, MAX_RUN_RESPONSE_BYTES)) as unknown;
  }
  async function download() {
    if (busy) return;
    setBusy(true); setMessage("取得しています。");
    try {
      const file = fileInfoSchema.parse(await request({ intent: "get", id }));
      if (file.id !== id || file.state !== "ready") throw new Error("保存済みのファイルを確認できませんでした。");
      const bytes = new Uint8Array(file.size_bytes);
      for (let index = 0; index < file.chunk_count; index++) {
        const chunk = decodeFileChunk(fileChunkSchema.parse(await request({ intent: "read", id, index })).content_base64);
        if (chunk.length !== Math.min(32768, bytes.length - index * 32768)) throw new Error("ファイルの内容を確認できませんでした。");
        bytes.set(chunk, index * 32768);
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      if (hash !== file.sha256) throw new Error("ファイルの内容を確認できませんでした。");
      const url = URL.createObjectURL(new Blob([bytes], { type: file.media_type }));
      const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("ダウンロードしました。");
    } catch { setMessage("ファイルを取得できませんでした。画面を更新してから、もう一度お試しください。"); }
    finally { setBusy(false); }
  }
  return <div className="org-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => void download()} aria-label={`${name}をダウンロード`}>{name}をダウンロード</button><span role="status">{message}</span></div>;
}
