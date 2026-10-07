import { z } from "zod";
import { definitionCreateSchema, definitionListOptionsSchema, definitionRevisionInputSchema, definitionUpdateSchema } from "./definition-contracts";

export const MAX_DEFINITION_REQUEST_BYTES = 192 * 1024;
const csrf = z.string().min(1).max(128);
const id = z.uuid();
export const definitionTransferSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("list"), csrf, options: definitionListOptionsSchema }).strict(),
  z.object({ intent: z.literal("get"), csrf, id }).strict(),
  z.object({ intent: z.literal("version"), csrf, id }).strict(),
  z.object({ intent: z.literal("create"), csrf, input: definitionCreateSchema }).strict(),
  z.object({ intent: z.literal("update"), csrf, id, input: definitionUpdateSchema }).strict(),
  z.object({ intent: z.literal("publish"), csrf, id, input: definitionRevisionInputSchema }).strict(),
  z.object({ intent: z.literal("archive"), csrf, id, input: definitionRevisionInputSchema }).strict(),
]);
