import { accessTokenFingerprint } from "../shared/access-token";
import { readAuthConfig } from "./auth-config";
import { AuthStore, createPool, AuthenticationError } from "./auth-store";
import { IdentityProvider } from "./oidc";
import type { Authenticate } from "../shared/authentication";

let runtime: { store: AuthStore; idp: IdentityProvider } | undefined;
export function authRuntime() {
  if (!runtime) {
    const config = readAuthConfig();
    runtime = { store: new AuthStore(createPool(config), config.encryptionKey), idp: new IdentityProvider(config) };
  }
  return runtime;
}
export type { Authenticate } from "../shared/authentication";
export const authenticate: Authenticate = async (token) => {
  if (!token) throw new AuthenticationError("missing_token");
  const { store, idp } = authRuntime();
  const claims = await idp.accessClaims(token);
  return { ownerUserId: await store.resolve(claims.iss, claims.sub), expiresAt: claims.exp, tokenFingerprint: await accessTokenFingerprint(token) };
};
