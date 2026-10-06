import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

export async function startOidcFixture(clientSecret: string, port = 0) {
  const keys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture-rsa", alg: "RS256", use: "sig" };
  const codes = new Map<string, { subject: string; nonce: string; challenge: string; redirectUri: string }>();
  let issuer = "";
  let unavailable = false;
  let exchanges = 0;
  const accessToken = (subject = "alice", claims: JWTPayload = {}) => new SignJWT({
    iss: issuer, sub: subject, aud: "ax-api", azp: "ax-web", typ: "Bearer",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 1800, ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(keys.privateKey);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, issuer);
      if (unavailable) { response.writeHead(503).end("Identity provider unavailable"); return; }
      const json = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value)); };
      if (url.pathname === "/.well-known/openid-configuration") {
        json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`, response_types_supported: ["code"], subject_types_supported: ["public"],
          grant_types_supported: ["authorization_code"], id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"], code_challenge_methods_supported: ["S256"] }); return;
      }
      if (url.pathname === "/jwks") { json({ keys: [jwk] }); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (url.pathname === "/authorize") {
        const params = request.method === "POST" ? body : url.searchParams;
        const redirectUri = new URL(params.get("redirect_uri") ?? "about:blank");
        if (params.get("client_id") !== "ax-web" || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
            redirectUri.hostname !== "127.0.0.1" || redirectUri.pathname !== "/auth/callback" || !params.get("nonce") || !params.get("state")) { json({ error: "invalid_request" }, 400); return; }
        if (request.method !== "POST") {
          const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
          const fields = [...params].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("");
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html><html lang="ja"><title>テスト用ログイン</title><form method="post">${fields}<button name="user" value="alice">Aliceでログイン</button><button name="user" value="bob">Bobでログイン</button></form></html>`); return;
        }
        const subject = params.get("user");
        if (subject !== "alice" && subject !== "bob") { json({ error: "access_denied" }, 400); return; }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { subject, nonce: params.get("nonce")!, challenge: params.get("code_challenge")!, redirectUri: redirectUri.href });
        redirectUri.searchParams.set("code", code);
        redirectUri.searchParams.set("state", params.get("state")!);
        response.writeHead(303, { location: redirectUri.href, "Cache-Control": "no-store" }).end(); return;
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const basic = request.headers.authorization?.startsWith("Basic ") ? Buffer.from(request.headers.authorization.slice(6), "base64").toString() : null;
        if (basic !== `ax-web:${clientSecret}` && (body.get("client_id") !== "ax-web" || body.get("client_secret") !== clientSecret)) { json({ error: "invalid_client" }, 401); return; }
        const code = body.get("code") ?? "";
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== entry.redirectUri ||
            createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== entry.challenge) { json({ error: "invalid_grant" }, 400); return; }
        exchanges++;
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ iss: issuer, sub: entry.subject, aud: "ax-web", iat: now, exp: now + 1800, nonce: entry.nonce,
          email: `${entry.subject}@example.test` }).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).sign(keys.privateKey);
        json({ access_token: await accessToken(entry.subject), token_type: "Bearer", expires_in: 1800, id_token: idToken }); return;
      }
      if (url.pathname === "/logout") {
        const destination = new URL(url.searchParams.get("post_logout_redirect_uri") ?? "about:blank");
        if (destination.hostname !== "127.0.0.1" || destination.pathname !== "/login" || url.searchParams.get("client_id") !== "ax-web" || url.searchParams.has("id_token_hint") || url.searchParams.has("access_token")) { json({ error: "invalid_request" }, 400); return; }
        response.writeHead(303, { location: destination.href }).end(); return;
      }
      json({ error: "not_found" }, 404);
    } catch { response.writeHead(500).end("Fixture request failed"); }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer, accessToken, keys,
    setUnavailable(value: boolean) { unavailable = value; },
    get exchanges() { return exchanges; },
    async authorize(authorizationUrl: string, user = "alice") {
      const params = new URL(authorizationUrl).searchParams;
      const response = await fetch(`${issuer}/authorize`, { method: "POST", body: new URLSearchParams([...params, ["user", user]]), redirect: "manual" });
      if (response.status !== 303 || !response.headers.get("location")) throw new Error("Fixture authorization failed");
      return new URL(response.headers.get("location")!);
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
