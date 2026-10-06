import { serve } from "@hono/node-server";
import pg from "pg";
import { parsePort } from "../server/config";
import { readNodeApiSettings } from "../server/api-settings";
import { createRuntime } from "./runtime";
import { postgresOptions } from "./postgres";

const settings = readNodeApiSettings();
const pool = new pg.Pool({ ...postgresOptions(settings), max: 5, idleTimeoutMillis: 5000, allowExitOnIdle: true });
pool.on("error", () => console.error("API database connection interrupted."));
const app = createRuntime(settings, pool);
const port = parsePort(process.env.API_PORT, 3101);
const hostname = process.env.API_HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, hostname, port }, () => {
  console.info(`API ready on ${hostname}:${port} (pid ${process.pid})`);
});
server.on("error", () => {
  console.error("API could not start. Check whether its port is in use.");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => { void pool.end().then(() => process.exit(0)); }));
}
