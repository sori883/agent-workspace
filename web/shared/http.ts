import { MAX_BODY_BYTES } from "./contracts";

export async function readLimitedText(body: Request | Response, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const length = body.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new Response("本文が大きすぎます。", { status: 413 });
  }
  if (!body.body) return "";
  const reader = body.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Response("本文が大きすぎます。", { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Response("本文の文字形式を確認してください。", { status: 400 });
  }
}
