import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { checkInputSchema } from "../shared/contracts";
import { readLimitedText } from "../shared/http";
import type { LocalConfig } from "../server/config";
import { artifactResultSchema, emptyRunBodySchema, MAX_RUN_REQUEST_BYTES, recoverResultSchema, runDetailSchema, runErrorStatusSchema, runHttpErrorSchema, runIdSchema, runInputSchema, runListSchema, submitResultSchema } from "../shared/run-contracts";
import { RunServiceError, type RunService } from "./run-service";

export function createApi(config: LocalConfig, onCheck: (id: string) => void = () => {}, runs?: RunService) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const authorization = Buffer.from(context.req.header("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${config.apiToken}`);
    if (context.req.header("host") !== new URL(config.apiOrigin).host || context.req.header("origin")) {
      return context.json({ error: "forbidden" }, 403);
    }
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    context.header("Cache-Control", "no-store");
    context.header("X-Content-Type-Options", "nosniff");
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
    const requestId = randomUUID();
    onCheck(requestId);
    return context.json({
      mode: "mock",
      receivedText: parsed.data.message,
      requestId,
      checkedAt: new Date().toISOString(),
    });
  });
  function runService() {
    if (!runs) throw new RunServiceError("bridge_unavailable");
    return runs;
  }
  function runId(context: Context) {
    const parsed = runIdSchema.safeParse(context.req.param("runId"));
    if (!parsed.success) throw new RunServiceError("invalid_run_id", 400);
    return parsed.data;
  }
  async function runBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new RunServiceError("unsupported_content_type", 415);
    let value: unknown;
    try { value = JSON.parse(await readLimitedText(request, MAX_RUN_REQUEST_BYTES)); }
    catch (error) {
      if (error instanceof Response && error.status === 413) throw new RunServiceError("request_too_large", 413);
      throw new RunServiceError("invalid_json", 400);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RunServiceError("invalid_request", 400);
    return parsed.data;
  }
  async function runResponse<T>(context: Context, schema: z.ZodType<T>, operation: () => Promise<unknown>, status: 200 | 202 = 200) {
    try {
      const parsed = schema.safeParse(await operation());
      if (!parsed.success) throw new RunServiceError("invalid_bridge_response");
      return context.json(parsed.data, status);
    } catch (error) {
      if (error instanceof RunServiceError && runHttpErrorSchema.safeParse({ error: error.code }).success && runErrorStatusSchema.safeParse(error.status).success) return context.json({ error: error.code }, error.status);
      return context.json({ error: "bridge_unavailable" }, 503);
    }
  }
  app.get("/v1/runs", (context) => runResponse(context, runListSchema, () => runService().list()));
  app.post("/v1/runs", (context) => runResponse(context, submitResultSchema, async () => runService().submit(await runBody(context.req.raw, runInputSchema)), 202));
  app.get("/v1/runs/:runId", (context) => runResponse(context, runDetailSchema, async () => {
    const id = runId(context);
    const detail = await runService().get(id);
    if (detail.summary.run_id !== id) throw new RunServiceError("invalid_bridge_response");
    return detail;
  }));
  app.get("/v1/runs/:runId/artifact", (context) => runResponse(context, artifactResultSchema, () => runService().artifact(runId(context))));
  app.post("/v1/runs/:runId/recover", (context) => runResponse(context, recoverResultSchema, async () => {
    const id = runId(context);
    await runBody(context.req.raw, emptyRunBodySchema);
    const result = await runService().recover(id);
    if (result.run_id !== id) throw new RunServiceError("invalid_bridge_response");
    return result;
  }, 202));
  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError(() => new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  return app;
}
