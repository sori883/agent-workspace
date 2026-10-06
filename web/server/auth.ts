import { readAuthConfig } from "./auth-config";
import { AuthStore, createPool, AuthenticationError } from "./auth-store";
import { IdentityProvider } from "./oidc";

let runtime: { store: AuthStore; idp: IdentityProvider } | undefined;
export function authRuntime() {
  if (!runtime) {
    const config = readAuthConfig();
    runtime = { store: new AuthStore(createPool(config), config.encryptionKey), idp: new IdentityProvider(config) };
  }
  return runtime;
}
export type Authenticate = (token: string) => Promise<string>;
export const authenticate: Authenticate = async (token) => {
  if (!token) throw new AuthenticationError("missing_token");
  const { store, idp } = authRuntime();
  const claims = await idp.accessClaims(token);
  return store.resolve(claims.iss, claims.sub);
};
