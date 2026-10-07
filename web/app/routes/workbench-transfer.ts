import type { Route } from "./+types/workbench-transfer";
import { workbenchTransferSchema } from "../../shared/workbench-transfer";
import { readLimitedText } from "../../shared/http";
import { MAX_RUN_REQUEST_BYTES } from "../../shared/run-contracts";
import { requireAuth } from "../lib/auth.server";
import { workbenchClient } from "../lib/workbench.server";
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
    let json: unknown;
    const text = await readLimitedText(request, MAX_RUN_REQUEST_BYTES);
    try { json = JSON.parse(text); } catch { return reply({ error: "invalid_request" }, 400); }
    const parsed = workbenchTransferSchema.safeParse(json);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const value = parsed.data;
    await verifySubmission(request, value.csrf);
    const api = workbenchClient(user.accessToken, scope.workspaceId);
    if (value.intent === "start") return reply(await api.start(value.input));
    if (value.intent === "answer") return reply(await api.answer(value.id, value.input));
    if (value.intent === "stop") return reply(await api.stop(value.id));
    return reply(await api.recover(value.id));
  } catch (cause) {
    if (cause instanceof RunApiError) return reply({ error: cause.code }, cause.status);
    if (cause instanceof Response) return reply({ error: cause.status === 413 ? "request_too_large" : "submission_expired" }, cause.status);
    return reply({ error: "api_unavailable" }, 503);
  }
}
