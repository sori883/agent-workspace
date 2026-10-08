import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import pg from "pg";
import { login, workspacePath } from "./auth-helper";
import { prepareTestAuth } from "../prepare-auth";

async function database<T>(action: (pool: pg.Pool) => Promise<T>) {
  const { caPath, ...config } = prepareTestAuth().database;
  const pool = new pg.Pool({ ...config, ssl: caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : false });
  try { return await action(pool); } finally { await pool.end(); }
}

test("slash picks built-ins by keyboard without IME or shortcut submission and keeps paths as text", async ({ page }) => {
  await login(page);
  const field = page.getByLabel("依頼内容", { exact: true });
  let starts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start") starts++; });
  await field.fill("/");
  await expect(page.getByRole("listbox", { name: "指定するスキル" })).toBeVisible();
  await field.press("Control+Enter");
  expect(starts).toBe(0);
  await field.dispatchEvent("compositionstart");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
  expect(starts).toBe(0);
  await field.dispatchEvent("compositionend");
  await expect(page.getByRole("listbox")).toBeVisible();
  await field.press("ArrowDown");
  await expect(page.getByRole("option", { name: /CSV・Excelの集計/ })).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowUp");
  await expect(page.getByRole("option", { name: /相談・文章作成/ })).toHaveAttribute("aria-selected", "true");
  await field.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await field.fill("/tabular-v1");
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-slash-mobile.png", fullPage: true });
  await field.press("Enter");
  await expect(page.getByRole("list", { name: "指定したスキル" })).toContainText("CSV・Excelの集計");
  await expect(field).toHaveValue("");
  expect(starts).toBe(0);
  await page.getByRole("button", { name: /^外す\s*：CSV・Excelの集計/ }).click();
  await expect(page.getByRole("list", { name: "指定したスキル" })).toHaveCount(0);
  await field.fill("/unknown-skill\n相談してください");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByText("「/」で入力したスキルを候補から選ぶか、コマンドを削除してから送信してください。", { exact: true })).toBeVisible();
  expect(starts).toBe(0);
  await field.fill("/tmp/report.csv\nhttps://example.test/a\n8 / 2 を計算してください。");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  expect(starts).toBe(1);
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
});

test("same-name slash choices distinguish sharing scope and submit only the selected version", async ({ page }) => {
  await login(page);
  const versions: string[] = [];
  for (const visibility of ["personal", "workspace"]) {
    await page.goto(workspacePath(page, "/library/new?kind=skill"));
    if (visibility === "workspace") await page.getByLabel("ワークスペースで共有する", { exact: true }).check();
    await page.getByLabel("スキル名", { exact: false }).fill("same-name");
    await page.getByLabel("指示", { exact: false }).fill(`説明を作成してください。${visibility}`);
    await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
    await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
    const href = await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href");
    versions.push(new URL(href!, page.url()).searchParams.get("skill")!);
  }
  await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("依頼内容", { exact: true }).fill("/same-name");
  await expect(page.getByRole("option", { name: "/same-name 自分だけ · 第1版", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "/same-name ワークスペース共有 · 第1版", exact: true }).click();
  await page.getByLabel("依頼内容", { exact: true }).fill("手順を説明してください。");
  const sent = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  expect((await sent).postDataJSON().input).toMatchObject({ skill_version_ids: [versions[1]], builtin_skill_ids: [] });
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
});

test("slash pagination can explicitly choose a skill beyond the first page and warns about omitted automatic candidates", async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/workspaces`);
  await page.getByLabel("ワークスペース名", { exact: false }).fill("スキルのページ送りを確認する会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[a-f0-9-]+$/);
  const workspace = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.goto(`${origin}/library/new?kind=skill&workspace=${workspace}`);
  await page.getByLabel("スキル名", { exact: false }).fill("paged-skill-0");
  await page.getByLabel("指示", { exact: false }).fill("選んだ版で説明を作成してください。");
  const saved = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/library/transfer"));
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  const csrf = (await saved).postDataJSON().csrf;
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  const selectedVersion = new URL((await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href"))!, origin).searchParams.get("skill");
  const endpoint = `${origin}/library/transfer?workspace=${workspace}`;
  for (let i = 1; i <= 51; i++) {
    const created = await page.request.post(endpoint, { headers: { origin }, data: { csrf, intent: "create", input: { key: crypto.randomUUID(), kind: "skill", visibility: "personal", content: { name: `paged-skill-${i}`, description: "ページ送りの確認用", instructions: "説明を作成してください。", files: [] } } } });
    expect(created.status()).toBe(200);
    const item = (await created.json()).definition;
    const published = await page.request.post(endpoint, { headers: { origin }, data: { csrf, intent: "publish", id: item.id, input: { key: crypto.randomUUID(), expected_revision: item.revision } } });
    expect(published.status()).toBe(200);
  }
  await page.goto(`${origin}/workbench?workspace=${workspace}`);
  await page.getByLabel("依頼内容", { exact: true }).fill("/paged-skill-0");
  await expect(page.getByRole("option", { name: /paged-skill-0/ })).toHaveCount(0);
  await page.getByRole("button", { name: "スキルをさらに表示", exact: true }).click();
  await page.getByRole("option", { name: "/paged-skill-0 自分だけ · 第1版", exact: true }).click();
  await expect(page.getByRole("list", { name: "指定したスキル" }).getByRole("link")).toHaveAttribute("target", "_blank");
  await page.getByLabel("依頼内容", { exact: true }).fill("選んだスキルで説明してください。");
  const sent = page.waitForRequest(request => request.method() === "POST" && request.url().includes("/workbench/transfer") && request.postDataJSON()?.intent === "start");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  expect((await sent).postDataJSON().input.skill_version_ids).toEqual([selectedVersion]);
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await expect(page.getByText("利用できるスキルが多いため、自動選択の候補を一部に絞っています。指定したいスキルは「/」から選んでください。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
});

test("the default request accepts text without a file and keeps optional tools out of the way", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/workbench\?/);
  await expect(page.getByRole("heading", { name: "何を手伝いましょうか", exact: true })).toBeVisible();
  await expect(page.locator(".request-agent")).toContainText("標準エージェント");
  await expect(page.getByLabel("使用するエージェント", { exact: true })).toHaveCount(0);
  await expect(page.locator("#request-files")).toBeHidden();
  await expect(page.getByText("標準のファイル集計", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "文章を作る・直す", exact: true }).click();
  const field = page.getByLabel("依頼内容", { exact: true });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("社内向けのお知らせの文章を考えてください。");
  const packets: any[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().includes("/workbench/transfer")) packets.push(request.postDataJSON()); });
  await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, keyCode: 229 });
  expect(packets).toHaveLength(0);
  await field.press("Control+Enter");
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  expect(packets).toHaveLength(1);
  expect(packets[0].input).toMatchObject({ input_file_ids: [], skill_version_ids: [], builtin_skill_ids: [], mode: "preview" });
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("link", { name: "新しい依頼を始める", exact: true })).toBeVisible();
  await expect(page.getByText("次の依頼には、このやり取りは自動で引き継がれません。", { exact: true })).toBeVisible();
});

test("published skills and private files start a workbench once after a lost receipt, then answer and download", async ({ page }) => {
  await login(page);
  await page.goto(workspacePath(page, "/library/new?kind=skill"));
  await page.getByLabel("スキル名", { exact: false }).fill("workbench-sales");
  await page.getByLabel("指示", { exact: false }).fill("売上列を確認して合計してください。");
  await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
  await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
  await page.goto(workspacePath(page, "/files"));
  await page.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: "sales.csv", mimeType: "text/csv", buffer: Buffer.from("amount\n100\n200\n") });
  await page.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("sales.csvを保存しました");
  await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("依頼内容", { exact: true }).fill("/workbench-sales");
  await page.getByRole("option", { name: "/workbench-sales 自分だけ · 第1版", exact: true }).click();
  await page.getByRole("button", { name: "ファイルを添付（任意）", exact: true }).click();
  await page.getByLabel(/sales.csv（/).check();
  await page.getByLabel("依頼内容", { exact: true }).fill("売上を集計してください。");
  const packets: unknown[] = []; let csrf = "", lost = false, root = "";
  await page.route("**/workbench/transfer?*", async route => {
    const input = route.request().postDataJSON(); csrf = input.csrf;
    if (input.intent === "start") {
      packets.push(input);
      if (!lost) {
        lost = true; const accepted = await route.fetch(); expect(accepted.status()).toBe(200); root = (await accepted.json()).root_id;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "api_unavailable" }) }); return;
      }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作を確認してください", exact: true })).toBeVisible();
  await expect(page.getByLabel("依頼内容", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: /^外す\s*：workbench-sales/ })).toBeDisabled();
  await page.getByRole("button", { name: "同じ内容で再確認する", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`root=${root}`));
  expect(packets).toHaveLength(2); expect(packets[0]).toEqual(packets[1]);
  expect((packets[0] as any).input.skill_version_ids).toHaveLength(1);
  expect((packets[0] as any).input.input_file_ids).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await expect(page.getByLabel("作業の会話", { exact: true })).toContainText("売上を集計してください。");
  await expect(page.getByLabel("作業の会話", { exact: true })).toContainText("集計する列を教えてください。");
  await page.getByLabel("質問への回答", { exact: true }).fill("ブラウザ成果物の確認");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible();
  await expect(page.getByLabel("作業の会話", { exact: true })).toContainText("ブラウザ成果物の確認");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "browser-fixture.csvをダウンロード", exact: true }).click();
  const file = await download; expect(await readFile((await file.path())!, "utf8")).toBe("kind,total\nfixture,42\n");
  const endpoint = workspacePath(page, "/workbench/transfer"), origin = new URL(page.url()).origin;
  for (const [body, status] of [[{ intent: "stop", id: root, csrf: "bad" }, 403], [{ intent: "stop", id: root, csrf, owner_user_id: "forged" }, 400]] as const) expect((await page.request.post(endpoint, { headers: { origin }, data: body })).status()).toBe(status);
  await page.reload(); await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/automatic-skills-result-mobile.png", fullPage: true });
});

test("workbench model use requires consent and waiting work can be stopped", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("AIに依頼する", { exact: true }).check();
  await page.getByLabel("依頼内容", { exact: true }).fill("集計してください。");
  let sent = 0; page.on("request", request => { if (request.url().includes("/workbench/transfer")) sent++; });
  await page.getByRole("button", { name: "依頼を送る", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作を確認してください", exact: true })).toBeVisible(); expect(sent).toBe(0);
  await page.getByLabel("画面の操作を試す（無料）", { exact: true }).check();
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveCount(0);
});

test("answer text and uncertain receipt survive a transient detail failure", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("依頼内容", { exact: true }).fill("再取得の確認");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  const root = new URL(page.url()).searchParams.get("root")!;
  const fault = () => database(pool => pool.query("INSERT INTO ax_browser_workbench_faults VALUES($1)", [root]));
  await page.getByLabel("質問への回答", { exact: true }).fill("入力を保持する");
  await fault(); await page.getByRole("button", { name: "表示を更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "依頼を表示できません", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "もう一度読み込む", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveValue("入力を保持する");
  const packets: unknown[] = []; let lost = false;
  await page.route("**/workbench/transfer?*", async route => {
    const packet = route.request().postDataJSON();
    if (packet.intent === "answer") {
      packets.push(packet);
      if (!lost) { lost = true; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "api_unavailable" }) }); return; }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("button", { name: "同じ内容で再確認する", exact: true })).toBeVisible();
  await fault(); await page.getByRole("button", { name: "表示を更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "依頼を表示できません", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "もう一度読み込む", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveValue("入力を保持する");
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "同じ内容で再確認する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible();
  expect(packets).toHaveLength(2); expect(packets[0]).toEqual(packets[1]);
});

test("history pagination keeps the open question and never uses its answer key for a new task", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("依頼内容", { exact: true }).fill("ページ送りの元の質問");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  const original = page.url(), root = new URL(original).searchParams.get("root")!;
  await database(pool => pool.query(`INSERT INTO ax_agent_roots SELECT (jsonb_populate_record(NULL::ax_agent_roots,to_jsonb(a)||jsonb_build_object('id',gen_random_uuid(),'created_at',clock_timestamp()+i*interval '1 second','state','stopped','question',NULL,'wait_expires_at',NULL))).* FROM ax_agent_roots a CROSS JOIN generate_series(1,51) i WHERE a.id=$1`, [root]));
  await page.reload(); await page.getByRole("link", { name: "次の50件", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("root")).toBe(root);
  expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "新しい依頼", exact: true }).click();
  await page.getByLabel("依頼内容", { exact: true }).fill("別の作業");
  await page.getByRole("button", { name: "操作を試す", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await page.goto(original); await page.getByLabel("質問への回答", { exact: true }).fill("元の質問への回答");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible();
});
