import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";
import { builtinCatalog } from "../../app/lib/builtin-catalog";

test("legacy agents remain readable while all creation, copying, editing and selection entries are retired", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/library/new?kind=skill"));
  await page.getByLabel("スキル名", { exact: false }).fill("legacy-agent-helper");
  await page.getByLabel("指示", { exact: false }).fill("過去の設定を確認するためのスキルです。");
  const saved = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/library/transfer"));
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  const csrf = (await saved).postDataJSON().csrf;
  await expect(page.getByRole("heading", { name: "legacy-agent-helper", exact: true })).toBeVisible();
  const endpoint = workspacePath(page, "/library/transfer"), origin = new URL(page.url()).origin;
  const created = await page.request.post(endpoint, { headers: { origin }, data: { csrf, intent: "create", input: { key: crypto.randomUUID(), kind: "agent", visibility: "personal", content: { name: "以前のエージェント", instructions: "以前の指示を保存しています。", skill_version_ids: [], allowed_tools: [] } } } });
  expect(created.status()).toBe(200);
  const definition = (await created.json()).definition;
  const published = await page.request.post(endpoint, { headers: { origin }, data: { csrf, intent: "publish", id: definition.id, input: { key: crypto.randomUUID(), expected_revision: definition.revision } } });
  expect(published.status()).toBe(200);
  const version = (await published.json()).version.id;
  await page.goto(workspacePath(page, `/library/${definition.id}`));
  await expect(page.getByRole("heading", { name: "保存されている内容", exact: true })).toBeVisible();
  await expect(page.getByText("以前の指示を保存しています。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(下書きを保存|保存した下書きを公開|利用終了にする)$/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /^(この版で依頼する|コピーして新規登録)$/ })).toHaveCount(0);
  await page.goto(workspacePath(page, `/workbench?agent=${version}`));
  await expect(page.getByText("エージェントの選択は終了しました。標準エージェントに依頼し、必要なスキルを指定してください。", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "標準エージェントで新しい依頼を開く", exact: true })).toBeVisible();
  await expect(page.getByLabel("依頼内容", { exact: true })).toHaveCount(0);
  for (const suffix of ["kind=agent", `copy=${definition.id}`]) {
    await page.goto(workspacePath(page, `/library/new?${suffix}`));
    await expect(page).toHaveURL(/\/library\?retired=agent/);
    await expect(page.getByRole("link", { name: "エージェントを登録", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "以前のエージェント", exact: true })).toHaveCount(0);
  }
});

test("built-in skills describe their automatic use and open a new request without executing it", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/library"));
  const builtins = page.getByRole("region", { name: "標準で使える機能", exact: true });
  await expect(builtins.getByRole("heading", { name: builtinCatalog.defaultAgent.name, exact: true })).toBeVisible();
  for (const skill of builtinCatalog.skills) {
    const card = builtins.getByRole("listitem").filter({ has: page.getByRole("heading", { name: skill.name, exact: true }) });
    await expect(card).toContainText(skill.description);
    await expect(card).toContainText(skill.when);
  }
  await expect(builtins).not.toContainText("brief-v1");
  await expect(builtins.getByRole("button")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-library-mobile.png", fullPage: true });
  let starts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start") starts++; });
  const workspace = new URL(page.url()).searchParams.get("workspace");
  await builtins.getByRole("link", { name: "標準エージェントに依頼する", exact: true }).click();
  await expect(page).toHaveURL(/\/workbench\?/);
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(workspace);
  expect(new URL(page.url()).searchParams.has("root")).toBe(false);
  expect(starts).toBe(0);
  await page.goto(workspacePath(page, "/library"));
  await page.getByRole("link", { name: /^このスキルを指定して依頼する\s*：CSV・Excelの集計$/ }).click();
  await expect(page.getByRole("list", { name: "指定したスキル", exact: true })).toContainText("CSV・Excelの集計");
  expect(starts).toBe(0);
});

test("skill registration survives a lost receipt, publishes immutable versions, and explicit requests retain the pinned skill", async ({ page }) => {
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
  await expect(page.getByRole("link", { name: "この版で依頼する", exact: true })).toHaveCount(0);
  await expect(page.getByText("下書きを保存したあと、公開すると依頼に使えます。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  const firstVersion = version;
  const editorUrl = page.url();
  await expect(page.getByRole("link", { name: "この版で依頼する", exact: true })).toHaveJSProperty("href", workspacePath(page, `/workbench?skill=${firstVersion}`));
  await page.getByRole("link", { name: "この版で依頼する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`skill=${firstVersion}`));
  await expect(page.getByRole("list", { name: "指定したスキル", exact: true })).toContainText(/browser-sales-summary.*自分だけ · 第1版/);
  await page.goto(editorUrl);
  await page.getByLabel("指示", { exact: false }).fill("列名を確かめてから、部門別に売上を合計してください。");
  await expect(page.getByRole("button", { name: "保存した下書きを公開", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "下書きを保存", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第2版を公開しました。");
  await page.goto(workspacePath(page, `/workbench?skill=${firstVersion}`));
  await expect(page.getByRole("list", { name: "指定したスキル", exact: true })).toContainText(/browser-sales-summary.*自分だけ · 第1版/);
  await expect(page.getByRole("list", { name: "指定したスキル", exact: true })).not.toContainText("第2版");
  await page.goto(editorUrl);
  await page.getByLabel("スキル名", { exact: false }).fill("unpublished-draft-name");
  await page.getByRole("button", { name: "下書きを保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("下書きを保存しました");
  const secondVersion = version;
  await expect(page.getByRole("region", { name: "公開した版を使う", exact: true })).toContainText("browser-sales-summary（第2版）");
  await expect(page.getByRole("link", { name: "この版で依頼する", exact: true })).toHaveJSProperty("href", workspacePath(page, `/workbench?skill=${secondVersion}`));
  await page.goto(workspacePath(page, `/workbench?skill=${firstVersion}`));
  const preview = page.waitForEvent("popup");
  await page.getByRole("list", { name: "指定したスキル", exact: true }).getByRole("link").click();
  const versionPage = await preview;
  await expect(versionPage).toHaveURL(new RegExp(`/library/${id}\\?version=${firstVersion}`));
  await expect(versionPage.getByRole("heading", { name: "browser-sales-summary（第1版）", exact: true })).toBeVisible();
  await expect(versionPage.locator(".library-content")).toContainText("部門別に売上を合計してください。");
  await expect(versionPage.locator("body")).not.toContainText("列名を確かめてから");
  await expect(versionPage.locator("body")).not.toContainText("unpublished-draft-name");
  await expect(versionPage.getByRole("button", { name: /^(下書きを保存|保存した下書きを公開)$/ })).toHaveCount(0);
  await expect(versionPage.getByRole("link", { name: "コピーして新規登録", exact: true })).toHaveCount(0);
  await versionPage.close();
  await page.goto(editorUrl);
  const endpoint = workspacePath(page, "/library/transfer");
  const previous = await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: { intent: "version", id: firstVersion, csrf } });
  expect(previous.status()).toBe(200);
  expect((await previous.json()).content.instructions).toBe("部門別に売上を合計してください。");
  for (const [body, expected] of [[{ intent: "get", id, csrf: "wrong" }, 403], [{ intent: "get", id, csrf, owner_user_id: "forged" }, 400]] as const) {
    expect((await page.request.post(endpoint, { headers: { origin: new URL(page.url()).origin }, data: body })).status()).toBe(expected);
  }
  await page.getByRole("link", { name: "スキル一覧へ", exact: true }).click();
  await expect(page.getByRole("link", { name: "unpublished-draft-name", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^この版で依頼する\s*：browser-sales-summary（第2版）$/ })).toHaveJSProperty("href", workspacePath(page, `/workbench?skill=${secondVersion}`));
  await expect(page.getByRole("link", { name: "エージェントを登録", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("種類", { exact: true })).toHaveCount(0);
  await page.goto(workspacePath(page, `/workbench?skill=${firstVersion}`));
  await page.getByLabel("依頼内容", { exact: true }).fill("公開した最初のスキルで依頼します。");
  const started = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  expect((await started).postDataJSON().input).toMatchObject({ mode: "preview", skill_version_ids: [firstVersion], builtin_skill_ids: [], input_file_ids: [] });
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await page.goto(editorUrl);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-library-editor-mobile.png", fullPage: true });

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
  const archivedUseUrl = await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href");
  await page.getByLabel("この設定の利用を終了する", { exact: true }).check();
  await page.getByRole("button", { name: "利用終了にする", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("この設定の利用を終了しました。");
  await expect(page.getByRole("heading", { name: "保存されている内容", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "この版で依頼する", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "スキル一覧へ", exact: true }).click();
  await expect(page.getByRole("link", { name: "copy-shared", exact: true })).toHaveCount(0);
  await page.getByLabel("利用終了した設定も表示", { exact: true }).check();
  await page.getByRole("button", { name: "絞り込む", exact: true }).click();
  await expect(page.getByRole("link", { name: "copy-shared", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "copy-source", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^この版で依頼する\s*：copy-shared（第1版）$/ })).toHaveCount(0);
  let starts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start") starts++; });
  await page.goto(archivedUseUrl!);
  await expect(page.getByRole("heading", { name: "依頼を表示できません", exact: true })).toBeVisible();
  await expect(page.getByText("この設定は利用を終了しています。", { exact: false })).toBeVisible();
  await expect(page.locator("#workbench-text")).toHaveCount(0);
  expect(starts).toBe(0);
});

test("selection URLs reject invalid kinds, ambiguous queries and private versions outside their owner and workspace", async ({ page, browser }) => {
  test.setTimeout(60000);
  await login(page);
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/workspaces`);
  await page.getByLabel("ワークスペース名", { exact: false }).fill("設定の利用権限を確認する会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[a-f0-9-]+$/);
  const workspace = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.goto(`${origin}/library/new?kind=skill&workspace=${workspace}`);
  await page.getByLabel("スキル名", { exact: false }).fill("owner-only-selection");
  await page.getByLabel("指示", { exact: false }).fill("本人だけの指示を公開版に固定します。");
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  const useUrl = new URL((await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href"))!, origin);
  const version = useUrl.searchParams.get("skill")!;
  let starts = 0;
  const trackStarts = (target: Page) => target.on("request", request => { if (request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start") starts++; });
  trackStarts(page);
  async function blocked(target: Page, url: string, badQuery = false, message = "この設定は見つからないか、閲覧できません。") {
    const response = await target.goto(url);
    expect(response?.status()).toBe(badQuery ? 400 : 200);
    if (!badQuery) {
      await expect(target.getByRole("heading", { name: "依頼を表示できません", exact: true })).toBeVisible();
      await expect(target.getByText(message, { exact: true })).toBeVisible();
    }
    await expect(target.locator("#workbench-text")).toHaveCount(0);
    await expect(target.getByRole("button", { name: /^(依頼を送る|操作を試す)$/ })).toHaveCount(0);
    await expect(target.locator("body")).not.toContainText("本人だけの指示を公開版に固定します。");
    expect(starts).toBe(0);
  }
  await blocked(page, `${origin}/workbench?workspace=${workspace}&agent=${version}`, false, "エージェントの選択は終了しました。標準エージェントに依頼し、必要なスキルを指定してください。");
  await blocked(page, `${useUrl}&agent=${version}`, true);
  await blocked(page, `${useUrl}&skill=${version}`, true);
  await blocked(page, `${useUrl}&builtin=general-v1`, true);
  await blocked(page, `${origin}/workbench?workspace=${workspace}&builtin=unknown`, true);
  await blocked(page, `${origin}/workbench?workspace=${workspace}&builtin=general-v1&builtin=general-v1`, true);

  await page.goto(`${origin}/workspaces`);
  await page.getByLabel("ワークスペース名", { exact: false }).fill("設定を持たない別の会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[a-f0-9-]+$/);
  const otherWorkspace = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(otherWorkspace).not.toBe(workspace);
  const crossWorkspaceUrl = new URL(useUrl); crossWorkspaceUrl.searchParams.set("workspace", otherWorkspace);
  await blocked(page, crossWorkspaceUrl.href);

  await page.goto(`${origin}/workspaces/${workspace}`);
  await page.getByLabel("招待先メールアドレス", { exact: false }).fill("bob@example.test");
  await page.getByRole("button", { name: "招待リンクを発行", exact: true }).click();
  await expect(page.getByLabel("今回発行した招待リンク", { exact: true })).toBeVisible();
  const invitation = await page.getByLabel("今回発行した招待リンク", { exact: true }).inputValue();
  const context = await browser.newContext();
  try {
    const bob = await context.newPage();
    await login(bob, "bob", origin, false);
    await bob.goto(invitation);
    await bob.getByRole("button", { name: "参加する", exact: true }).click();
    await expect(bob).toHaveURL(`${origin}/workspaces/${workspace}`);
    await bob.goto(`${origin}/workbench?workspace=${workspace}`);
    await expect(bob.getByLabel("依頼内容", { exact: true })).toBeVisible();
    trackStarts(bob);
    await blocked(bob, useUrl.href);
  } finally { await context.close(); }
});
