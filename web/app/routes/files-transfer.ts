import type { Route } from "./+types/files-transfer";
import { fileTransferSchema } from "../../shared/file-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_REQUEST_BYTES } from "../../shared/run-contracts";
import { requireAuth } from "../lib/auth.server";
import { filesClient } from "../lib/files.server";
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
    const text = await readLimitedText(request, MAX_RUN_REQUEST_BYTES);
    let json: unknown;
    try { json = JSON.parse(text); } catch { return reply({ error: "invalid_request" }, 400); }
    const parsed = fileTransferSchema.safeParse(json);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const value = parsed.data;
    await verifySubmission(request, value.csrf);
    const api = filesClient(user.accessToken, scope.workspaceId);
    switch (value.intent) {
      case "list": return reply(await api.list(value.before));
      case "begin": return reply(await api.begin(value.input));
      case "cancel_unavailable": return reply(await api.cancelUnavailable());
      case "get": return reply(await api.get(value.id));
      case "read": return reply(await api.readChunk(value.id, value.index));
      case "put": return reply(await api.putChunk(value.id, value.index, value.content_base64));
      case "seal": return reply(await api.seal(value.id));
      case "cancel": return reply(await api.cancel(value.id));
    }
  } catch (cause) {
    if (cause instanceof RunApiError) return reply({ error: cause.code }, cause.status);
    if (cause instanceof Response) return reply({ error: cause.status === 413 ? "request_too_large" : "submission_expired" }, cause.status);
    return reply({ error: "api_unavailable" }, 503);
  }
}
