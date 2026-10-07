import { z } from "zod";
import { RunServiceError } from "../api/run-service";
import type { WorkspaceService } from "../api/workspace-service";
import * as c from "../shared/workspace-contracts";
import type { Database } from "./db";
import { sha256, utf8 } from "./canonical";
const errors = new Map<string, 400 | 403 | 404 | 409>([
  ["invalid_request", 400], ["invalid_owner_user_id", 400], ["workspace_required", 400],
  ["workspace_forbidden", 403], ["workspace_owner_required", 403], ["ownership_transfer_forbidden", 403], ["verified_email_required", 403], ["invitation_recipient_mismatch", 403],
  ...["workspace_not_found", "group_not_found", "member_not_found", "invitation_not_found", "ownership_transfer_not_found"].map((code) => [code, 404] as const),
  ...["workspace_ownership_limit", "workspace_owner_cannot_leave", "ownership_transfer_pending", "ownership_transfer_unavailable", "ownership_transfer_invalid_recipient", "last_workspace_admin", "idempotency_conflict", "invitation_unavailable", "invitation_sender_inactive", "invitation_already_used"].map((code) => [code, 409] as const),
]);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RunServiceError("invalid_request", 400);
  return parsed.data;
}
export class WorkspaceRepository implements WorkspaceService {
  constructor(readonly database: Database) {}
  private async call<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const { rows } = await this.database.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args);
      if (rows.length !== 1) throw new RunServiceError("invalid_bridge_response");
      const parsed = schema.safeParse(rows[0].value);
      if (!parsed.success) throw new RunServiceError("invalid_bridge_response");
      return parsed.data;
    } catch (error) {
      if (error instanceof RunServiceError) throw error;
      if (error && typeof error === "object" && "code" in error && error.code === "P0001" && "message" in error && typeof error.message === "string" && errors.has(error.message)) throw new RunServiceError(error.message, errors.get(error.message));
      throw new RunServiceError("bridge_unavailable");
    }
  }
  proposeOwnership(owner: string, id: string, input: c.OwnershipTransferInput) {
    const value = parse(c.ownershipTransferInputSchema, input);
    return this.call("org_propose_ownership", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id), value.key, value.to_user_id, crypto.randomUUID()], c.ownershipTransferResultSchema);
  }
  respondOwnership(owner: string, id: string, transferId: string, action: c.OwnershipTransferAction) {
    return this.call("org_respond_ownership", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id), parse(c.workspaceIdSchema, transferId), parse(c.ownershipTransferActionSchema, action)], c.workspaceMutationResultSchema);
  }
  list(owner: string) { return this.call("org_list", [parse(c.workspaceIdSchema, owner)], c.workspaceListSchema); }
  create(owner: string, input: c.WorkspaceCreateInput) {
    const v = parse(c.workspaceCreateInputSchema, input);
    return this.call("org_create", [parse(c.workspaceIdSchema, owner), v.key, v.name, crypto.randomUUID()], c.workspaceCreateResultSchema);
  }
  get(owner: string, id: string) { return this.call("org_detail", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id)], c.workspaceDetailSchema); }
  private mutate(owner: string, id: string, operation: string, target: string | null, value: unknown = {}) {
    return this.call("org_mutate", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id), operation, target === null ? null : parse(c.workspaceIdSchema, target), JSON.stringify(value)], c.workspaceMutationResultSchema);
  }
  rename(owner: string, id: string, input: { name: string }) { return this.mutate(owner, id, "rename", null, parse(c.workspaceRenameInputSchema, input)); }
  member(owner: string, id: string, userId: string, input: c.WorkspaceMemberInput) { return this.mutate(owner, id, "member", userId, parse(c.workspaceMemberInputSchema, input)); }
  removeMember(owner: string, id: string, userId: string) { return this.mutate(owner, id, "remove_member", userId); }
  leave(owner: string, id: string) { return this.mutate(owner, id, "leave", null); }
  createGroup(owner: string, id: string, input: c.WorkspaceCreateInput) {
    const v = parse(c.workspaceGroupCreateInputSchema, input);
    return this.call("org_create_group", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id), v.key, v.name, crypto.randomUUID()], c.workspaceGroupCreateResultSchema);
  }
  renameGroup(owner: string, id: string, groupId: string, input: { name: string }) { return this.mutate(owner, id, "rename_group", groupId, parse(c.workspaceRenameInputSchema, input)); }
  deleteGroup(owner: string, id: string, groupId: string) { return this.mutate(owner, id, "delete_group", groupId); }
  groupMember(owner: string, id: string, groupId: string, userId: string, input: { member: boolean }) { return this.mutate(owner, id, "group_member", groupId, { ...parse(c.workspaceGroupMemberInputSchema, input), user_id: parse(c.workspaceIdSchema, userId) }); }
  async invite(owner: string, id: string, input: c.InvitationCreateInput) {
    const v = parse(c.invitationCreateInputSchema, input);
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const result = await this.call("org_invite", [parse(c.workspaceIdSchema, owner), parse(c.workspaceIdSchema, id), v.key, v.email, crypto.randomUUID(), await sha256(utf8(token))], z.object({ id: c.workspaceIdSchema, expires_at: z.iso.datetime(), replayed: z.boolean() }).strict());
    return c.invitationCreateResultSchema.parse({ ...result, token: result.replayed ? null : token });
  }
  revokeInvitation(owner: string, id: string, inviteId: string) { return this.mutate(owner, id, "revoke_invitation", inviteId); }
  async accept(owner: string, input: { token: string }) {
    const v = parse(c.invitationAcceptInputSchema, input);
    return this.call("org_accept_invitation", [parse(c.workspaceIdSchema, owner), await sha256(utf8(v.token))], c.invitationAcceptResultSchema);
  }
}
