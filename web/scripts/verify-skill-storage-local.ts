import { chromium, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";

const origin = "http://127.0.0.1:3100", issuer = "http://localhost:8180";
const marker = `Storage verification ${randomUUID()}`;
const skillName = `verify-storage-${randomUUID().slice(0, 8)}`;
const instructions = `${marker}\nこれは保存と搬送の無課金検証に使う合成スキルです。`;
const check = (value: unknown, code: string) => { if (!value) throw new Error(code); };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function main() {
  check(process.argv.slice(2).join(" ") === "--run --preview", "explicit_preview_required");
  process.umask(0o077);
  const evidence = resolve(`../ax-local/.state/verification/skill-storage-${Date.now()}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: "ja-JP", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  let started = false, rootId = "", versionId = "", workspace = "";
  const result: Record<string, unknown> = { passed: false, external_model: false };
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (![origin, issuer].includes(url.origin)) return route.abort();
    if (request.method() === "POST" && url.pathname === "/workbench/transfer") {
      const body = request.postDataJSON();
      if (body.intent === "start") {
        if (started || body.input?.mode !== "preview" || body.input?.skill_version_ids?.length !== 1 || body.input.skill_version_ids[0] !== versionId) return route.abort();
        started = true;
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        check(response.ok(), "acceptance_unconfirmed_do_not_retry");
        const receipt = await response.json(); rootId = receipt.root_id;
        return route.fulfill({ response });
      }
      if (body.intent !== "stop") return route.abort();
    }
    await route.continue();
  });
  try {
    await page.goto(`${origin}/login`);
    await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
    await page.waitForURL(url => url.origin === issuer);
    const secret = await open(resolve("../ax-local/.state/auth/alice.password"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await secret.stat(); check(stat.isFile() && stat.size <= 512 && (stat.mode & 0o077) === 0, "unsafe_login_file");
      await page.locator("#username").fill("alice@example.test");
      await page.locator("#password").fill((await secret.readFile("utf8")).trim());
    } finally { await secret.close(); }
    await page.locator("#kc-login").click();
    await page.waitForURL(url => url.origin === origin && url.pathname === "/workspaces");
    const card = page.locator(".org-cards > li").filter({ has: page.getByRole("heading", { name: "AX ファイル作業検証", exact: true }) });
    const link = await card.getByRole("link", { name: "エージェントを開く", exact: true }).getAttribute("href");
    workspace = new URL(link!, origin).searchParams.get("workspace")!;
    check(workspace, "workspace_missing");
    await page.goto(`${origin}/library/new?kind=skill&workspace=${workspace}`);
    await page.getByLabel("スキル名", { exact: false }).fill(skillName);
    await page.getByLabel("スキルの説明", { exact: false }).fill("保存と搬送の検証用。通常の依頼には使用しません。");
    await page.getByLabel("指示", { exact: false }).fill(instructions);
    await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
    await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
    const use = await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href");
    versionId = new URL(use!, origin).searchParams.get("skill")!;
    await page.goto(new URL(use!, origin).href);
    await page.getByLabel("依頼内容", { exact: true }).fill("スキルファイルの保存と搬送を確認します。");
    await page.getByLabel("画面の操作を試す（無料）", { exact: true }).check();
    await page.getByRole("button", { name: "操作を試す", exact: true }).click();
    await expect(page.getByRole("heading", { name: "あなたの回答を待っています", exact: true })).toBeVisible({ timeout: 180000 });
    const pool = createPool(readAuthConfig());
    try {
      const row = (await pool.query("SELECT v.content,v.definition_id FROM ax_definition_versions v WHERE v.id=$1", [versionId])).rows[0];
      check(row?.content.source?.type === "skill-object-v1" && !row.content.instructions, "definition_body_not_external");
      const segment = (await pool.query("SELECT s.run_id,s.descriptor,r.cleanup,r.resolved,r.invalid FROM ax_agent_segments s JOIN ax_runs r USING(run_id) WHERE s.root_id=$1", [rootId])).rows;
      check(segment.length === 1 && segment[0].resolved && !segment[0].invalid && segment[0].cleanup.egress_denied && segment[0].cleanup.suspended, "runtime_cleanup_missing");
      check(segment[0].descriptor.skill_context.version === 2 && segment[0].descriptor.skill_context.objects[0].id === versionId && !JSON.stringify(segment[0].descriptor).includes(marker), "descriptor_not_reference_only");
      const ops = (await pool.query("SELECT request_bytes FROM ax_agent_operations WHERE run_id=$1 AND kind='model'", [segment[0].run_id])).rows;
      check(ops.length === 1 && ops[0].request_bytes.toString("utf8").includes(marker), "runtime_file_not_read_into_context");
      result.run_id = segment[0].run_id; result.definition_id = row.definition_id;
      result.manifest_sha256 = row.content.source.manifest_sha256; result.instructions_sha256 = hash(instructions);
    } finally { await pool.end(); }
    await page.getByLabel("作業の会話", { exact: true }).screenshot({ path: resolve(evidence, "preview.png") });
    await page.getByRole("button", { name: "この作業を停止する", exact: true }).click();
    await expect(page.getByRole("heading", { name: "停止しました", exact: true })).toBeVisible();
    await page.goto(`${origin}/library/${result.definition_id}?workspace=${workspace}`);
    await page.getByLabel("この設定の利用を終了する", { exact: true }).check();
    await page.getByRole("button", { name: "利用終了にする", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("この設定の利用を終了しました。");
    result.synthetic_skill_archived = true;
    result.passed = true;
  } catch (error) {
    result.failure = error instanceof Error ? error.message.split("\n")[0] : "verification_failed"; process.exitCode = 1;
  } finally {
    result.root_id = rootId; result.skill_version_id = versionId; result.workspace_id = workspace;
    result.observed_at = new Date().toISOString(); result.starts = started ? 1 : 0;
    await writeFile(resolve(evidence, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    await browser.close();
    console.info(JSON.stringify({ passed: result.passed, failure: result.failure, root_id: rootId, evidence }));
  }
}
main().catch(() => { console.error("Storage verification setup failed; no automatic retry."); process.exitCode = 1; });
