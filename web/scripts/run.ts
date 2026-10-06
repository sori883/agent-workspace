import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createCookie } from "react-router";
import { readConfig } from "../server/config";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") throw new Error("Choose dev or start.");
const cwd = fileURLToPath(new URL("../", import.meta.url));
const env = {
  ...process.env,
  INTERNAL_API_TOKEN: process.env.INTERNAL_API_TOKEN ?? (process.env.API_ORIGIN ? "" : randomBytes(32).toString("base64url")),
  LOCAL_SESSION_SECRET: process.env.LOCAL_SESSION_SECRET ?? randomBytes(32).toString("base64url"),
};
const config = readConfig(env);
const children: ChildProcess[] = [];
let stopping = false;
let ready = false;

function signalChildren(signal: NodeJS.Signals) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  signalChildren("SIGTERM");
  setTimeout(() => { signalChildren("SIGKILL"); process.exit(code); }, 1500);
}
function start(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd, env: { ...env, ...extraEnv }, stdio: "inherit", detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", () => { console.error("A local service could not start."); shutdown(1); });
  return child;
}
async function waitFor(url: string, child: ChildProcess | undefined, headers?: HeadersInit, isOwnResponse: (response: Response) => Promise<boolean> = async () => true) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (stopping || (child && (child.exitCode !== null || child.signalCode !== null))) throw new Error("A local service stopped during startup.");
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.ok && await isOwnResponse(response)) return;
    } catch {}
    await delay(200);
  }
  throw new Error("A local service did not become ready.");
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(0));

try {
  const api = process.env.API_ORIGIN ? undefined : start(["--import", "tsx", "api/index.ts"]);
  api?.on("exit", () => {
    if (stopping) return;
    if (!ready) shutdown(1);
    else console.error("API stopped. The web page remains available and will show a connection error. Restart the command to reconnect.");
  });
  await waitFor(`${config.apiOrigin}/v1/status`, api, { Authorization: `Bearer ${config.apiToken}` });
  const bin = realpathSync(`${cwd}/node_modules/.bin/react-router`);
  const web = start(mode === "dev" ? [bin, "dev"] : ["--import", "tsx", "server/serve.ts"], {
    HOST: "127.0.0.1", PORT: String(config.webPort), NODE_ENV: mode === "dev" ? "development" : "production",
  });
  web.on("exit", (code) => { if (!stopping) shutdown(code ?? 1); });
  const cookie = createCookie(config.sessionCookieName, { secrets: [config.sessionSecret] });
  await waitFor(`${config.webOrigin}/login`, web, undefined, async (response) => {
    const session = await cookie.parse(response.headers.get("set-cookie"));
    return typeof session?.csrf === "string";
  });
  ready = true;
  console.info(`AX workspace ready: ${config.webOrigin}`);
} catch (error) {
  if (!stopping) console.error(error instanceof Error ? error.message : "Local startup failed.");
  shutdown(1);
}
