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
  await page.getByLabel("workbench-sales（第1版）", { exact: true }).check();
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
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作を確認してください", exact: true })).toBeVisible();
  await expect(page.getByLabel("依頼内容", { exact: true })).toHaveAttribute("readonly", "");
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
  await page.screenshot({ path: "../.space/tasks/ax-agent-workbench/evidence/workbench-result-mobile.png", fullPage: true });
});

test("workbench model use requires consent and waiting work can be stopped", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("実モデルで作業を進める", { exact: true }).check();
  await page.getByLabel("依頼内容", { exact: true }).fill("集計してください。");
  let sent = 0; page.on("request", request => { if (request.url().includes("/workbench/transfer")) sent++; });
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "操作を確認してください", exact: true })).toBeVisible(); expect(sent).toBe(0);
  await page.getByLabel("模擬応答で操作を試す（無料）", { exact: true }).check();
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await expect(page.getByLabel("質問への回答", { exact: true })).toHaveCount(0);
});

test("answer text and uncertain receipt survive a transient detail failure", async ({ page }) => {
  await login(page); await page.goto(workspacePath(page, "/workbench"));
  await page.getByLabel("依頼内容", { exact: true }).fill("再取得の確認");
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  const root = new URL(page.url()).searchParams.get("root")!;
  const fault = () => database(pool => pool.query("INSERT INTO ax_browser_workbench_faults VALUES($1)", [root]));
  await page.getByLabel("質問への回答", { exact: true }).fill("入力を保持する");
  await fault(); await page.getByRole("button", { name: "作業を更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "作業を表示できません", exact: true })).toBeVisible();
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
  await fault(); await page.getByRole("button", { name: "作業を更新", exact: true }).click();
  await expect(page.getByRole("heading", { name: "作業を表示できません", exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  const original = page.url(), root = new URL(original).searchParams.get("root")!;
  await database(pool => pool.query(`INSERT INTO ax_agent_roots SELECT (jsonb_populate_record(NULL::ax_agent_roots,to_jsonb(a)||jsonb_build_object('id',gen_random_uuid(),'created_at',clock_timestamp()+i*interval '1 second','state','stopped','question',NULL,'wait_expires_at',NULL))).* FROM ax_agent_roots a CROSS JOIN generate_series(1,51) i WHERE a.id=$1`, [root]));
  await page.reload(); await page.getByRole("link", { name: "次の50件", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("root")).toBe(root);
  expect(new URL(page.url()).searchParams.has("draft")).toBe(false);
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "＋ 新しい作業", exact: true }).click();
  await page.getByLabel("依頼内容", { exact: true }).fill("別の作業");
  await page.getByRole("button", { name: "作業を始める", exact: true }).click();
  await expect(page.getByLabel("質問への回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
  await page.goto(original); await page.getByLabel("質問への回答", { exact: true }).fill("元の質問への回答");
  await page.getByRole("button", { name: "回答して続ける", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完了しました", exact: true })).toBeVisible();
});
