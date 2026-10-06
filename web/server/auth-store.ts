import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { z } from "zod";
import type { AuthConfig } from "./auth-config";
import { AuthenticationError } from "../shared/authentication";

export { AuthenticationError } from "../shared/authentication";
export const opaqueId = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokensSchema = z.object({ accessToken: z.string().min(1), idToken: z.string().min(1) }).strict();
const flowSchema = z.object({ state: z.string(), nonce: z.string(), verifier: z.string(), redirectUri: z.url(), returnTo: z.string().max(4096).optional() }).strict();
export type Tokens = z.infer<typeof tokensSchema>;
export type LoginFlow = z.infer<typeof flowSchema>;
export type AuthSession = Tokens & { userId: string; displayName: string; verifiedEmail: string | null; expiresAt: number };

export function createPool(config: AuthConfig) {
  const { caPath, ...database } = config.database;
  const pool = new pg.Pool({ ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false,
    max: 5, connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 3000,
    idleTimeoutMillis: 5000, allowExitOnIdle: true,
  });
  pool.on("error", () => { console.error("Authentication database connection interrupted."); });
  return pool;
}

export class AuthStore {
  constructor(readonly pool: pg.Pool, private readonly key: string) {}
  private seal(value: unknown, purpose: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.key, "base64url"), iv);
    cipher.setAAD(Buffer.from(purpose));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  private open(value: string, purpose: string): unknown {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.key, "base64url"), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
  async createFlow(browserId: string, flow: LoginFlow) {
    await this.pool.query("DELETE FROM login_flows WHERE expires_at <= now()");
    await this.pool.query("INSERT INTO login_flows(state_hash,browser_hash,payload,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
      [hash(flow.state), hash(browserId), this.seal(flow, `flow:${hash(flow.state)}`)]);
  }
  async consumeFlow(browserId: string, state: string): Promise<LoginFlow> {
    const result = await this.pool.query("DELETE FROM login_flows WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING payload", [hash(state), hash(browserId)]);
    if (result.rowCount !== 1) throw new AuthenticationError("invalid_login_flow");
    return flowSchema.parse(this.open(result.rows[0].payload, `flow:${hash(state)}`));
  }
  async identify(issuer: string, subject: string, displayName: string, verifiedEmail: string | null = null): Promise<string> {
    const email = verifiedEmail === null ? null : z.email().max(254).parse(verifiedEmail).toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([issuer, subject])]);
      const existing = await client.query("SELECT u.id,u.status FROM identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2", [issuer, subject]);
      let userId: string;
      if (existing.rowCount) {
        if (existing.rows[0].status !== "active") throw new AuthenticationError("user_disabled");
        userId = existing.rows[0].id;
        await client.query("UPDATE users SET display_name=$2,verified_email=$3 WHERE id=$1", [userId, displayName, email]);
      } else {
        userId = randomUUID();
        await client.query("INSERT INTO users(id,status,display_name,verified_email) VALUES($1,'active',$2,$3)", [userId, displayName, email]);
        await client.query("INSERT INTO identities(issuer,subject,user_id) VALUES($1,$2,$3)", [issuer, subject, userId]);
      }
      await client.query("COMMIT");
      return userId;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async resolve(issuer: string, subject: string): Promise<string> {
    const result = await this.pool.query("SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2 AND u.status='active'", [issuer, subject]);
    if (result.rowCount !== 1) throw new AuthenticationError("unknown_identity");
    return result.rows[0].id;
  }
  async createSession(userId: string, tokens: Tokens, tokenExpiry: number): Promise<string> {
    const id = opaqueId();
    const expiry = Math.min(Date.now() + 30 * 60_000, tokenExpiry);
    if (expiry <= Date.now()) throw new AuthenticationError("expired_token");
    await this.pool.query("DELETE FROM sessions WHERE expires_at<=now()");
    const result = await this.pool.query("INSERT INTO sessions(id_hash,user_id,tokens,expires_at) SELECT $1,id,$3,$4 FROM users WHERE id=$2 AND status='active'",
      [hash(id), userId, this.seal(tokens, `session:${hash(id)}`), new Date(expiry)]);
    if (result.rowCount !== 1) throw new AuthenticationError("user_disabled");
    return id;
  }
  async session(id: string): Promise<AuthSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const result = await this.pool.query("SELECT s.tokens,s.expires_at,u.id,u.display_name,u.verified_email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now() AND u.status='active'", [hash(id)]);
    if (result.rowCount !== 1) return null;
    return { ...tokensSchema.parse(this.open(result.rows[0].tokens, `session:${hash(id)}`)), userId: result.rows[0].id,
      displayName: result.rows[0].display_name, verifiedEmail: result.rows[0].verified_email, expiresAt: result.rows[0].expires_at.getTime() };
  }
  async revoke(id: string) { await this.pool.query("DELETE FROM sessions WHERE id_hash=$1", [hash(id)]); }
}
