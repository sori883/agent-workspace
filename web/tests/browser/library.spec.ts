import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";

test("skill registration survives a lost receipt, publishes immutable versions, and an agent selects a pinned skill", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/library"));
  await page.getByRole("link", { name: "スキルを登録", exact: true }).click();
  let lost = false, csrf = "", id = "", version = "";
  await page.route("**/library/transfer?*", async route => {
    const input = route.request().postDataJSON(); csrf = input.csrf;
    if (input.intent === "create" && !lost) {
      lost = true;
      const accepted = await route.fetch(); id = (await accepted.json()).definition.id;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "api_unavailable" }) });
    } else if (input.intent === "publish") {
      const result = await route.fetch(); version = (await result.json()).version.id;
      await route.fulfill({ response: result });
    } else await route.continue();
  });
  await page.getByLabel("スキル名", { exact: false }).fill("browser-sales-summary");
  await page.getByLabel("スキルの説明", { exact: true }).fill("CSVの部門別売上を集計します。");
  await page.getByLabel("指示", { exact: false }).fill("部門別に売上を合計してください。");
  await page.getByRole("button", { name: "補助ファイルを追加", exact: true }).click();
  await page.getByLabel("ファイル名", { exact: false }).fill("references/columns.md");
  await page.getByLabel("内容", { exact: true }).fill("部門,売上\n開発,1000");
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作を確認してください" })).toBeVisible();
  await page.getByRole("button", { name: "同じ内容で再確認する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/library/${id}\\?`));
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  const firstVersion = version;
  await page.getByLabel("指示", { exact: false }).fill("列名を確かめてから、部門別に売上を合計してください。");
  await expect(page.getByRole("button", { name: "保存した下書きを公開", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "下書きを保存", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第2版を公開しました。");
  await page.getByLabel("スキル名", { exact: false }).fill("unpublished-draft-name");
  await page.getByRole("button", { name: "下書きを保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("下書きを保存しました");
  const endpoint = workspacePath(page, "/library/transfer");
  const previous = await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: { intent: "version", id: firstVersion, csrf } });
  expect(previous.status()).toBe(200);
  expect((await previous.json()).content.instructions).toBe("部門別に売上を合計してください。");
  for (const [body, expected] of [[{ intent: "get", id, csrf: "wrong" }, 403], [{ intent: "get", id, csrf, owner_user_id: "forged" }, 400]] as const) {
    expect((await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: body })).status()).toBe(expected);
  }
  await page.getByRole("link", { name: "スキル・エージェント一覧へ", exact: true }).click();
  await expect(page.getByRole("link", { name: "unpublished-draft-name", exact: true })).toHaveCount(1);
  await page.getByLabel("種類", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "絞り込む", exact: true }).click();
  await expect(page.getByRole("link", { name: "unpublished-draft-name", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "エージェントを登録", exact: true }).click();
  await page.getByLabel("エージェント名", { exact: false }).fill("月次レポート担当");
  await page.getByLabel("指示", { exact: false }).fill("選んだスキルを使って月次レポートを作ってください。");
  await page.getByRole("button", { name: "スキルを探す", exact: true }).click();
  await expect(page.getByRole("button", { name: /^選ぶ\s*：unpublished-draft-name$/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^選ぶ\s*：browser-sales-summary$/ }).click();
  await page.getByLabel("Pythonでファイルを集計・作成する", { exact: true }).check();
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  await page.reload();
  await expect(page.locator(".library-selected")).toBeVisible();
  await expect(page.locator(".library-selected")).toContainText("browser-sales-summary（第2版）");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/registry-editor-mobile.png", fullPage: true });
});

test("copy explicitly changes sharing scope, and archive preserves published history", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/library/new?kind=skill"));
  await page.getByLabel("スキル名", { exact: false }).fill("copy-source");
  await page.getByLabel("指示", { exact: false }).fill("集計の手順です。");
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  await page.getByRole("link", { name: "コピーして新規登録", exact: true }).click();
  await page.getByLabel("ワークスペースで共有する", { exact: true }).check();
  await page.getByLabel("スキル名", { exact: false }).fill("copy-shared");
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  await page.getByLabel("この設定の利用を終了する", { exact: true }).check();
  await page.getByRole("button", { name: "利用終了にする", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("この設定の利用を終了しました。");
  await expect(page.getByRole("heading", { name: "保存されている内容", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "スキル・エージェント一覧へ", exact: true }).click();
  await expect(page.getByRole("link", { name: "copy-shared", exact: true })).toHaveCount(0);
  await page.getByLabel("利用終了した設定も表示", { exact: true }).check();
  await page.getByRole("button", { name: "絞り込む", exact: true }).click();
  await expect(page.getByRole("link", { name: "copy-shared", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "copy-source", exact: true })).toHaveCount(1);
});
