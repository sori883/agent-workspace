import type { WorkspaceRepository } from "../data/workspaces";
import type { WorkspaceCreateInput, WorkspaceCreateResult, WorkspaceDetail, WorkspaceGroupCreateResult, WorkspaceList, WorkspaceMemberInput, WorkspaceMutationResult, InvitationCreateInput, InvitationCreateResult } from "../shared/workspace-contracts";
export interface WorkspaceService {
  list(owner: string): Promise<WorkspaceList>;
  create(owner: string, input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>;
  get(owner: string, id: string): Promise<WorkspaceDetail>;
  rename(owner: string, id: string, input: { name: string }): Promise<WorkspaceMutationResult>;
  member(owner: string, id: string, userId: string, input: WorkspaceMemberInput): Promise<WorkspaceMutationResult>;
  removeMember(owner: string, id: string, userId: string): Promise<WorkspaceMutationResult>;
  leave(owner: string, id: string): Promise<WorkspaceMutationResult>;
  createGroup(owner: string, id: string, input: WorkspaceCreateInput): Promise<WorkspaceGroupCreateResult>;
  renameGroup(owner: string, id: string, groupId: string, input: { name: string }): Promise<WorkspaceMutationResult>;
  deleteGroup(owner: string, id: string, groupId: string): Promise<WorkspaceMutationResult>;
  groupMember(owner: string, id: string, groupId: string, userId: string, input: { member: boolean }): Promise<WorkspaceMutationResult>;
  invite(owner: string, id: string, input: InvitationCreateInput): Promise<InvitationCreateResult>;
  revokeInvitation(owner: string, id: string, inviteId: string): Promise<WorkspaceMutationResult>;
  accept(owner: string, input: { token: string }): Promise<WorkspaceCreateResult>;
}
export function postgresWorkspaceService(repository: WorkspaceRepository): WorkspaceService { return repository; }
