import { validateApiConfig } from "../api/config.ts";

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Port must be an integer.");
  const port = Number(value);
  if (port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const webPort = parsePort(env.WEB_PORT, 3100);
  const apiPort = parsePort(env.API_PORT, 3101);
  if (webPort === apiPort) throw new Error("Web and API ports must differ.");
  const apiToken = env.INTERNAL_API_TOKEN;
  const sessionSecret = env.LOCAL_SESSION_SECRET;
  if (!apiToken || !sessionSecret || apiToken.length < 32 || sessionSecret.length < 32) {
    throw new Error("Start both services with npm run dev or npm start.");
  }
  const apiOrigin = env.API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;
  validateApiConfig({ apiToken, apiOrigin });
  return {
    webPort,
    apiPort,
    webOrigin: `http://127.0.0.1:${webPort}`,
    apiOrigin,
    sessionCookieName: `ax_local_session_${webPort}`,
    apiToken,
    sessionSecret,
  };
}
export type LocalConfig = ReturnType<typeof readConfig>;
