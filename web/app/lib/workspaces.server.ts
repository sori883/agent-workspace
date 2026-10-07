import { z } from "zod";
import { readConfig, type LocalConfig } from "../../server/config";
import { readLimitedText } from "../../shared/http";
import * as c from "../../shared/workspace-contracts";
import { runErrorStatusSchema, runHttpErrorSchema, MAX_RUN_REQUEST_BYTES } from "../../shared/run-contracts";
import { RunApiError } from "./runs.server";
export function workspacesClient(accessToken: string, config: LocalConfig = readConfig(), timeoutMs = 8000) {
  function id(value: string) {
    const parsed = c.workspaceIdSchema.safeParse(value);
    if (!parsed.success) throw new RunApiError("invalid_request", 400);
    return parsed.data;
  }
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RunApiError("invalid_request", 400);
    return parsed.data;
  }
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const json = body === undefined ? undefined : JSON.stringify(body);
    if (json && new TextEncoder().encode(json).length > MAX_RUN_REQUEST_BYTES) throw new RunApiError("body_too_large", 413);
    try {
      const response = await fetch(new URL(path, config.apiOrigin), { method, body: json, headers: { Authorization: `Bearer ${config.apiToken}`, "X-AX-Access-Token": accessToken, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunApiError("invalid_api_response");
      const value: unknown = JSON.parse(await readLimitedText(response, 1024 * 1024));
      if (!response.ok) {
        const parsed = runHttpErrorSchema.safeParse(value);
        if (!parsed.success || !runErrorStatusSchema.safeParse(response.status).success) throw new RunApiError("invalid_api_response");
        throw new RunApiError(parsed.data.error, response.status);
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new RunApiError("invalid_api_response");
      return parsed.data;
    } catch (error) { if (error instanceof RunApiError) throw error; throw new RunApiError("api_unavailable"); }
  }
  const path = (workspace: string) => `/v1/workspaces/${id(workspace)}`;
  return {
    list: () => request("/v1/workspaces", c.workspaceListSchema),
    create: (value: unknown) => request("/v1/workspaces", c.workspaceCreateResultSchema, input(c.workspaceCreateInputSchema, value)),
    get: (workspace: string) => request(path(workspace), c.workspaceDetailSchema).then((detail) => { if (detail.workspace.id !== id(workspace)) throw new RunApiError("invalid_api_response"); return detail; }),
    rename: (workspace: string, value: unknown) => request(path(workspace), c.workspaceMutationResultSchema, input(c.workspaceRenameInputSchema, value)),
    member: (workspace: string, user: string, value: unknown) => request(`${path(workspace)}/members/${id(user)}`, c.workspaceMutationResultSchema, input(c.workspaceMemberInputSchema, value)),
    removeMember: (workspace: string, user: string) => request(`${path(workspace)}/members/${id(user)}`, c.workspaceMutationResultSchema, {}, "DELETE"),
    leave: (workspace: string) => request(`${path(workspace)}/leave`, c.workspaceMutationResultSchema, {}),
    proposeOwnership: (workspace: string, value: unknown) => request(`${path(workspace)}/ownership-transfers`, c.ownershipTransferResultSchema, input(c.ownershipTransferInputSchema, value)),
    respondOwnership: (workspace: string, transfer: string, action: unknown) => request(`${path(workspace)}/ownership-transfers/${id(transfer)}/${input(c.ownershipTransferActionSchema, action)}`, c.workspaceMutationResultSchema, {}),
    createGroup: (workspace: string, value: unknown) => request(`${path(workspace)}/groups`, c.workspaceGroupCreateResultSchema, input(c.workspaceGroupCreateInputSchema, value)),
    renameGroup: (workspace: string, group: string, value: unknown) => request(`${path(workspace)}/groups/${id(group)}`, c.workspaceMutationResultSchema, input(c.workspaceRenameInputSchema, value)),
    deleteGroup: (workspace: string, group: string) => request(`${path(workspace)}/groups/${id(group)}`, c.workspaceMutationResultSchema, {}, "DELETE"),
    groupMember: (workspace: string, group: string, user: string, value: unknown) => request(`${path(workspace)}/groups/${id(group)}/members/${id(user)}`, c.workspaceMutationResultSchema, input(c.workspaceGroupMemberInputSchema, value)),
    invite: (workspace: string, value: unknown) => request(`${path(workspace)}/invitations`, c.invitationCreateResultSchema, input(c.invitationCreateInputSchema, value)),
    revokeInvitation: (workspace: string, invite: string) => request(`${path(workspace)}/invitations/${id(invite)}`, c.workspaceMutationResultSchema, {}, "DELETE"),
    accept: (value: unknown) => request("/v1/invitations/accept", c.invitationAcceptResultSchema, input(c.invitationAcceptInputSchema, value)),
  };
}
