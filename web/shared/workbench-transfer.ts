import { z } from "zod";
import { workbenchAnswerSchema, workbenchStartSchema } from "./workbench-contracts";

export const MAX_WORKBENCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const common = { csrf: z.string().min(1).max(256) };
export const workbenchTransferSchema = z.discriminatedUnion("intent", [
  z.object({ ...common, intent: z.literal("start"), input: workbenchStartSchema }).strict(),
  z.object({ ...common, intent: z.literal("answer"), id: z.uuid(), input: workbenchAnswerSchema }).strict(),
  z.object({ ...common, intent: z.enum(["stop", "recover"]), id: z.uuid() }).strict(),
]);
export type WorkbenchTransfer = z.infer<typeof workbenchTransferSchema>;
