import type { Route } from "./+types/run-artifact";
import { runIdSchema } from "../../shared/run-contracts";
import { runsClient, RunApiError } from "../lib/runs.server";
import { loadSession, pageHeaders } from "../lib/security.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await loadSession(request);
  const headers = pageHeaders();
  try {
    if (!runIdSchema.safeParse(params.runId).success) return new Response("成果物が見つかりません。", { status: 404, headers });
    const artifact = await runsClient().artifact(params.runId);
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="${artifact.name}"`);
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(artifact.content, { headers });
  } catch (cause) {
    return new Response("成果物を取得できませんでした。結果画面から状態を確認してください。", { status: cause instanceof RunApiError ? cause.status : 503, headers });
  }
}
