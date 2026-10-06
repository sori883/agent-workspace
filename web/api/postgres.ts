import type { ApiSettings } from "./settings";

export function postgresOptions(settings: ApiSettings) {
  const { ca, ...database } = settings.database;
  return { ...database, ssl: ca ? { ca, rejectUnauthorized: true } : false as const, options: `-c search_path=${settings.databaseSchema}`,
    connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000 };
}
