import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { generateKeyPair, SignJWT } from "jose";
import { readAuthConfig, type AuthConfig } from "../server/auth-config";
import { AuthStore, AuthenticationError, createPool, opaqueId } from "../server/auth-store";
import { migrateAuth } from "../server/auth-migrate";
import { IdentityProvider } from "../server/oidc";
import { prepareTestAuth } from "./prepare-auth";
import { startOidcFixture } from "./helpers/oidc-fixture";
import { loginDestination } from "../server/login-destination";

let settings: AuthConfig;
let pool: pg.Pool;
let admin: pg.Pool;
let store: AuthStore;
let fixture: Awaited<ReturnType<typeof startOidcFixture>>;
let idp: IdentityProvider;
const schema = `auth_test_${randomBytes(8).toString("hex")}`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const denied = (error: unknown) => error instanceof AuthenticationError;
const flow = () => ({ state: opaqueId(), nonce: opaqueId(), verifier: opaqueId(), redirectUri: "http://127.0.0.1:3210/auth/callback" });

before(async () => {
  settings = prepareTestAuth();
  admin = createPool(settings);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const { caPath, ...database } = settings.database;
  pool = new pg.Pool({ ...database, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false,
    options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 3000 });
  await migrateAuth(pool);
  store = new AuthStore(pool, settings.encryptionKey);
  fixture = await startOidcFixture(settings.clientSecret);
  idp = new IdentityProvider({ ...settings, issuer: fixture.issuer });
});

after(async () => {
  await fixture?.close();
  await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

test("authentication config rejects insecure endpoints and malformed secrets without disclosing contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "ax-auth-config-"));
  const path = join(directory, "config.json");
  try {
    for (const invalid of [
      { ...settings, issuer: "http://remote.example/realm" },
      { ...settings, issuer: "https://user:PRIVATE@issuer.example/realm" },
      { ...settings, issuer: "https://issuer.example/realm?secret=PRIVATE" },
      { ...settings, encryptionKey: "PRIVATE" },
      { ...settings, clientSecret: "PRIVATE" },
      { ...settings, database: { ...settings.database, host: "db.example", caPath: null } },
      { ...settings, disableAuthentication: true },
    ]) {
      writeFileSync(path, JSON.stringify(invalid), { mode: 0o600 });
      assert.throws(() => readAuthConfig({ AUTH_CONFIG_FILE: path }), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
    }
    writeFileSync(path, JSON.stringify(settings), { mode: 0o600 });
    assert.deepEqual(readAuthConfig({ AUTH_CONFIG_FILE: path }), settings);
  } finally { rmSync(directory, { recursive: true }); }
});

test("schema migration is idempotent and refuses unknown versions", async () => {
  await migrateAuth(pool);
  assert.deepEqual((await pool.query("SELECT version FROM auth_migrations ORDER BY version")).rows, [{ version: 1 }, { version: 2 }]);
  await pool.query("INSERT INTO auth_migrations VALUES(3)");
  try { await assert.rejects(migrateAuth(pool), /Unsupported authentication schema version/); }
  finally { await pool.query("DELETE FROM auth_migrations WHERE version=3"); }
});

test("verified email is normalized, cleared on unverified login and never merges identities", async () => {
  const a = await store.identify(fixture.issuer, "email-a", "User A", "Shared@Example.test");
  const b = await store.identify(fixture.issuer, "email-b", "User B", "Shared@Example.test");
  assert.notEqual(a, b);
  assert.equal((await pool.query("SELECT verified_email FROM users WHERE id=$1", [a])).rows[0].verified_email, "shared@example.test");
  await store.identify(fixture.issuer, "email-a", "User A", null);
  assert.equal((await pool.query("SELECT verified_email FROM users WHERE id=$1", [a])).rows[0].verified_email, null);
  assert.equal((await pool.query("SELECT verified_email FROM users WHERE id=$1", [b])).rows[0].verified_email, "shared@example.test");
});

test("login return destinations retain local invitations and reject external or malformed redirects", () => {
  const target = "/join?token=sample_invitation";
  assert.equal(loginDestination(target), target);
  assert.equal(loginDestination("/tasks?workspace=local&draft=test"), "/tasks?workspace=local&draft=test");
  for (const value of [null, "https://attacker.example", "//attacker.example", "/\\attacker.example", "/%2f%2fattacker.example", "/join\nLocation:bad", "/unknown", "/join?x=" + "a".repeat(4096)]) assert.equal(loginDestination(value), "/workspaces");
});

test("issuer and subject uniquely identify users even with concurrent logins or matching email", async () => {
  const issuer = fixture.issuer;
  const ids = await Promise.all(Array.from({ length: 8 }, () => store.identify(issuer, "identity-race", "same@example.test")));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await store.resolve(issuer, "identity-race"), ids[0]);
  const differentSubject = await store.identify(issuer, "different-subject", "same@example.test");
  const differentIssuer = await store.identify(`${issuer}/other`, "identity-race", "same@example.test");
  assert.equal(new Set([ids[0], differentSubject, differentIssuer]).size, 3);
  await assert.rejects(store.resolve(issuer, "never-linked"), denied);
});

test("login flows are encrypted, browser-bound, expiring and consumed exactly once", async () => {
  const browser = opaqueId();
  const first = flow();
  await store.createFlow(browser, first);
  const row = (await pool.query("SELECT * FROM login_flows WHERE state_hash=$1", [hash(first.state)])).rows[0];
  assert.equal(row.browser_hash, hash(browser));
  assert.ok(!JSON.stringify(row).includes(first.verifier));
  await assert.rejects(store.consumeFlow(opaqueId(), first.state), denied);
  const consumed = await Promise.allSettled([store.consumeFlow(browser, first.state), store.consumeFlow(browser, first.state)]);
  assert.equal(consumed.filter((value) => value.status === "fulfilled").length, 1);
  assert.deepEqual(consumed.find((value) => value.status === "fulfilled")?.value, first);
  const expired = flow();
  await store.createFlow(browser, expired);
  await pool.query("UPDATE login_flows SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [hash(expired.state)]);
  await assert.rejects(store.consumeFlow(browser, expired.state), denied);
});

test("opaque sessions hide tokens, respect token expiry, survive store recreation, revoke and disabled users", async () => {
  const userId = await store.identify(fixture.issuer, "session-owner", "owner@example.test");
  const tokens = { accessToken: "PRIVATE_ACCESS_TOKEN", idToken: "PRIVATE_ID_TOKEN" };
  const id = await store.createSession(userId, tokens, Date.now() + 60_000);
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  const row = (await pool.query("SELECT * FROM sessions WHERE id_hash=$1", [hash(id)])).rows[0];
  assert.ok(!JSON.stringify(row).includes(id));
  assert.ok(!JSON.stringify(row).includes(tokens.accessToken));
  const session = await new AuthStore(pool, settings.encryptionKey).session(id);
  assert.equal(session?.userId, userId);
  assert.equal(session?.accessToken, tokens.accessToken);
  assert.ok(session!.expiresAt <= Date.now() + 60_000);
  assert.equal(await store.session("forged"), null);
  await store.revoke(id);
  assert.equal(await store.session(id), null);
  const second = await store.createSession(userId, tokens, Date.now() + 3_600_000);
  assert.ok((await store.session(second))!.expiresAt <= Date.now() + 1_800_000);
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id_hash=$1", [hash(second)]);
  assert.equal(await store.session(second), null);
  await assert.rejects(store.createSession(userId, tokens, Date.now() - 1), denied);
  const third = await store.createSession(userId, tokens, Date.now() + 60_000);
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [userId]);
  assert.equal(await store.session(third), null);
  await assert.rejects(store.resolve(fixture.issuer, "session-owner"), denied);
  await assert.rejects(store.identify(fixture.issuer, "session-owner", "changed@example.test"), denied);
});

test("token ciphertext cannot be transplanted and a DB failure never becomes an anonymous session", async () => {
  const userId = await store.identify(fixture.issuer, "cipher-owner", "cipher@example.test");
  const tokens = { accessToken: "cipher-access", idToken: "cipher-id" };
  const first = await store.createSession(userId, tokens, Date.now() + 60_000);
  const second = await store.createSession(userId, tokens, Date.now() + 60_000);
  await pool.query("UPDATE sessions SET tokens=(SELECT tokens FROM sessions WHERE id_hash=$1) WHERE id_hash=$2", [hash(first), hash(second)]);
  await assert.rejects(store.session(second));
  await assert.rejects(new AuthStore(pool, randomBytes(32).toString("base64url")).session(first));
  const unavailable = createPool(settings);
  await unavailable.end();
  await assert.rejects(new AuthStore(unavailable, settings.encryptionKey).session(first));
});

test("JWT verification rejects incorrect issuer, audience, authorized client, token type, expiry, subject and signature", async () => {
  assert.equal((await idp.accessClaims(await fixture.accessToken())).sub, "alice");
  for (const claims of [{ iss: `${fixture.issuer}/wrong` }, { aud: "other-api" }, { azp: "other-client" }, { typ: "ID" },
    { exp: Math.floor(Date.now() / 1000) - 1 }, { sub: "" }, { exp: undefined }, { iat: undefined }, { nbf: Math.floor(Date.now() / 1000) + 60 }]) {
    await assert.rejects(idp.accessClaims(await fixture.accessToken("alice", claims)), denied);
  }
  const other = await generateKeyPair("RS256");
  const wrongKey = await new SignJWT({ iss: fixture.issuer, sub: "alice", aud: "ax-api", azp: "ax-web", typ: "Bearer", iat: 1, exp: 4_000_000_000 })
    .setProtectedHeader({ alg: "RS256", kid: "fixture-rsa" }).sign(other.privateKey);
  await assert.rejects(idp.accessClaims(wrongKey), denied);
  const wrongAlgorithm = await new SignJWT({ sub: "alice" }).setProtectedHeader({ alg: "HS256", kid: "fixture-rsa" }).sign(randomBytes(32));
  await assert.rejects(idp.accessClaims(wrongAlgorithm), denied);
  await assert.rejects(idp.accessClaims("x".repeat(16_385)), denied);
});

test("authorization code flow validates PKCE, state, nonce, callback and one-use codes through HTTP", async () => {
  const good = flow();
  const url = await idp.authorization(good);
  assert.equal(new URL(url).searchParams.get("code_challenge_method"), "S256");
  const callback = await fixture.authorize(url, "bob");
  const identity = await idp.exchange(callback, good);
  assert.equal(identity.subject, "bob");
  assert.equal(identity.issuer, fixture.issuer);
  assert.equal(identity.verifiedEmail, "bob@example.test");
  await assert.rejects(idp.exchange(callback, good));
  for (const change of ["verifier", "nonce", "state"] as const) {
    const original = flow();
    const callback = await fixture.authorize(await idp.authorization(original));
    await assert.rejects(idp.exchange(callback, { ...original, [change]: opaqueId() }));
  }
  const wrongCallback = flow();
  const redirected = await fixture.authorize(await idp.authorization(wrongCallback));
  redirected.pathname = "/unexpected";
  await assert.rejects(idp.exchange(redirected, wrongCallback), denied);
});

test("unverified identity-provider email does not authorize an invitation address", async () => {
  fixture.setEmailVerified(false);
  try {
    const value = flow();
    const callback = await fixture.authorize(await idp.authorization(value));
    assert.equal((await idp.exchange(callback, value)).verifiedEmail, null);
  } finally { fixture.setEmailVerified(true); }
});

test("logout redirects with the client identity and return URI without exposing tokens", async () => {
  const destination = new URL(await idp.logout("http://127.0.0.1:3210/login"));
  assert.equal(destination.origin, fixture.issuer);
  assert.equal(destination.pathname, "/logout");
  assert.deepEqual(Object.fromEntries(destination.searchParams), {
    client_id: "ax-web", post_logout_redirect_uri: "http://127.0.0.1:3210/login",
  });
  assert.equal(destination.searchParams.has("id_token_hint"), false);
  assert.equal(destination.searchParams.has("access_token"), false);
  assert.doesNotMatch(destination.href, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});
