import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRequestHandler, type ServerBuild } from "react-router";
import { readConfig } from "./config";

const config = readConfig();
const build: ServerBuild = await import(pathToFileURL(resolve("build/server/index.js")).href);
const handle = createRequestHandler(build, "production");
const app = new Hono();
app.use("*", async (context, next) => {
  if (context.req.header("host") !== new URL(config.webOrigin).host) return context.text("Forbidden host", 403);
  await next();
});
app.use("/assets/*", serveStatic({ root: "./build/client", onFound(_path, context) { context.header("Cache-Control", "public, max-age=31536000, immutable"); } }));
app.use("*", serveStatic({ root: "./build/client" }));
app.all("*", (context) => handle(context.req.raw));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.webPort });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close());
