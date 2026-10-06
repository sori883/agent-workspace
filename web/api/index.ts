import { serve } from "@hono/node-server";
import { readConfig } from "../server/config";
import { createApi } from "./app";
import { pythonRunService } from "./run-service";
import { pythonChatService } from "./chat-service";

const config = readConfig();
const app = createApi(config, (requestId) => console.info(JSON.stringify({ event: "connection-check", requestId })), pythonRunService(), pythonChatService());
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.apiPort }, () => {
  console.info(`API ready on 127.0.0.1:${config.apiPort} (pid ${process.pid})`);
});
server.on("error", () => {
  console.error("API could not start. Check whether its port is in use.");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
