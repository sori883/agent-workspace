import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { parsePort } from "./server/config.ts";

const port = parsePort(process.env.WEB_PORT, 3100);
const allowedHost = `127.0.0.1:${port}`;
export default defineConfig({
  plugins: [{
    name: "local-request-boundary",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.headers.host !== allowedHost) { response.writeHead(403).end("Forbidden host"); return; }
        next();
      });
      server.httpServer?.prependListener("upgrade", (request, socket) => {
        if (request.headers.host !== allowedHost || request.headers.origin !== `http://${allowedHost}`) socket.destroy();
      });
    },
  }, reactRouter()],
  resolve: { tsconfigPaths: true },
  server: { host: "127.0.0.1", port, strictPort: true, cors: false },
});
