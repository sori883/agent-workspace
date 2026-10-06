import { z } from "zod";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_MESSAGE_LENGTH = 200;
export const checkInputSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
}).strict();
export const statusSchema = z.object({
  service: z.literal("ax-common-api"),
  mode: z.literal("mock"),
}).strict();
export const checkResultSchema = z.object({
  mode: z.literal("mock"),
  receivedText: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  requestId: z.uuid(),
  checkedAt: z.iso.datetime(),
}).strict();
export type CheckInput = z.infer<typeof checkInputSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
