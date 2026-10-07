import type { WorkbenchService } from "./workbench-service";
import * as bc from "../shared/workbench-contracts";
import { MAX_WORKBENCH_RESPONSE_BYTES } from "../shared/workbench-transfer";
import * as ac from "../shared/agent-contracts";
import type { AgentService } from "./agent-service";
import type { FileService } from "./file-service";
import type { DefinitionService } from "./definition-service";
import * as dc from "../shared/definition-contracts";
import { MAX_DEFINITION_REQUEST_BYTES } from "../shared/definition-transfer";
import * as fc from "../shared/file-contracts";
import { decodeFileChunk, encodeFileChunk, fileChunkIndexSchema, fileChunkSchema } from "../shared/file-transfer";
import * as workspaceContracts from "../shared/workspace-contracts";
import type { WorkspaceService } from "./workspace-service";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { checkInputSchema } from "../shared/contracts";
import { readLimitedText } from "../shared/http";
import { validateApiConfig, type ApiConfig } from "./config";
import { artifactResultSchema, emptyRunBodySchema, MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES, recoverResultSchema, runDetailSchema, runErrorStatusSchema, runHttpErrorSchema, runIdSchema, runInputSchema, runListSchema, submitResultSchema } from "../shared/run-contracts";
import { chatInputSchema, chatSubmitResultSchema, conversationDetailSchema, conversationIdSchema, conversationListSchema, MAX_CHAT_RESPONSE_BYTES } from "../shared/chat-contracts";
import { RunServiceError, type RunService } from "./run-service";
import type { ChatService } from "./chat-service";
import { AuthenticationError, type Authenticate } from "../shared/authentication";

export function createApi(config: ApiConfig, onCheck: (id: string) => void = () => {}, runs?: RunService, chats?: ChatService, authenticate: Authenticate = async () => { throw new Error("Authentication is not configured."); }, workspaces?: WorkspaceService, agents?: AgentService, files?: FileService, definitions?: DefinitionService, workbench?: WorkbenchService) {
  validateApiConfig(config);
  const encoder = new TextEncoder();
  let credential: Promise<{ key: CryptoKey; signature: ArrayBuffer }> | undefined;
  async function authorized(value: string) {
    if (value.length !== config.apiToken.length + 7) return false;
    credential ??= (async () => {
      const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`Bearer ${config.apiToken}`));
      return { key, signature };
    })();
    const { key, signature } = await credential;
    return crypto.subtle.verify("HMAC", key, signature, encoder.encode(value));
  }
  const app = new Hono<{ Variables: { ownerUserId: string; expiresAt: number | null; tokenFingerprint: string | null } }>();
  app.use("*", async (context, next) => {
    if (context.req.header("host") !== new URL(config.apiOrigin).host || context.req.header("origin")) {
      return context.json({ error: "forbidden" }, 403);
    }
    if (!await authorized(context.req.header("authorization") ?? "")) {
      return context.json({ error: "unauthorized" }, 401);
    }
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
    if (context.req.path !== "/v1/status") {
      try { const identity = await authenticate(context.req.header("X-AX-Access-Token") ?? ""); context.set("ownerUserId", typeof identity === "string" ? identity : identity.ownerUserId); context.set("expiresAt", typeof identity === "string" ? null : identity.expiresAt); context.set("tokenFingerprint", typeof identity === "string" ? null : identity.tokenFingerprint); }
      catch (error) {
        return context.json({ error: error instanceof AuthenticationError ? "unauthorized" : "authentication_unavailable" }, error instanceof AuthenticationError ? 401 : 503);
      }
    }
    await next();
  });
  app.get("/v1/status", (context) => context.json({ service: "ax-common-api", mode: "mock" }));
  app.post("/v1/connection-check", async (context) => {
    if (context.req.header("content-type")?.split(";")[0] !== "application/json") {
      return context.json({ error: "unsupported_content_type" }, 415);
    }
    let input: unknown;
    try {
      input = JSON.parse(await readLimitedText(context.req.raw));
    } catch (error) {
      if (error instanceof Response && error.status === 413) return context.json({ error: "body_too_large" }, 413);
      return context.json({ error: "invalid_json" }, 400);
    }
    const parsed = checkInputSchema.safeParse(input);
    if (!parsed.success) return context.json({ error: "invalid_message" }, 400);
    const requestId = crypto.randomUUID();
    onCheck(requestId);
    return context.json({
      mode: "mock",
      receivedText: parsed.data.message,
      requestId,
      checkedAt: new Date().toISOString(),
    });
  });
  function workspace(context: Context, required = false) {
    const value = context.req.header("X-AX-Workspace-ID");
    if (value === undefined) { if (required) throw new RunServiceError("workspace_required", 400); return null; }
    const parsed = workspaceContracts.workspaceIdSchema.safeParse(value);
    if (!parsed.success) throw new RunServiceError("invalid_workspace_id", 400);
    return parsed.data;
  }
  function runService() {
    if (!runs) throw new RunServiceError("bridge_unavailable");
    return runs;
  }
  function runId(context: Context) {
    const parsed = runIdSchema.safeParse(context.req.param("runId"));
    if (!parsed.success) throw new RunServiceError("invalid_run_id", 400);
    return parsed.data;
  }
  function chatService() {
    if (!chats) throw new RunServiceError("bridge_unavailable");
    return chats;
  }
  function conversationId(context: Context) {
    const parsed = conversationIdSchema.safeParse(context.req.param("id"));
    if (!parsed.success) throw new RunServiceError("invalid_conversation_id", 400);
    return parsed.data;
  }
  async function runBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = MAX_RUN_REQUEST_BYTES): Promise<T> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunServiceError("unsupported_content_type", 415);
    let value: unknown;
    try { value = JSON.parse(await readLimitedText(request, maxBytes)); }
    catch (error) {
      if (error instanceof Response && error.status === 413) throw new RunServiceError("request_too_large", 413);
      throw new RunServiceError("invalid_json", 400);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data;
  }
  async function runResponse<T>(context: Context, schema: z.ZodType<T>, operation: () => Promise<unknown>, status: 200 | 202 = 200, maxBytes = MAX_RUN_RESPONSE_BYTES) {
    try {
      const parsed = schema.safeParse(await operation());
      if (!parsed.success) throw new RunServiceError("invalid_bridge_response");
      if (encoder.encode(JSON.stringify(parsed.data)).byteLength > maxBytes) throw new RunServiceError("invalid_bridge_response");
      return context.json(parsed.data, status);
    } catch (error) {
      if (error instanceof RunServiceError && runHttpErrorSchema.safeParse({ error: error.code }).success && runErrorStatusSchema.safeParse(error.status).success) return context.json({ error: error.code }, error.status);
      return context.json({ error: "bridge_unavailable" }, 503);
    }
  }
  app.get("/v1/runs", (context) => runResponse(context, runListSchema, () => runService().list(context.get("ownerUserId"), workspace(context))));
  app.post("/v1/runs", (context) => runResponse(context, submitResultSchema, async () => runService().submit(context.get("ownerUserId"), await runBody(context.req.raw, runInputSchema), workspace(context, true)), 202));
  app.get("/v1/runs/:runId", (context) => runResponse(context, runDetailSchema, async () => {
    const id = runId(context);
    const detail = await runService().get(context.get("ownerUserId"), id, workspace(context));
    if (detail.summary.run_id !== id) throw new RunServiceError("invalid_bridge_response");
    return detail;
  }));
  app.get("/v1/runs/:runId/artifact", (context) => runResponse(context, artifactResultSchema, () => runService().artifact(context.get("ownerUserId"), runId(context), workspace(context))));
  app.post("/v1/runs/:runId/recover", (context) => runResponse(context, recoverResultSchema, async () => {
    const id = runId(context);
    await runBody(context.req.raw, emptyRunBodySchema);
    const result = await runService().recover(context.get("ownerUserId"), id, workspace(context));
    if (result.run_id !== id) throw new RunServiceError("invalid_bridge_response");
    return result;
  }, 202));
  app.get("/v1/conversations", (context) => runResponse(context, conversationListSchema, () => chatService().list(context.get("ownerUserId"), workspace(context)), 200, MAX_CHAT_RESPONSE_BYTES));
  app.get("/v1/conversations/:id", (context) => runResponse(context, conversationDetailSchema, async () => {
    const id = conversationId(context);
    const detail = await chatService().get(context.get("ownerUserId"), id, workspace(context));
    if (detail.conversation.id !== id) throw new RunServiceError("invalid_bridge_response");
    return detail;
  }, 200, MAX_CHAT_RESPONSE_BYTES));
  app.post("/v1/conversations/:id/turns", (context) => runResponse(context, chatSubmitResultSchema, async () => {
    const id = conversationId(context);
    const result = await chatService().submit(context.get("ownerUserId"), id, await runBody(context.req.raw, chatInputSchema), workspace(context, true));
    if (result.conversation_id !== id) throw new RunServiceError("invalid_bridge_response");
    return result;
  }, 202, MAX_CHAT_RESPONSE_BYTES));
  function workspaceService() {
    if (!workspaces) throw new RunServiceError("bridge_unavailable");
    return workspaces;
  }
  function id(context: Context, name = "id") {
    const parsed = workspaceContracts.workspaceIdSchema.safeParse(context.req.param(name));
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data;
  }
  const wc = workspaceContracts;
  function definitionService() { if (!definitions) throw new RunServiceError("bridge_unavailable"); return definitions; }
  app.get("/v1/definitions", c => runResponse(c, dc.definitionListSchema, () => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(key => !["kind", "filter", "before", "limit", "include_archived"].includes(key) || query.getAll(key).length !== 1)) throw new RunServiceError("invalid_request", 400);
    if (query.has("limit") && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.get("limit")!)) throw new RunServiceError("invalid_request", 400);
    if (query.has("include_archived") && !["true", "false"].includes(query.get("include_archived")!)) throw new RunServiceError("invalid_request", 400);
    const options = dc.definitionListOptionsSchema.safeParse({ ...Object.fromEntries(query), ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}), ...(query.has("include_archived") ? { include_archived: query.get("include_archived") === "true" } : {}) });
    if (!options.success) throw new RunServiceError("invalid_request", 400);
    return definitionService().list(c.get("ownerUserId"), workspace(c, true)!, options.data);
  }));
  app.post("/v1/definitions", c => runResponse(c, dc.definitionMutationResultSchema, async () => definitionService().create(c.get("ownerUserId"), workspace(c, true)!, await runBody(c.req.raw, dc.definitionCreateSchema, MAX_DEFINITION_REQUEST_BYTES))));
  app.get("/v1/definitions/:id", c => runResponse(c, dc.definitionDetailSchema, async () => {
    const definitionId = id(c);
    const value = await definitionService().get(c.get("ownerUserId"), workspace(c, true)!, definitionId);
    if (value.definition.id !== definitionId) throw new RunServiceError("invalid_bridge_response");
    return value;
  }));
  app.post("/v1/definitions/:id/draft", c => runResponse(c, dc.definitionMutationResultSchema, async () => definitionService().updateDraft(c.get("ownerUserId"), workspace(c, true)!, id(c), await runBody(c.req.raw, dc.definitionUpdateSchema, MAX_DEFINITION_REQUEST_BYTES))));
  app.post("/v1/definitions/:id/publish", c => runResponse(c, dc.definitionMutationResultSchema, async () => definitionService().publish(c.get("ownerUserId"), workspace(c, true)!, id(c), await runBody(c.req.raw, dc.definitionRevisionInputSchema))));
  app.post("/v1/definitions/:id/archive", c => runResponse(c, dc.definitionMutationResultSchema, async () => definitionService().archive(c.get("ownerUserId"), workspace(c, true)!, id(c), await runBody(c.req.raw, dc.definitionRevisionInputSchema))));
  app.get("/v1/definition-versions/:id", c => runResponse(c, dc.definitionVersionSchema, async () => {
    const versionId = id(c);
    const value = await definitionService().getVersion(c.get("ownerUserId"), workspace(c, true)!, versionId);
    if (value.id !== versionId) throw new RunServiceError("invalid_bridge_response");
    return value;
  }));
  function fileService() { if (!files) throw new RunServiceError("bridge_unavailable"); return files; }
  function chunkIndex(c: Context) {
    const value = c.req.param("index");
    if (!/^(0|[1-9][0-9]{0,2})$/.test(value ?? "")) throw new RunServiceError("invalid_request", 400);
    const parsed = fileChunkIndexSchema.safeParse(Number(value));
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data;
  }
  app.get("/v1/files", c => runResponse(c, fc.fileListSchema, () => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(key => key !== "before") || query.getAll("before").length > 1) throw new RunServiceError("invalid_request", 400);
    const before = query.get("before");
    if (before !== null && !z.uuid().safeParse(before).success) throw new RunServiceError("invalid_request", 400);
    return fileService().list(c.get("ownerUserId"), workspace(c, true)!, { ...(before ? { before } : {}), limit: 50 });
  }));
  app.post("/v1/files", c => runResponse(c, fc.fileWriteResultSchema, async () => fileService().begin(c.get("ownerUserId"), workspace(c, true)!, await runBody(c.req.raw, fc.fileBeginSchema))));
  app.post("/v1/files/cancel-unavailable", c => runResponse(c, fc.fileCancelUnavailableSchema, async () => {
    await runBody(c.req.raw, emptyRunBodySchema);
    return fileService().cancelUnavailable(c.get("ownerUserId"), workspace(c, true)!);
  }));
  app.get("/v1/files/:id", c => runResponse(c, fc.fileInfoSchema, () => fileService().get(c.get("ownerUserId"), workspace(c, true)!, id(c))));
  app.get("/v1/files/:id/chunks/:index", c => runResponse(c, fileChunkSchema, async () => ({ content_base64: encodeFileChunk(await fileService().readChunk(c.get("ownerUserId"), workspace(c, true)!, id(c), chunkIndex(c))) })));
  app.post("/v1/files/:id/chunks/:index", c => runResponse(c, fc.fileMutationSchema, async () => {
    const input = await runBody(c.req.raw, fileChunkSchema);
    return fileService().putChunk(c.get("ownerUserId"), workspace(c, true)!, id(c), chunkIndex(c), decodeFileChunk(input.content_base64));
  }));
  app.post("/v1/files/:id/seal", c => runResponse(c, fc.fileWriteResultSchema, async () => {
    await runBody(c.req.raw, emptyRunBodySchema);
    return fileService().seal(c.get("ownerUserId"), workspace(c, true)!, id(c));
  }));
  app.post("/v1/files/:id/cancel", c => runResponse(c, fc.fileMutationSchema, async () => {
    await runBody(c.req.raw, emptyRunBodySchema);
    return fileService().cancel(c.get("ownerUserId"), workspace(c, true)!, id(c));
  }));
  app.get("/v1/workspaces", c => runResponse(c, wc.workspaceListSchema, () => workspaceService().list(c.get("ownerUserId"))));
  app.post("/v1/workspaces", c => runResponse(c, wc.workspaceCreateResultSchema, async () => workspaceService().create(c.get("ownerUserId"), await runBody(c.req.raw, wc.workspaceCreateInputSchema))));
  app.get("/v1/workspaces/:id", c => runResponse(c, wc.workspaceDetailSchema, () => workspaceService().get(c.get("ownerUserId"), id(c))));
  app.post("/v1/workspaces/:id", c => runResponse(c, wc.workspaceMutationResultSchema, async () => workspaceService().rename(c.get("ownerUserId"), id(c), await runBody(c.req.raw, wc.workspaceRenameInputSchema))));
  app.post("/v1/workspaces/:id/members/:userId", c => runResponse(c, wc.workspaceMutationResultSchema, async () => workspaceService().member(c.get("ownerUserId"), id(c), id(c,"userId"), await runBody(c.req.raw, wc.workspaceMemberInputSchema))));
  app.delete("/v1/workspaces/:id/members/:userId", c => runResponse(c, wc.workspaceMutationResultSchema, () => workspaceService().removeMember(c.get("ownerUserId"), id(c), id(c,"userId"))));
  app.post("/v1/workspaces/:id/leave", c => runResponse(c, wc.workspaceMutationResultSchema, async () => { await runBody(c.req.raw,wc.workspaceEmptyInputSchema); return workspaceService().leave(c.get("ownerUserId"), id(c)); }));
  app.post("/v1/workspaces/:id/groups", c => runResponse(c, wc.workspaceGroupCreateResultSchema, async () => workspaceService().createGroup(c.get("ownerUserId"), id(c), await runBody(c.req.raw, wc.workspaceGroupCreateInputSchema))));
  app.post("/v1/workspaces/:id/groups/:groupId", c => runResponse(c, wc.workspaceMutationResultSchema, async () => workspaceService().renameGroup(c.get("ownerUserId"), id(c), id(c,"groupId"), await runBody(c.req.raw, wc.workspaceRenameInputSchema))));
  app.delete("/v1/workspaces/:id/groups/:groupId", c => runResponse(c, wc.workspaceMutationResultSchema, () => workspaceService().deleteGroup(c.get("ownerUserId"), id(c), id(c,"groupId"))));
  app.post("/v1/workspaces/:id/groups/:groupId/members/:userId", c => runResponse(c, wc.workspaceMutationResultSchema, async () => workspaceService().groupMember(c.get("ownerUserId"), id(c), id(c,"groupId"), id(c,"userId"), await runBody(c.req.raw, wc.workspaceGroupMemberInputSchema))));
  app.post("/v1/workspaces/:id/invitations", c => runResponse(c, wc.invitationCreateResultSchema, async () => workspaceService().invite(c.get("ownerUserId"), id(c), await runBody(c.req.raw, wc.invitationCreateInputSchema))));
  app.delete("/v1/workspaces/:id/invitations/:inviteId", c => runResponse(c, wc.workspaceMutationResultSchema, () => workspaceService().revokeInvitation(c.get("ownerUserId"), id(c), id(c,"inviteId"))));
  app.post("/v1/invitations/accept", c => runResponse(c, wc.invitationAcceptResultSchema, async () => workspaceService().accept(c.get("ownerUserId"), await runBody(c.req.raw, wc.invitationAcceptInputSchema))));
  app.post("/v1/workspaces/:id/ownership-transfers", c => runResponse(c, wc.ownershipTransferResultSchema, async () => workspaceService().proposeOwnership(c.get("ownerUserId"), id(c), await runBody(c.req.raw, wc.ownershipTransferInputSchema))));
  app.post("/v1/workspaces/:id/ownership-transfers/:transferId/:action", c => runResponse(c, wc.workspaceMutationResultSchema, async () => {
    const action = wc.ownershipTransferActionSchema.safeParse(c.req.param("action"));
    if (!action.success) throw new RunServiceError("invalid_request", 400);
    await runBody(c.req.raw, wc.workspaceEmptyInputSchema);
    return workspaceService().respondOwnership(c.get("ownerUserId"), id(c), id(c,"transferId"), action.data);
  }));
  function agentService() { if (!agents) throw new RunServiceError("bridge_unavailable"); return agents; }
  function fingerprint(c: Context) { const value:unknown=c.get("tokenFingerprint"); if(typeof value!=="string" || !/^[0-9a-f]{64}$/.test(value)) throw new RunServiceError("agent_grant_expired",401); return value; }
  function grant(c: Context) { const exp:unknown=c.get("expiresAt"); if(typeof exp!=="number" || !Number.isSafeInteger(exp) || exp<=Date.now()/1000) throw new RunServiceError("agent_grant_expired",401); return exp; }
  app.get("/v1/agent-roots", c=>runResponse(c,ac.agentListSchema,()=>agentService().list(c.get("ownerUserId"),workspace(c,true)!)));
  app.post("/v1/agent-roots", c=>runResponse(c,ac.agentSubmitSchema,async()=>agentService().start(c.get("ownerUserId"),workspace(c,true)!,await runBody(c.req.raw,ac.agentStartSchema),grant(c),fingerprint(c)),202));
  app.post("/v1/agent-roots/revoke-all", c=>runResponse(c,ac.agentMutationSchema,async()=>{await runBody(c.req.raw,emptyRunBodySchema);return agentService().revoke(c.get("ownerUserId"),fingerprint(c));}));
  app.get("/v1/agent-roots/:id", c=>runResponse(c,ac.agentRootSchema,()=>agentService().get(c.get("ownerUserId"),workspace(c,true)!,id(c))));
  app.post("/v1/agent-roots/:id/answer", c=>runResponse(c,ac.agentSubmitSchema,async()=>agentService().answer(c.get("ownerUserId"),workspace(c,true)!,id(c),await runBody(c.req.raw,ac.agentAnswerSchema),grant(c),fingerprint(c)),202));
  app.post("/v1/agent-roots/:id/stop", c=>runResponse(c,ac.agentMutationSchema,async()=>{await runBody(c.req.raw,emptyRunBodySchema);return agentService().stop(c.get("ownerUserId"),workspace(c,true)!,id(c));}));
  function workbenchService() { if (!workbench) throw new RunServiceError("bridge_unavailable"); return workbench; }
  app.get("/v1/workbench", c => runResponse(c, bc.workbenchListSchema, () => {
    const query = new URL(c.req.url).searchParams;
    if ([...query.keys()].some(key => key !== "before") || query.getAll("before").length > 1) throw new RunServiceError("invalid_request", 400);
    const before = query.get("before");
    if (before !== null && !z.uuid().safeParse(before).success) throw new RunServiceError("invalid_request", 400);
    return workbenchService().list(c.get("ownerUserId"), workspace(c, true)!, before);
  }, 200, MAX_WORKBENCH_RESPONSE_BYTES));
  app.post("/v1/workbench", c => runResponse(c, bc.workbenchSubmitSchema, async () => workbenchService().start(c.get("ownerUserId"), workspace(c, true)!, await runBody(c.req.raw, bc.workbenchStartSchema), grant(c), fingerprint(c)), 202));
  app.get("/v1/workbench/:id", c => runResponse(c, bc.workbenchRootSchema, async () => {
    const rootId = id(c);
    const value = await workbenchService().get(c.get("ownerUserId"), workspace(c, true)!, rootId);
    if (value.id !== rootId) throw new RunServiceError("invalid_bridge_response");
    return value;
  }, 200, MAX_WORKBENCH_RESPONSE_BYTES));
  app.post("/v1/workbench/:id/answer", c => runResponse(c, bc.workbenchSubmitSchema, async () => workbenchService().answer(c.get("ownerUserId"), workspace(c, true)!, id(c), await runBody(c.req.raw, bc.workbenchAnswerSchema), grant(c), fingerprint(c)), 202));
  app.post("/v1/workbench/:id/stop", c => runResponse(c, bc.workbenchMutationSchema, async () => { await runBody(c.req.raw, emptyRunBodySchema); return workbenchService().stop(c.get("ownerUserId"), workspace(c, true)!, id(c)); }));
  app.post("/v1/workbench/:id/recover", c => runResponse(c, bc.workbenchMutationSchema, async () => { await runBody(c.req.raw, emptyRunBodySchema); return workbenchService().recover(c.get("ownerUserId"), workspace(c, true)!, id(c)); }));
  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError(() => new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  return app;
}
