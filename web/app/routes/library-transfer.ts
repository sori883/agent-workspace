import type { Route } from "./+types/library-transfer";
import { definitionTransferSchema, MAX_DEFINITION_REQUEST_BYTES } from "../../shared/definition-transfer";
import { readLimitedText } from "../../shared/http";
import { requireAuth } from "../lib/auth.server";
import { definitionsClient } from "../lib/definitions.server";
import { RunApiError } from "../lib/runs.server";
import { pageHeaders, verifySubmission } from "../lib/security.server";
import { requireWorkspaceScope } from "../lib/workspace-scope.server";

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);
  const scope = requireWorkspaceScope(request);
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: pageHeaders() });
  if (!scope.workspaceId) return reply({ error: "workspace_required" }, 400);
  try {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return reply({ error: "unsupported_content_type" }, 415);
    const text = await readLimitedText(request, MAX_DEFINITION_REQUEST_BYTES);
    let json: unknown;
    try { json = JSON.parse(text); } catch { return reply({ error: "invalid_request" }, 400); }
    const parsed = definitionTransferSchema.safeParse(json);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const value = parsed.data;
    await verifySubmission(request, value.csrf);
    const api = definitionsClient(user.accessToken, scope.workspaceId);
    switch (value.intent) {
      case "list": return reply(await api.list(value.options));
      case "get": return reply(await api.get(value.id));
      case "version": return reply(await api.getVersion(value.id));
      case "create": return reply(await api.create(value.input));
      case "update": return reply(await api.update(value.id, value.input));
      case "publish": return reply(await api.publish(value.id, value.input));
      case "archive": return reply(await api.archive(value.id, value.input));
    }
  } catch (cause) {
    if (cause instanceof RunApiError) return reply({ error: cause.code }, cause.status);
    if (cause instanceof Response) return reply({ error: cause.status === 413 ? "request_too_large" : "submission_expired" }, cause.status);
    return reply({ error: "api_unavailable" }, 503);
  }
}
