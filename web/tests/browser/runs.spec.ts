import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("submit through the BFF and HTTP API, poll, preserve idempotency and download an escaped artifact", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const draftUrl = page.url();
  const key = await page.locator('input[name="key"]').inputValue();
  await page.reload();
  expect(await page.locator('input[name="key"]').inputValue()).toBe(key);
  await page.getByLabel("作業の指示", { exact: false }).fill("テキストを保存");
  const content = "ブラウザからAXへ <script>alert(1)</script>\n保存するテキスト";
  await page.getByLabel("作業用テキスト", { exact: true }).fill(content);
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\/ax-run-[0-9a-f]{16}$/);
  const detailUrl = page.url();
  await expect(page.getByRole("heading", { name: "完了", exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("artifact-content")).toHaveText(content);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  const downloaded = await page.request.get(`${detailUrl}/artifact`);
  expect(downloaded.headers()["content-disposition"]).toBe('attachment; filename="result.txt"');
  expect(await downloaded.text()).toBe(content);
  const form = { key, csrf, mode: "offline", instruction: "テキストを保存", input_text: content, output_name: "result.txt" };
  const repeat = await page.request.post(`${draftUrl}&index`, { headers: { origin: "http://127.0.0.1:3210" }, form });
  expect(repeat.url()).toBe(detailUrl);
  const changed = await page.request.post(`${draftUrl}&index`, { headers: { origin: "http://127.0.0.1:3210" }, form: { ...form, instruction: "内容を変更" } });
  expect(changed.status()).toBe(409);
  expect(await changed.text()).toContain("この送信はすでに受け付けています");
  await page.goto(draftUrl);
  await expect(page.getByRole("link", { name: new URL(detailUrl).pathname.split("/").pop()!, exact: false })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("model consent, UTF-8 limits, CSRF, keyboard and mobile form", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  await page.getByLabel("モデルを使う", { exact: false }).check();
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "受付を確認できませんでした" })).toBeVisible();
  await expect(page).not.toHaveURL(/\/runs\//);
  await page.getByLabel("動作テスト", { exact: false }).check();
  await page.getByLabel("作業の指示", { exact: false }).fill("あ".repeat(700));
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await expect(page.locator("#instruction")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#instruction")).toHaveValue("あ".repeat(700));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const key = await page.locator('input[name="key"]').inputValue();
  const forged = await page.request.post(`${page.url()}&index`, { headers: { origin: "http://127.0.0.1:3210" }, form: { key, csrf: "wrong", mode: "offline", instruction: "x", input_text: "", output_name: "result.txt" } });
  expect(forged.status()).toBe(403);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("a native form can submit and manually refresh without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3210/");
    const draftUrl = page.url();
    const content = "JavaScriptなしの作業\n2行目";
    await page.getByLabel("作業用テキスト", { exact: true }).fill(content);
    await page.getByRole("button", { name: "実行する", exact: true }).click();
    await expect(page).toHaveURL(/\/runs\/ax-run-/);
    await expect.poll(async () => { await page.getByRole("link", { name: "状態を更新する" }).click(); return await page.locator("#run-status-title").textContent(); }).toBe("完了");
    const detailUrl = page.url();
    await expect(page.getByTestId("artifact-content")).toHaveText(content);
    const hydrated = await browser.newContext({ storageState: await context.storageState() });
    try {
      const retry = await hydrated.newPage();
      await retry.goto(draftUrl);
      await retry.getByLabel("作業用テキスト", { exact: true }).fill(content);
      await retry.getByRole("button", { name: "実行する", exact: true }).click();
      await expect(retry).toHaveURL(detailUrl);
    } finally { await hydrated.close(); }
  } finally { await context.close(); }
});

test("native history refresh fetches the page and preserves the draft key", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3210/");
    const key = new URL(page.url()).searchParams.get("draft");
    let requests = 0;
    page.on("request", (request) => { if (request.isNavigationRequest() && request.method() === "GET") requests += 1; });
    await page.getByRole("button", { name: "一覧を更新", exact: true }).or(page.getByRole("link", { name: "一覧を更新", exact: true })).click();
    await expect.poll(() => requests).toBe(1);
    expect(new URL(page.url()).searchParams.get("draft")).toBe(key);
  } finally { await context.close(); }
});
