import * as oidc from "openid-client";
import { z } from "zod";
import { AccessTokenVerifier, type AccessClaims } from "../shared/access-token";
import type { AuthConfig } from "./auth-config";
import { AuthenticationError, type LoginFlow } from "./auth-store";

export class IdentityProvider {
  private configuration?: Promise<oidc.Configuration>;
  private readonly verifier: AccessTokenVerifier;
  constructor(private readonly settings: AuthConfig) { this.verifier = new AccessTokenVerifier(settings); }
  private async config() {
    this.configuration ??= oidc.discovery(new URL(this.settings.issuer), this.settings.clientId,
      { client_secret: this.settings.clientSecret, id_token_signed_response_alg: "RS256" }, undefined,
      { timeout: 3, execute: this.settings.issuer.startsWith("http:") ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] : [oidc.enableNonRepudiationChecks] });
    try { return await this.configuration; }
    catch (error) { this.configuration = undefined; throw error; }
  }
  async authorization(flow: LoginFlow, registerPasskey = false): Promise<string> {
    const config = await this.config();
    return oidc.buildAuthorizationUrl(config, { redirect_uri: flow.redirectUri, scope: "openid profile email", response_type: "code",
      state: flow.state, nonce: flow.nonce, code_challenge_method: "S256", code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      ...(registerPasskey ? { kc_action: "webauthn-register-passwordless" } : {}),
    }).href;
  }
  async exchange(url: URL, flow: LoginFlow) {
    if (url.origin + url.pathname !== flow.redirectUri) throw new AuthenticationError("invalid_callback");
    const tokens = await oidc.authorizationCodeGrant(await this.config(), url, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims || !tokens.id_token) throw new AuthenticationError("missing_id_token");
    const access = await this.accessClaims(tokens.access_token);
    if (access.sub !== claims.sub || access.iss !== claims.iss) throw new AuthenticationError("identity_mismatch");
    const email = z.email().max(254).safeParse(claims.email);
    return { tokens: { accessToken: tokens.access_token, idToken: tokens.id_token }, subject: claims.sub, issuer: claims.iss,
      verifiedEmail: claims.email_verified === true && email.success ? email.data.toLowerCase() : null,
      displayName: typeof claims.email === "string" ? claims.email : typeof claims.name === "string" ? claims.name : "利用者",
      expiresAt: access.exp! * 1000 };
  }
  async accessClaims(token: string): Promise<AccessClaims> { return this.verifier.verify(token); }
  async logout(redirectUri: string) {
    return oidc.buildEndSessionUrl(await this.config(), { post_logout_redirect_uri: redirectUri, client_id: this.settings.clientId }).href;
  }
}
