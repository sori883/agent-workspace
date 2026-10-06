import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  issuer: z.url(),
  clientId: z.literal("ax-web"),
  clientSecret: z.string().min(32),
  audience: z.literal("ax-api"),
  encryptionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  database: z.object({
    host: z.string().min(1), port: z.number().int().min(1).max(65535),
    database: z.string().min(1), user: z.string().min(1), password: z.string().min(1),
    caPath: z.string().min(1).nullable(),
  }).strict(),
}).strict();
export type AuthConfig = z.infer<typeof schema>;
export function isLoopback(hostname: string) { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname); }
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  try {
    const path = env.AUTH_CONFIG_FILE ?? resolve("../ax-local/.state/auth/app.json");
    const config = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    const issuer = new URL(config.issuer);
    if (issuer.username || issuer.password || issuer.search || issuer.hash ||
        (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && isLoopback(issuer.hostname))) ||
        (!config.database.caPath && !isLoopback(config.database.host))) throw new Error();
    return config;
  } catch {
    throw new Error("Authentication configuration is unavailable. Set AUTH_CONFIG_FILE or prepare ax-local/keycloak first.");
  }
}
