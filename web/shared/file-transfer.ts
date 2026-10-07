import { z } from "zod";
import { fileBeginSchema, WORK_FILE_CHUNK_BYTES } from "./file-contracts";

export const fileChunkIndexSchema = z.number().int().min(0).max(255);
export const fileChunkSchema = z.object({
  content_base64: z.string().min(4).max(4 * Math.ceil(WORK_FILE_CHUNK_BYTES / 3)).refine(value => {
    try { return btoa(atob(value)) === value && atob(value).length <= WORK_FILE_CHUNK_BYTES; }
    catch { return false; }
  }),
}).strict();

const identity = { csrf: z.string().min(1).max(128), id: z.uuid() };
export const fileTransferSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("list"), csrf: identity.csrf, before: z.uuid().optional() }).strict(),
  z.object({ intent: z.literal("begin"), csrf: identity.csrf, input: fileBeginSchema }).strict(),
  z.object({ intent: z.literal("cancel_unavailable"), csrf: identity.csrf }).strict(),
  z.object({ intent: z.literal("get"), ...identity }).strict(),
  z.object({ intent: z.literal("read"), ...identity, index: fileChunkIndexSchema }).strict(),
  z.object({ intent: z.literal("put"), ...identity, index: fileChunkIndexSchema, content_base64: fileChunkSchema.shape.content_base64 }).strict(),
  z.object({ intent: z.literal("seal"), ...identity }).strict(),
  z.object({ intent: z.literal("cancel"), ...identity }).strict(),
]);

export function encodeFileChunk(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > WORK_FILE_CHUNK_BYTES) throw new Error("Invalid chunk size");
  return btoa(String.fromCharCode(...bytes));
}

export function decodeFileChunk(value: string): Uint8Array {
  return Uint8Array.from(atob(fileChunkSchema.parse({ content_base64: value }).content_base64), character => character.charCodeAt(0));
}
