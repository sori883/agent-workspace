import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("SSR, a real API round trip, keyboard navigation and accessibility", async ({ page, request }) => {
  const html = await request.get("/");
  expect(await html.text()).toContain("接続を確かめる");
  expect(html.headers()["cache-control"]).toBe("no-store");
  const origins = new Set<string>();
  const errors: string[] = [];
  page.on("request", (req) => origins.add(new URL(req.url()).origin));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  await page.getByLabel("確認用のメッセージ").fill("ブラウザからの確認 <script>alert(1)</script>");
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.getByRole("heading", { name: "メッセージが届きました" })).toBeVisible();
  await expect(page.locator(".returned-message")).toHaveText("ブラウザからの確認 <script>alert(1)</script>");
  await expect(page.locator(".result")).toBeFocused();
  expect([...origins]).toEqual(["http://127.0.0.1:3210"]);
  expect(errors).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("invalid input is explained and forged submissions are rejected", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("確認用のメッセージ").fill("   ");
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.locator("#message-error")).toHaveText("メッセージを1〜200文字で入力してください。");
  await expect(page.getByLabel("確認用のメッセージ")).toHaveValue("   ");
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  const url = "http://127.0.0.1:3210/?index";
  const forged = await page.request.post(url, { headers: { origin: "http://127.0.0.1:3210" }, form: { csrf: "wrong", message: "x" } });
  expect(forged.status()).toBe(403);
  const missingOrigin = await page.request.post(url, { form: { csrf, message: "x" } });
  expect(missingOrigin.status()).toBe(403);
  expect((await request.get("http://127.0.0.1:3211/v1/status")).status()).toBe(401);
  expect((await request.get(url, { headers: { host: "attacker.example:3210" } })).status()).toBe(403);
});

test("forms work without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:3210/");
  await page.getByLabel("確認用のメッセージ").fill("JavaScriptなしで確認");
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.locator(".returned-message")).toHaveText("JavaScriptなしで確認");
  await expect(page.getByLabel("確認用のメッセージ")).toHaveValue("JavaScriptなしで確認");
  await page.getByLabel("確認用のメッセージ").fill("セッションが切れても残す入力");
  await context.clearCookies();
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.getByRole("heading", { name: "送信を完了できませんでした" })).toBeVisible();
  await expect(page.getByLabel("確認用のメッセージ")).toHaveValue("セッションが切れても残す入力");
  await context.close();
});

test("input typed before hydration survives and is submitted unchanged", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/*.js", async (route) => { await loaded; await route.continue(); });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await page.getByLabel("確認用のメッセージ").fill("読み込み中の入力");
  } finally {
    release();
  }
  await expect(page.locator("#message-count")).toHaveText("8 / 200");
  await expect(page.getByLabel("確認用のメッセージ")).toHaveValue("読み込み中の入力");
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.locator(".returned-message")).toHaveText("読み込み中の入力");
  expect(errors).toEqual([]);
});

test("the 320px layout has no horizontal scrolling and retains usable controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const button = await page.getByRole("button", { name: "送信して接続を確認" }).boundingBox();
  expect(button!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel("確認用のメッセージ").fill("狭い画面から確認");
  await page.getByRole("button", { name: "送信して接続を確認" }).click();
  await expect(page.locator(".returned-message")).toHaveText("狭い画面から確認");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});
