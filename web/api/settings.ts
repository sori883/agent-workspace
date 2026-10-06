import { z } from "zod";
import { validateIssuer } from "../shared/access-token";
import { validateApiConfig } from "./config";

const applicationSchema = z.object({
  apiOrigin: z.url(), apiToken: z.string().min(32),
  identity: z.object({ issuer: z.url(), clientId: z.literal("ax-web"), audience: z.literal("ax-api") }).strict(),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  databaseSchema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).default("public"),
}).strict();
const schema = applicationSchema.extend({
  database: z.object({
    host: z.string().min(1), port: z.number().int().min(1).max(65535), database: z.string().min(1),
    user: z.string().min(1), password: z.string().min(1), ca: z.string().min(1).nullable(),
  }).strict(),
}).strict();
export type ApiApplicationSettings = z.infer<typeof applicationSchema>;
export type ApiSettings = z.infer<typeof schema>;

export function parseApiApplicationSettings(input: unknown): ApiApplicationSettings {
  try {
    const settings = applicationSchema.parse(input);
    validateApiConfig(settings);
    validateIssuer(settings.identity.issuer);
    return settings;
  } catch { throw new Error("API settings are unavailable or invalid."); }
}

export function parseApiSettings(input: unknown): ApiSettings {
  try {
    const settings = schema.parse(input);
    validateApiConfig(settings);
    validateIssuer(settings.identity.issuer);
    if (!settings.database.ca && !["127.0.0.1", "localhost", "::1"].includes(settings.database.host)) throw new Error();
    return settings;
  } catch { throw new Error("API settings are unavailable or invalid."); }
}
