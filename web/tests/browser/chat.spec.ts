import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function start(page: import("@playwright/test").Page, text: string) {
  await page.goto("/");
  await page.getByLabel("メッセージ", { exact: true }).fill(text);
  await page.getByLabel("会話の外部送信とモデル利用料金を確認しました").check();
  await page.getByRole("button", { name: "送信する", exact: true }).click();
}

test("a saved conversation continues after reload through the BFF and HTTP API", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page, "合言葉は「青い灯台」です。覚えてください。");
  await expect(page.getByLabel("エージェントの返答")).toContainText("合言葉を覚えました", { timeout: 15000 });
  const url = page.url();
  await page.reload();
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(1);
  await page.getByLabel("メッセージ", { exact: true }).fill("合言葉は何でしたか？");
  await page.getByLabel("メッセージ", { exact: true }).press("Control+Enter");
  await expect(page.getByLabel("エージェントの返答").last()).toContainText("青い灯台", { timeout: 15000 });
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(2);
  await expect(page.getByLabel("メッセージ", { exact: true })).toHaveValue("");
  expect(page.url()).toBe(url);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("link", { name: "新しいチャット", exact: false }).first().click();
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(0);
  await page.getByRole("link", { name: "合言葉は「青い灯台」です。覚えてください。", exact: false }).click();
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("mobile, consent, UTF-8 limits, keyboard and Japanese composition", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
  const field = page.getByLabel("メッセージ", { exact: true });
  await field.fill("<script>alert(1)</script>\n日本語で質問です。");
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(0);
  await page.getByLabel("会話の外部送信とモデル利用料金を確認しました").check();
  await field.fill("あ".repeat(700));
  await expect(page.getByRole("button", { name: "送信する", exact: true })).toBeDisabled();
  await field.fill("<script>alert(1)</script>\n日本語で質問です。");
  await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(0);
  await field.press("End");
  await field.press("Enter");
  await expect(field).toHaveValue("<script>alert(1)</script>\n日本語で質問です。\n");
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByLabel("エージェントの返答")).toContainText("<script>alert(1)</script>", { timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("uncertain acceptance retains the original key and retry does not add a turn", async ({ page }) => {
  await start(page, "受付結果テスト");
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toBeVisible();
  await expect(page.getByLabel("エージェントの返答")).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByLabel("送信内容を確認", { exact: true })).toHaveValue("受付結果テスト");
  await expect(page.getByLabel("送信内容を確認", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "同じ内容を再送" }).click();
  await expect(page.getByRole("heading", { name: "送信を確認してください" })).toHaveCount(0);
  await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(1);
  await expect(page.getByLabel("メッセージ", { exact: true })).toHaveValue("");
});

test("native form and manual refresh keep a conversation usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3210/");
    const key = await page.locator('input[name="key"]').inputValue();
    await page.reload();
    expect(await page.locator('input[name="key"]').inputValue()).toBe(key);
    await page.getByLabel("メッセージ", { exact: true }).fill("JavaScriptなしの会話\n2行目です。");
    await page.getByLabel("会話の外部送信とモデル利用料金を確認しました").check();
    await page.getByRole("button", { name: "送信する", exact: true }).click();
    await expect.poll(async () => { await page.getByRole("link", { name: "会話を更新", exact: true }).click(); return await page.getByLabel("エージェントの返答").count(); }).toBe(1);
    await expect(page.getByLabel("あなたのメッセージ")).toContainText("JavaScriptなしの会話\n2行目です。");
    expect(await page.locator('input[name="key"]').inputValue()).not.toBe(key);
    await page.getByLabel("メッセージ", { exact: true }).fill("続きです。");
    await page.getByRole("button", { name: "送信する", exact: true }).click();
    await expect(page.getByLabel("あなたのメッセージ")).toHaveCount(2);
  } finally { await context.close(); }
});

test("long conversation keeps history and offers a new chat", async ({ page }) => {
  await start(page, "会話の上限テスト");
  await expect(page.getByRole("heading", { name: "新しいチャットに続けましょう" })).toBeVisible();
  await expect(page.getByLabel("エージェントの返答")).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByLabel("メッセージ", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "新しいチャットを始める", exact: true }).click();
  await expect(page.getByLabel("メッセージ", { exact: true })).toBeVisible();
});
