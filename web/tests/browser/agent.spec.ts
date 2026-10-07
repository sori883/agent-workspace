import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";

test("preview asks once, resumes after reload and downloads a private result", async ({ page, browser }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await expect(page.getByText("模擬モデルで対話の流れを試せます", { exact: true })).toBeVisible();
  const draft = await page.locator('input[name="key"]').inputValue();
  await page.reload();
  expect(await page.locator('input[name="key"]').inputValue()).toBe(draft);
  await page.getByLabel("依頼内容", { exact: true }).fill("ブラウザから短い文書を作りたい");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  const url = page.url();
  await page.reload();
  await page.getByLabel("質問への回答", { exact: true }).fill("<script>alert(1)</script>\n会議の目的を整理してください。");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(2);
  await expect(page.getByLabel("プレビューの返答").last()).toContainText("<script>alert(1)</script>");
  const href = await page.getByRole("link", { name: "成果物をダウンロード" }).getAttribute("href");
  expect((await page.request.get(href!)).status()).toBe(200);
  const other = await browser.newContext();
  try { const bob = await other.newPage(); await login(bob, "bob"); await bob.goto(url); await expect(bob.getByLabel("あなたのメッセージ")).toHaveCount(0); expect((await bob.request.get(href!)).status()).toBe(404); } finally { await other.close(); }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("accepted request with a lost receipt is recovered without a duplicate; logout stops waiting work", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await page.getByLabel("依頼内容", { exact: true }).fill("対話の受付結果テスト");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(1);
  const url = page.url();
  await page.goto("/account");
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3210/login");
  await login(page);
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveCount(0);
});

test("input survives late hydration and an expired form; stopping errors stay visible", async ({ page }) => {
  await login(page);
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/assets/*.js", async route => { await ready; await route.continue(); });
  await page.goto(workspacePath(page, "/agent"), { waitUntil: "commit" });
  const field = page.getByLabel("依頼内容", { exact: true });
  await field.fill("読み込み中に書いた依頼");
  release();
  await page.waitForLoadState("networkidle");
  await expect(field).toHaveValue("読み込み中に書いた依頼");
  await page.locator('input[name="csrf"]').evaluate((input: HTMLInputElement) => { input.value = "invalid"; });
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toBeVisible();
  await expect(field).toHaveValue("読み込み中に書いた依頼");
  await page.reload();
  await field.fill("停止失敗テスト");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "この対話を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toBeVisible();
  await expect(page.getByText("受付結果を確認できませんでした。同じ内容のまま再送するか、対話を更新してください。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この対話を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
});

test("failed stop acknowledgement keeps logout visibly incomplete until retry", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await page.getByLabel("依頼内容", { exact: true }).fill("停止失敗テスト");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  await page.goto("/account");
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ログアウトできませんでした" })).toBeVisible();
  await expect(page.getByText(/ログイン状態はまだ有効です/)).toBeVisible();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3210/login");
});
