import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";

test("preview asks once, resumes after reload and downloads a private result", async ({ page, browser }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
  await expect(page.getByText("依頼に合わせた返答と成果物を受け取れます", { exact: true })).toBeVisible();
  const draft = await page.locator('input[name="key"]').inputValue();
  await page.reload();
  expect(await page.locator('input[name="key"]').inputValue()).toBe(draft);
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
  await page.getByLabel("依頼内容", { exact: true }).fill("ブラウザから短い文書を作りたい");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  const url = page.url();
  await page.reload();
  await page.getByLabel("質問への回答", { exact: true }).fill("<script>alert(1)</script>\n会議の目的を整理してください。");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(2);
  await expect(page.getByLabel("エージェントの返答").last()).toContainText("<script>alert(1)</script>");
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
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
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
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
  release();
  await page.waitForLoadState("networkidle");
  await expect(field).toHaveValue("読み込み中に書いた依頼");
  await page.locator('input[name="csrf"]').evaluate((input: HTMLInputElement) => { input.value = "invalid"; });
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toBeVisible();
  await expect(field).toHaveValue("読み込み中に書いた依頼");
  await page.reload();
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
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
  await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
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


test("real-model consent and mode survive an invalid form and remain fixed after start", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await expect(page.getByRole("radio", { name: "実モデルで依頼を進める", exact: true })).toBeChecked();
  const consent = page.getByRole("checkbox", { name: "会話の外部送信とモデル利用料金を確認しました", exact: true });
  await expect(consent).not.toBeChecked();
  await page.getByLabel("依頼内容", { exact: true }).fill("実モデル同意のテスト");
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByText("実モデルを使う場合は、会話の外部送信と利用料金を確認してください。", { exact: true })).toBeVisible();
  await consent.check();
  await page.locator('input[name="csrf"]').evaluate((input: HTMLInputElement) => { input.value = "invalid"; });
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toBeVisible();
  await expect(consent).toBeChecked();
  await expect(page.getByRole("radio", { name: "実モデルで依頼を進める", exact: true })).toBeChecked();
  await page.reload();
  await page.getByLabel("依頼内容", { exact: true }).fill("実モデル同意のテスト");
  await consent.check();
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByText(/gemini-3.1-flash-lite · この対話の料金の目安：0.00005500 USD/)).toBeVisible();
  await expect(page.getByText("送信すると、会話をGeminiへ送り、利用料金が発生します。", { exact: true })).toBeVisible();
  await page.getByLabel("質問への回答", { exact: true }).fill("チームへのお知らせを短くしてください。");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/この対話の料金の目安：0.00011000 USD/)).toBeVisible();
  await page.getByRole("link", { name: "実行の詳細", exact: true }).last().click();
  await expect(page.getByText("模擬モデルの記録です。外部モデルへの送信と課金はありません。", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0.00005500 USD", { exact: true })).toBeVisible();
});


test("without JavaScript preview needs no model consent and paid start is rejected without it", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await login(page);
    await page.goto(workspacePath(page, "/agent"));
    await page.getByLabel("依頼内容", { exact: true }).fill("JavaScriptなしの対話確認");
    await page.getByRole("button", { name: "対話を始める", exact: true }).click();
    await expect(page.getByText("実モデルを使う場合は、会話の外部送信と利用料金を確認してください。", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "模擬応答で操作を試す（無料）", exact: true }).check();
    await page.getByRole("button", { name: "対話を始める", exact: true }).click();
    await expect(page).toHaveURL(/root=/);
    await expect(async () => { await page.reload(); await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible(); }).toPass({ timeout: 15000 });
    await expect(page.getByText("模擬応答 · 利用料金なし", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "この対話を停止する", exact: true }).click();
    await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  } finally { await context.close(); }
});


test("lost paid acceptance preserves one model root and one billed segment after reload", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/agent"));
  await page.getByLabel("依頼内容", { exact: true }).fill("対話の受付結果テスト");
  await page.getByRole("checkbox", { name: "会話の外部送信とモデル利用料金を確認しました", exact: true }).check();
  await page.getByRole("button", { name: "対話を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています" })).toBeVisible({ timeout: 15000 });
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(1);
  await expect(page.getByText(/この対話の料金の目安：0.00005500 USD/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await page.getByRole("button", { name: "この対話を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
});
