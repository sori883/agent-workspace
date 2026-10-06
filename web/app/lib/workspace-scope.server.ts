import { workspacesClient } from "./workspaces.server";
import { redirect } from "react-router";
import { workspaceIdSchema } from "../../shared/workspace-contracts";
import { pageHeaders } from "./security.server";
import type { WorkspaceScope } from "./workspace-scope";
export function requireWorkspaceScope(request: Request): WorkspaceScope {
  const query = new URL(request.url).searchParams;
  if (query.getAll("workspace").length > 1 || query.getAll("legacy").length > 1 || (query.has("workspace") && query.has("legacy"))) throw new Response("ワークスペースを選び直してください。", { status: 400, headers: pageHeaders() });
  if (query.has("workspace")) {
    const parsed = workspaceIdSchema.safeParse(query.get("workspace"));
    if (!parsed.success) throw new Response("ワークスペースを選び直してください。", { status: 400, headers: pageHeaders() });
    return { workspaceId: parsed.data, legacy: false };
  }
  if (query.get("legacy") === "1") return { workspaceId: null, legacy: true };
  if (request.method === "GET") throw redirect("/workspaces", { headers: pageHeaders() });
  throw new Response("ワークスペースを選んでから送信してください。", { status: 400, headers: pageHeaders() });
}

export async function workspaceTitle(accessToken: string, scope: WorkspaceScope): Promise<string | null> {
  if (!scope.workspaceId) return null;
  try { return (await workspacesClient(accessToken).get(scope.workspaceId)).workspace.name; } catch { return null; }
}
