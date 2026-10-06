import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { checkInputSchema } from "../shared/contracts";
import { readLimitedText } from "../shared/http";
import type { LocalConfig } from "../server/config";

export function createApi(config: LocalConfig, onCheck: (id: string) => void = () => {}) {
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
  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError(() => new Response(JSON.stringify({ error: "internal_error" }), {
    status: 500,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  return app;
}
