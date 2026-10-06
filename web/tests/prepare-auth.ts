import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthConfig, type AuthConfig } from "../server/auth-config";

export const testConfigPath = resolve(fileURLToPath(new URL("../../ax-local/.state/auth-test/app.json", import.meta.url)));

export function prepareTestAuth(): AuthConfig {
  const path = process.env.AUTH_CONFIG_FILE ?? testConfigPath;
  process.env.AUTH_CONFIG_FILE = path;
  if (!existsSync(path)) {
    const local = !process.env.TEST_DATABASE_PASSWORD;
    if (local) {
      const query = (sql: string) => execFileSync("docker", ["exec", "-i", "ax-local-postgres", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      try {
        const owner = query("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='app_auth_test';");
        if (!owner) query("CREATE DATABASE app_auth_test OWNER ax_app; REVOKE ALL ON DATABASE app_auth_test FROM PUBLIC;");
        else if (owner !== "ax_app") throw new Error();
      } catch { throw new Error("Dedicated authentication test database could not be prepared"); }
    }
    const secrets = fileURLToPath(new URL("../../ax-local/.state/postgres/secrets/", import.meta.url));
    const config: AuthConfig = {
      issuer: "http://127.0.0.1:3212", clientId: "ax-web", audience: "ax-api",
      clientSecret: randomBytes(32).toString("base64url"), encryptionKey: randomBytes(32).toString("base64url"),
      database: {
        host: process.env.TEST_DATABASE_HOST ?? "localhost", port: Number(process.env.TEST_DATABASE_PORT ?? "55432"),
        database: "app_auth_test", user: "ax_app",
        password: local ? readFileSync(resolve(secrets, "app.password"), "utf8").trim() : process.env.TEST_DATABASE_PASSWORD!,
        caPath: local ? resolve(secrets, "ca.crt") : null,
      },
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  }
  const config = readAuthConfig();
  if (config.database.database !== "app_auth_test") throw new Error("Authentication tests require the dedicated app_auth_test database");
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareTestAuth();
  process.stdout.write("Dedicated authentication test configuration prepared\n");
}
