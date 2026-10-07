import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";

test("private file upload survives a lost chunk receipt, downloads identical bytes and denies another owner", async ({ page, browser }) => {
  await login(page); await page.goto(workspacePath(page, "/files"));
  let lost = false, csrf = "", fileId = "";
  await page.route("**/files/transfer?*", async route => {
    const input = route.request().postDataJSON(); csrf = input.csrf;
    if (input.id) fileId = input.id;
    if (input.intent === "put" && !lost) { lost = true; await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "api_unavailable" }) }); }
    else await route.continue();
  });
  const original = Buffer.from("部署,金額\r\n" + "開発,1200\r\n".repeat(7000));
  await page.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: "月次集計.csv", mimeType: "text/csv", buffer: original });
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("通信結果を確認できませんでした");
  await page.getByRole("button", { name: "続きを送信", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("月次集計.csvを保存しました。");
  await page.reload();
  await expect(page.getByRole("heading", { name: "月次集計.csv", exact: true })).toHaveCount(1);
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "月次集計.csvをダウンロード", exact: true }).click();
  const downloaded = await waiting;
  expect(downloaded.suggestedFilename()).toBe("月次集計.csv");
  expect(await readFile((await downloaded.path())!)).toEqual(original);
  const endpoint = workspacePath(page, "/files/transfer");
  const invalid = await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: { intent: "cancel", id: fileId, csrf: "invalid" } });
  expect(invalid.status()).toBe(403);
  const forged = await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: { intent: "get", id: fileId, csrf, owner_user_id: "forged" } });
  expect(forged.status()).toBe(400);
  const other = await browser.newContext();
  try {
    const bob = await other.newPage(); await login(bob, "bob"); await bob.goto(workspacePath(bob, "/files"));
    let bobCsrf = "";
    await bob.route("**/files/transfer?*", async route => { bobCsrf = route.request().postDataJSON().csrf; await route.continue(); });
    await bob.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: "本人.csv", mimeType: "text/csv", buffer: Buffer.from("x\n1\n") });
    await bob.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(bob.getByRole("status")).toHaveText("本人.csvを保存しました。");
    const denied = await bob.request.post(workspacePath(bob, "/files/transfer"), { headers: { origin: new URL(bob.url()).origin }, data: { intent: "read", id: fileId, index: 0, csrf: bobCsrf } });
    expect(denied.status()).toBe(404);
  } finally { await other.close(); }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("upload rejects empty and oversized files before sending; drafts can be explicitly cancelled", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/files"));
  let beginCount = 0;
  await page.route("**/files/transfer?*", async route => {
    const input = route.request().postDataJSON();
    if (input.intent === "begin") beginCount++;
    if (input.intent === "put") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "api_unavailable" }) });
    else await route.continue();
  });
  for (const buffer of [Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    await page.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: "無効.csv", mimeType: "text/csv", buffer });
    await page.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("形式とサイズを確認してください");
  }
  expect(beginCount).toBe(0);
  await page.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: "中断.csv", mimeType: "text/csv", buffer: Buffer.from("x\n1\n") });
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("通信結果を確認できませんでした");
  await page.reload();
  await page.getByRole("button", { name: "中断.csvの送信を取り消す", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("中断.csvの送信を取り消しました。");
  await expect(page.getByRole("button", { name: "中断.csvの送信を再開", exact: true })).toHaveCount(0);
  await page.getByText("退出したワークスペースに送信途中のファイルがある場合", { exact: true }).click();
  await page.getByRole("button", { name: "利用できなくなった未完了送信を取り消す", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("0件の未完了送信を取り消しました。");
});
