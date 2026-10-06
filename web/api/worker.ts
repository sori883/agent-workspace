import pg from "pg";
import { createRuntime } from "./runtime";
import { parseApiApplicationSettings } from "./settings";

export default {
  async fetch(request: Request, env: { API_SETTINGS: string; POSTGRES: { connectionString: string } }): Promise<Response> {
    let client: pg.Client | undefined;
    let connected: Promise<unknown> | undefined;
    let failed = false;
    try {
      const settings = parseApiApplicationSettings(JSON.parse(env.API_SETTINGS));
      const app = createRuntime(settings, {
        async query(sql, values) {
          if (failed) throw new Error("Database connection interrupted.");
          if (!client) {
            client = new pg.Client({ connectionString: env.POSTGRES.connectionString, options: `-c search_path=${settings.databaseSchema}`,
              connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000 });
            client.on("error", () => { failed = true; });
          }
          connected ??= client.connect();
          await connected;
          if (failed) throw new Error("Database connection interrupted.");
          return client.query(sql, values);
        },
      });
      return await app.fetch(request);
    } catch {
      return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    } finally { if (client) await client.end().catch(() => {}); }
  },
};
