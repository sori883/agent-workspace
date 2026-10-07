import { data, redirect } from "react-router";
import { z } from "zod";
import type { DefinitionContent, DefinitionDetail } from "../../shared/definition-contracts";
import { requireAuth } from "./auth.server";
import { definitionsClient } from "./definitions.server";
import { definitionErrorMessage } from "./definition-copy";
import { RunApiError } from "./runs.server";
import { loadSession, pageHeaders } from "./security.server";
import { scopeHref } from "./workspace-scope";
import { requireWorkspaceScope, workspaceTitle } from "./workspace-scope.server";

export async function libraryPage(request: Request, definitionId?: string) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  if (!scope.workspaceId) throw redirect("/workspaces");
  const session = await loadSession(request);
  const headers = pageHeaders();
  if (session.cookie) headers.set("Set-Cookie", session.cookie);
  const query = new URL(request.url).searchParams;
  if (["kind", "draft", "copy"].some(key => query.getAll(key).length > 1)) throw new Response("設定一覧から開き直してください。", { status: 400, headers });
  const api = definitionsClient(user.accessToken, scope.workspaceId);
  let detail: DefinitionDetail | null = null;
  let content: DefinitionContent;
  let kind: "skill" | "agent";
  let visibility: "personal" | "workspace" = "personal";
  let draftKey = query.get("draft");
  try {
    if (definitionId) {
      if (!z.uuid().safeParse(definitionId).success) throw new RunApiError("definition_not_found", 404);
      detail = await api.get(definitionId);
      kind = detail.definition.kind; visibility = detail.definition.visibility;
      const saved = detail.draft?.content ?? detail.version?.content;
      if (!saved) throw new RunApiError("invalid_api_response");
      content = saved;
    } else {
      if (!draftKey) {
        const target = new URL(request.url); target.searchParams.set("draft", crypto.randomUUID());
        throw redirect(target.pathname + target.search, { headers });
      }
      if (!z.uuid().safeParse(draftKey).success) throw new RunApiError("invalid_request", 400);
      const source = query.get("copy");
      if (source) {
        if (!z.uuid().safeParse(source).success) throw new RunApiError("invalid_request", 400);
        const original = await api.get(source);
        kind = original.definition.kind;
        const saved = original.draft?.content ?? original.version?.content;
        if (!saved) throw new RunApiError("invalid_api_response");
        content = saved;
      } else {
        const parsed = z.enum(["skill", "agent"]).safeParse(query.get("kind"));
        if (!parsed.success) throw redirect(scopeHref("/library", scope), { headers });
        kind = parsed.data;
        content = kind === "skill" ? { name: "", description: "", instructions: "", files: [] } : { name: "", instructions: "", skill_version_ids: [], allowed_tools: [] };
      }
    }
  } catch (cause) {
    if (cause instanceof Response) throw cause;
    throw new Response(definitionErrorMessage(cause instanceof RunApiError ? cause.code : "api_unavailable"), { status: cause instanceof RunApiError ? cause.status : 503, headers });
  }
  const selectedSkills: Record<string, string> = {};
  if ("skill_version_ids" in content) {
    const results = await Promise.allSettled(content.skill_version_ids.map(id => api.getVersion(id)));
    results.forEach((result, i) => { selectedSkills[content.skill_version_ids[i]!] = result.status === "fulfilled" ? `${result.value.content.name}（第${result.value.version}版）` : "利用できないスキル（選び直してください）"; });
  }
  return data({ scope, csrf: session.csrf, workspaceName: await workspaceTitle(user.accessToken, scope), detail, kind, visibility, content, draftKey: draftKey ?? crypto.randomUUID(), selectedSkills, copied: query.has("copy") }, { headers });
}
