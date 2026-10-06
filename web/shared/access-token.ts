import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthenticationError, type Authenticate } from "./authentication";
import { readLimitedText } from "./http";

export type IdentitySettings = { issuer: string; clientId: string; audience: string };
export type AccessClaims = JWTPayload & { sub: string; iss: string; exp: number };

export function validateIssuer(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("Invalid identity issuer.");
  return url;
}

export class AccessTokenVerifier {
  private keys?: Promise<ReturnType<typeof createRemoteJWKSet>>;
  constructor(private readonly settings: IdentitySettings) { validateIssuer(settings.issuer); }
  private async discover() {
    const url = new URL(`${this.settings.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Identity discovery unavailable.");
    const metadata = JSON.parse(await readLimitedText(response, 65_536));
    if (metadata.issuer !== this.settings.issuer || typeof metadata.jwks_uri !== "string") throw new Error("Invalid identity metadata.");
    const jwks = validateIssuer(metadata.jwks_uri);
    if (jwks.origin !== new URL(this.settings.issuer).origin) throw new Error("Invalid identity key endpoint.");
    return createRemoteJWKSet(jwks, { timeoutDuration: 3000, cooldownDuration: 30_000, cacheMaxAge: 300_000 });
  }
  async verify(token: string): Promise<AccessClaims> {
    if (!token || token.length > 16_384) throw new AuthenticationError("invalid_token");
    this.keys ??= this.discover();
    let keys: ReturnType<typeof createRemoteJWKSet>;
    try { keys = await this.keys; }
    catch (error) { this.keys = undefined; throw error; }
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: this.settings.issuer, audience: this.settings.audience,
        algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "iss", "aud", "azp", "typ"], clockTolerance: 0, maxTokenAge: "30m" });
      if (payload.azp !== this.settings.clientId || payload.typ !== "Bearer" || typeof payload.sub !== "string" || !payload.sub || typeof payload.exp !== "number" || typeof payload.iss !== "string") throw new Error();
      return payload as AccessClaims;
    } catch { throw new AuthenticationError("invalid_token"); }
  }
}

export function createAuthenticator(settings: IdentitySettings, resolveIdentity: (issuer: string, subject: string) => Promise<string>): Authenticate {
  const verifier = new AccessTokenVerifier(settings);
  return async (token) => {
    const claims = await verifier.verify(token);
    return resolveIdentity(claims.iss, claims.sub);
  };
}
