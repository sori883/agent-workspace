import { z } from "zod";

export const MAX_WORK_FILE_BYTES = 8 * 1024 * 1024;
export const WORK_FILE_CHUNK_BYTES = 32 * 1024;
const mediaTypes = ["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const;
const fileName = z.string().refine(value => {
  const characters = Array.from(value);
  return value.trim() === value && value.length > 4 && new TextEncoder().encode(value).length <= 255
    && !characters.some(c => { const n = c.codePointAt(0)!; return n < 32 || n === 127 || (n >= 0xd800 && n <= 0xdfff); })
    && !/[\\/]/.test(value) && /\.(csv|xlsx)$/i.test(value);
}, "A CSV or XLSX file name of at most 255 UTF-8 bytes is required");
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const fileBeginSchema = z.object({ key: z.uuid(), name: fileName, size_bytes: z.number().int().min(1).max(MAX_WORK_FILE_BYTES), sha256: hash }).strict();
export const fileInfoSchema = z.object({
  id: z.uuid(), name: fileName, size_bytes: z.number().int().min(1).max(MAX_WORK_FILE_BYTES), sha256: hash,
  media_type: z.enum(mediaTypes), state: z.enum(["uploading", "ready", "cancelled"]),
  chunk_size: z.literal(WORK_FILE_CHUNK_BYTES), chunk_count: z.number().int().min(1).max(256), received_chunks: z.number().int().min(0).max(256),
  created_at: z.iso.datetime(), ready_at: z.iso.datetime().nullable(),
}).strict().refine(value => value.chunk_count === Math.ceil(value.size_bytes / WORK_FILE_CHUNK_BYTES)
  && value.received_chunks <= value.chunk_count
  && value.media_type === (value.name.toLowerCase().endsWith(".csv") ? mediaTypes[0] : mediaTypes[1])
  && (value.state === "ready" ? value.ready_at !== null && value.received_chunks === value.chunk_count : value.ready_at === null)
  && (value.state !== "cancelled" || value.received_chunks === 0), "Inconsistent file metadata");
export const fileWriteResultSchema = z.object({ file: fileInfoSchema, replayed: z.boolean() }).strict();
export const fileCancelUnavailableSchema = z.object({ cancelled_count: z.number().int().nonnegative() }).strict();
export const fileMutationSchema = z.object({ ok: z.literal(true), replayed: z.boolean() }).strict();
export const fileListSchema = z.object({ files: z.array(fileInfoSchema).max(100), next_cursor: z.uuid().nullable() }).strict();
export type FileInfo = z.infer<typeof fileInfoSchema>;
export type FileBegin = z.infer<typeof fileBeginSchema>;
export type FileWriteResult = z.infer<typeof fileWriteResultSchema>;
export type FileMutation = z.infer<typeof fileMutationSchema>;
export type FileList = z.infer<typeof fileListSchema>;
