import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createPool } from "../../server/auth-store";
import { prepareTestAuth } from "../prepare-auth";
import { login, workspacePath, artifactPath } from "./auth-helper";

const origin = "http://127.0.0.1:3210";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function sessionId(page: Page) {
  const cookie = (await page.context().cookies()).find((value) => value.name === "ax_auth_3210");
  expect(cookie).toBeDefined();
  const value: unknown = JSON.parse(Buffer.from(decodeURIComponent(cookie!.value), "base64").toString());
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return value as string;
}
async function beginCallback(page: Page) {
  await page.goto(`${origin}/login`);
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  const begin = await page.request.post(`${origin}/login`, { headers: { origin }, form: { csrf }, maxRedirects: 0 });
  expect(begin.status()).toBe(303);
  const authorize = new URL(begin.headers().location!);
  const authorized = await page.request.post(`${authorize.origin}/authorize`, { form: Object.fromEntries([...authorize.searchParams, ["user", "alice"]]), maxRedirects: 0 });
  expect(authorized.status()).toBe(303);
  return new URL(authorized.headers().location!);
}

test("anonymous access and forged login are rejected without exposing private pages", async ({ page }) => {
  for (const path of ["/", "/tasks", "/connection", "/account", "/runs/ax-run-0123456789abcdef", "/runs/ax-run-0123456789abcdef/artifact"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe(`/login?returnTo=${encodeURIComponent(path === "/connection" ? "/workspaces" : path)}`);
    expect(response.headers()["cache-control"]).toBe("no-store");
  }
  await page.goto("/login");
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  expect((await page.request.post("/login", { headers: { origin: "http://attacker.example" }, form: { csrf } })).status()).toBe(400);
  expect((await page.request.post("/login", { form: { csrf } })).status()).toBe(403);
  expect((await page.request.post("/login", { headers: { origin }, form: { csrf: "wrong" } })).status()).toBe(403);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("normal login keeps tokens server-side, rotates sessions and logout revokes a copied cookie", async ({ page, browser }) => {
  await login(page);
  const first = await page.context().storageState();
  const firstId = await sessionId(page);
  const cookie = (await page.context().cookies()).find((value) => value.name === "ax_auth_3210")!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("ax_auth_");
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key !== "react-router-scroll-positions")) }))).toEqual({ local: {}, session: {} });
  const requests: string[] = [];
  page.on("request", (request) => { requests.push(request.url()); expect(request.headers()["x-ax-access-token"]).toBeUndefined(); });
  await page.goto("/account");
  expect(await page.content()).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await login(page);
  expect(await sessionId(page)).not.toBe(firstId);
  const old = await browser.newContext({ storageState: first });
  try { expect((await old.request.get(`${origin}/account`, { maxRedirects: 0 })).headers().location).toBe("/login?returnTo=%2Faccount&expired=1"); }
  finally { await old.close(); }
  const copied = await page.context().storageState();
  await page.goto("/account");
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/login`);
  expect((await page.context().cookies()).some((value) => value.name === "ax_auth_3210")).toBe(false);
  const replay = await browser.newContext({ storageState: copied });
  try { expect((await replay.request.get(`${origin}/account`, { maxRedirects: 0 })).headers().location).toBe("/login?returnTo=%2Faccount&expired=1"); }
  finally { await replay.close(); }
  expect(requests.filter((url) => new URL(url).port === "3211")).toEqual([]);
  const logoutRequests = requests.map((url) => new URL(url)).filter((url) => url.origin === "http://127.0.0.1:3212" && url.pathname === "/logout");
  expect(logoutRequests).toHaveLength(1);
  expect(Object.fromEntries(logoutRequests[0]!.searchParams)).toEqual({ client_id: "ax-web", post_logout_redirect_uri: `${origin}/login` });
  expect(requests.join("\n")).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
});

test("two users cannot list, read, continue, download or recover each other's conversation", async ({ page, browser }) => {
  await login(page, "alice");
  await page.goto(workspacePath(page, "/"));
  const text = `Alice専用の会話 ${randomUUID()}`;
  await page.getByLabel("メッセージ", { exact: true }).fill(text);
  await page.getByLabel("会話の外部送信とモデル利用料金を確認しました").check();
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByLabel("エージェントの返答")).toHaveCount(1, { timeout: 15000 });
  const conversationUrl = page.url();
  const id = new URL(conversationUrl).searchParams.get("conversation")!;
  const runPath = await page.getByRole("link", { name: "実行の詳細", exact: true }).getAttribute("href");
  const runId = new URL(runPath!, origin).pathname.split("/").at(-1)!;
  const second = await browser.newContext();
  try {
    const bob = await second.newPage();
    await login(bob, "bob");
    await expect(bob.getByRole("link", { name: text, exact: false })).toHaveCount(0);
    await bob.goto(conversationUrl);
    await expect(bob.getByLabel("あなたのメッセージ")).toHaveCount(0);
    expect(await bob.content()).not.toContain(text);
    const csrf = await bob.locator('input[name="csrf"]').inputValue();
    for (const path of [new URL(runPath!, origin).href, artifactPath(runPath!)]) {
      const denied = await bob.request.get(path);
      expect(denied.status()).toBe(404);
      expect(await denied.text()).not.toContain(text);
    }
    const recover = await bob.request.post(`${origin}${runPath}`, { headers: { origin }, form: { csrf, intent: "recover" } });
    expect(recover.status()).toBe(404);
    const continued = await bob.request.post(`${conversationUrl}&index`, { headers: { origin }, form: { csrf, id, key: randomUUID(), parent_run_id: runId, text: "他人の会話へ送信", allow_model: "yes" } });
    expect(continued.status()).toBe(404);
    await bob.goto(workspacePath(bob, "/tasks"));
    await expect(bob.getByRole("link", { name: runId, exact: false })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(1);
  } finally { await second.close(); }
});

test("local logout remains revoked when the identity provider logout page is unavailable", async ({ page, browser }) => {
  await login(page);
  const copied = await page.context().storageState();
  await page.route("http://127.0.0.1:3212/logout**", (route) => route.fulfill({ status: 503, body: "Identity provider unavailable" }));
  await page.goto("/account");
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByText("Identity provider unavailable", { exact: true })).toBeVisible();
  expect((await page.context().cookies()).some((value) => value.name === "ax_auth_3210")).toBe(false);
  const replay = await browser.newContext({ storageState: copied });
  try { expect((await replay.request.get(`${origin}/account`, { maxRedirects: 0 })).headers().location).toBe("/login?returnTo=%2Faccount&expired=1"); }
  finally { await replay.close(); }
});

test("callback requires the starting browser and rejects duplicate parameters and replay", async ({ page, browser }) => {
  const callback = await beginCallback(page);
  const flowCookies = await page.context().storageState();
  const outsider = await browser.newContext();
  try {
    const denied = await outsider.request.get(callback.href, { maxRedirects: 0 });
    expect(denied.headers().location).toBe("/login?error=1");
    expect((await outsider.cookies()).some((value) => value.name === "ax_auth_3210")).toBe(false);
  } finally { await outsider.close(); }
  const duplicate = new URL(callback);
  duplicate.searchParams.append("state", duplicate.searchParams.get("state")!);
  expect((await page.request.get(duplicate.href, { maxRedirects: 0 })).headers().location).toBe("/login?error=1");
  await page.context().addCookies(flowCookies.cookies);
  const accepted = await page.request.get(callback.href, { maxRedirects: 0 });
  expect(accepted.headers().location).toBe("/workspaces");
  expect(accepted.headers()["referrer-policy"]).toBe("no-referrer");
  await sessionId(page);
  const replay = await browser.newContext({ storageState: flowCookies });
  try {
    const denied = await replay.request.get(callback.href, { maxRedirects: 0 });
    expect(denied.headers().location).toBe("/login?error=1");
    expect((await replay.cookies()).some((value) => value.name === "ax_auth_3210")).toBe(false);
  } finally { await replay.close(); }
});

test("expired flows, expired sessions and disabled accounts fail closed", async ({ page }) => {
  const config = prepareTestAuth();
  const pool = createPool(config);
  try {
    const callback = await beginCallback(page);
    await pool.query("UPDATE login_flows SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [hash(callback.searchParams.get("state")!)]);
    expect((await page.request.get(callback.href, { maxRedirects: 0 })).headers().location).toBe("/login?error=1");
    await login(page);
    const id = await sessionId(page);
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id_hash=$1", [hash(id)]);
    await page.goto("/account");
    await expect(page).toHaveURL(`${origin}/login?returnTo=%2Faccount&expired=1`);
    await login(page, "bob");
    const owner = (await pool.query("SELECT user_id FROM identities WHERE issuer=$1 AND subject='bob'", [config.issuer])).rows[0].user_id;
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [owner]);
    try {
      await page.goto("/account");
      await expect(page).toHaveURL(`${origin}/login?returnTo=%2Faccount&expired=1`);
      await page.getByRole("button", { name: "ログインへ進む" }).click();
      await page.getByRole("button", { name: "Bobでログイン" }).click();
      await expect(page).toHaveURL(`${origin}/login?error=1`);
    } finally { await pool.query("UPDATE users SET status='active' WHERE id=$1", [owner]); }
  } finally { await pool.end(); }
});

test("passkey registration starts a protected OIDC flow with the requested action", async ({ page }) => {
  await login(page);
  await page.goto("/account");
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  const rejected = await page.request.post("/account", { headers: { origin }, form: { csrf: "wrong", intent: "passkey" }, maxRedirects: 0 });
  expect(rejected.status()).toBe(403);
  const requested = await page.request.post("/account", { headers: { origin }, form: { csrf, intent: "passkey" }, maxRedirects: 0 });
  expect(requested.status()).toBe(303);
  const destination = new URL(requested.headers().location!);
  expect(destination.origin).toBe("http://127.0.0.1:3212");
  expect(destination.searchParams.get("kc_action")).toBe("webauthn-register-passwordless");
  expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
});
