import { chromium, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthConfig } from "../server/auth-config";
import { createPool } from "../server/auth-store";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webOrigin = "http://127.0.0.1:3100";
const issuerOrigin = "http://localhost:8180";
const text = "コハク集計レポートを作ってください。結果をtotal列のCSVファイルにしてください。";
const description = "コハク集計レポートを作る依頼で使用します。専用の値の資料から合計しCSVを作成する手順です。";
const instructions = "コハク集計レポートを作るときは、まず補助ファイル references/values.csv を read_skill_file で読んでください。値はその資料にだけあります。次に隔離Pythonでamount列を合計し、/output/amber-total.csv にtotal列と合計値のCSVを書き、標準出力に合計を表示してください。入力ファイルの添付は不要です。読み取った資料の数値をPythonソースのリテラルとして使えます。計算成功の履歴を確認したら、合計とファイル名を回答してください。";
const resource = "amount\n13\n29\n";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

async function main() {
  check(process.argv.slice(2).join(" ") === "--run --real-model", "Use --run --real-model explicitly");
  process.umask(0o077);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = join(repository, "ax-local/.state/verification", `automatic-skills-${stamp}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: "ja-JP", acceptDownloads: true, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  let starts = 0, created = 0, published = 0, rootId: string | null = null, workspace: string | null = null;
  let failure: string | null = null, phase = "login";
  const result: Record<string, unknown> = { request_sha256: hash(text), starts: 0, passed: false };
  const skillName = `verify-amber-${randomUUID().slice(0, 8)}`;
  let versionId = "";
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (![webOrigin, issuerOrigin].includes(url.origin)) { await route.abort(); return; }
    if (request.method() !== "POST") { await route.continue(); return; }
    if (phase === "login" && (url.pathname.replace(/\.data$/, "") === "/login" || url.origin === issuerOrigin && url.pathname === "/realms/ax/login-actions/authenticate")) { await route.continue(); return; }
    let packet: any; try { packet = request.postDataJSON(); } catch { await route.abort(); return; }
    if (phase === "verify" && url.pathname === "/files/transfer" && url.searchParams.get("workspace") === workspace && ["get", "read"].includes(packet.intent)) { await route.continue(); return; }
    if (url.pathname === "/library/transfer" && phase === "skill" && url.searchParams.get("workspace") === workspace) {
      if (packet.intent === "create" && created === 0 && packet.input?.kind === "skill" && packet.input?.visibility === "personal"
        && packet.input?.content?.name === skillName && packet.input?.content?.instructions === instructions
        && packet.input?.content?.description === description && JSON.stringify(packet.input?.content?.files) === JSON.stringify([{ path: "references/values.csv", content: resource }])) {
        created++; await route.continue(); return;
      }
      if (packet.intent === "publish" && created === 1 && published === 0) { published++; await route.continue(); return; }
    }
    if (url.pathname === "/workbench/transfer" && phase === "start" && starts === 0 && url.searchParams.get("workspace") === workspace
      && packet.intent === "start" && packet.input?.text === text && packet.input?.mode === "model" && packet.input?.allow_model === true
      && !packet.input?.agent_version_id && packet.input?.input_file_ids?.length === 0 && !packet.input?.skill_version_ids?.length && !packet.input?.builtin_skill_ids?.length) {
      starts++;
      try {
        const receipt = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        check(receipt.ok(), "start_receipt_unconfirmed");
        const value = await receipt.json(); check(!value.replayed && typeof value.root_id === "string", "unexpected_start_receipt");
        rootId = value.root_id;
        await route.fulfill({ response: receipt });
      } catch { failure = "start_receipt_unconfirmed_no_retry"; await route.abort(); }
      return;
    }
    await route.abort();
  });
  try {
    await page.goto(`${webOrigin}/login`);
    await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
    await page.waitForURL(url => url.origin === issuerOrigin);
    const secret = await open(join(repository, "ax-local/.state/auth/alice.password"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await secret.stat(); check(info.isFile() && info.size <= 512 && (info.mode & 0o077) === 0, "unsafe_login_file");
      await page.locator("#username").fill("alice@example.test");
      await page.locator("#password").fill((await secret.readFile("utf8")).trim());
    } finally { await secret.close(); }
    await page.locator("#kc-login").click();
    await page.waitForURL(url => url.origin === webOrigin && url.pathname === "/workspaces");
    const card = page.locator(".org-cards > li").filter({ has: page.getByRole("heading", { name: "AX ファイル作業検証", exact: true }) });
    await expect(card).toHaveCount(1);
    const href = await card.getByRole("link", { name: "エージェントを開く", exact: true }).getAttribute("href");
    workspace = new URL(href!, webOrigin).searchParams.get("workspace"); check(workspace, "workspace_missing");
    phase = "skill";
    await page.goto(`${webOrigin}/library/new?kind=skill&workspace=${workspace}`);
    await page.getByLabel("スキル名", { exact: false }).fill(skillName);
    await page.getByLabel("スキルの説明", { exact: false }).fill(description);
    await page.getByLabel("指示", { exact: false }).fill(instructions);
    await page.getByRole("button", { name: "補助ファイルを追加", exact: true }).click();
    await page.getByLabel("ファイル名", { exact: false }).fill("references/values.csv");
    await page.locator("#supplement-content-0").fill(resource);
    await page.getByRole("button", { name: "下書きを登録", exact: true }).click();
    await page.getByRole("button", { name: "保存した下書きを公開", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("第1版を公開しました。");
    const use = await page.getByRole("link", { name: "この版で依頼する", exact: true }).getAttribute("href");
    versionId = new URL(use!, webOrigin).searchParams.get("skill")!;
    check(versionId, "version_missing");
    await page.goto(`${webOrigin}/workbench?workspace=${workspace}`);
    await expect(page.locator("#workbench-agent")).toHaveCount(0);
    await expect(page.locator(".skill-picks > li")).toHaveCount(0);
    await page.getByLabel("依頼内容", { exact: true }).fill(text);
    await page.getByLabel("AIに依頼する", { exact: true }).check();
    await page.getByRole("checkbox", { name: "外部送信とモデル利用料金を確認しました", exact: true }).check();
    phase = "start";
    await page.getByRole("button", { name: "依頼を送る", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("root") === rootId && rootId !== null);
    phase = "waiting";
    const began = Date.now(); let notified = 0;
    for (;;) {
      const state = (await page.locator(".run-status-panel h2").allTextContents())[0];
      if (Date.now() - notified > 10_000) { notified = Date.now(); process.stdout.write(JSON.stringify({ phase, state, elapsed_ms: Date.now() - began }) + "\n"); }
      if (state === "完了しました") break;
      check(!failure && !["完了できませんでした", "停止しました", "実行状況の確認が必要です", "あなたの回答を待っています"].includes(state), `unexpected_state:${state}`);
      check(Date.now() - began < 300_000, "deadline_no_retry");
      await page.waitForTimeout(1000);
    }
    result.browser_elapsed_ms = Date.now() - began;
    phase = "verify";
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "amber-total.csvをダウンロード", exact: true }).click();
    const artifact = await download;
    const bytes = await readFile((await artifact.path())!);
    check(bytes.toString("utf8").replace(/^\uFEFF/, "").trim().replace(/\r\n/g, "\n") === "total\n42", "artifact_content_mismatch");
    result.artifact_sha256 = hash(bytes);
    const pool = createPool(readAuthConfig());
    try {
      const root = (await pool.query("SELECT state,model_calls,tool_calls,python_calls,active_ms,skill_discovery FROM ax_agent_roots WHERE id=$1 AND workspace_id=$2 AND initial_text=$3", [rootId, workspace, text])).rows[0];
      check(root?.state === "succeeded" && root.skill_discovery === true && root.model_calls <= 6 && root.python_calls === 1 && root.active_ms < 300000, "server_root_mismatch");
      const segments = (await pool.query("SELECT s.run_id,s.attempt_kind,s.descriptor,s.proposal,r.resolved,r.invalid,r.cleanup,r.result FROM ax_agent_segments s JOIN ax_runs r USING(run_id) WHERE s.root_id=$1 ORDER BY s.sequence", [rootId])).rows;
      check(segments.length >= 5 && segments.length <= 9, "progressive_stages_missing");
      const first = segments[0].descriptor.skill_context;
      check(first.catalog.some((v: any) => v.id === versionId) && first.loaded_skills.length === 0 && first.loaded_files.length === 0, "not_metadata_only_initially");
      check(segments.some(s => s.proposal?.kind === "read_skills" && s.proposal.skill_ids.includes(versionId)), "implicit_skill_read_missing");
      check(segments.some(s => s.proposal?.kind === "read_skill_file" && s.proposal.skill_id === versionId && s.proposal.path === "references/values.csv"), "resource_read_missing");
      check(segments.some(s => s.descriptor.skill_context?.loaded_skills.some((v: any) => v.id === versionId) && s.descriptor.skill_context.loaded_files.length === 0), "resource_loaded_eagerly");
      check(segments.some(s => s.descriptor.skill_context?.loaded_files.some((v: any) => v.skill_id === versionId && v.content === resource)), "resource_content_missing");
      check(segments.every(s => s.resolved && !s.invalid && s.cleanup?.egress_denied && s.cleanup?.suspended && (s.attempt_kind !== "python" || !s.descriptor.skill_context)), "cleanup_or_isolation_mismatch");
      result.server = { ...root, segments: segments.map(s => ({ run_id: s.run_id, kind: s.attempt_kind, proposal: s.proposal?.kind ?? null, estimated_usd: s.result.estimated_usd })) };
    } finally { await pool.end(); }
    await page.getByLabel("作業の会話", { exact: true }).screenshot({ path: join(evidence, "completed.png") });
    result.passed = true;
  } catch (error) {
    failure ??= error instanceof Error ? error.message.split("\n")[0] : "verification_failed";
    process.exitCode = 1;
  } finally {
    result.phase = phase; result.failure = failure; result.starts = starts; result.root_id = rootId; result.skill_version_id = versionId; result.workspace_id = workspace; result.observed_at = new Date().toISOString();
    await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    await browser.close();
    process.stdout.write(JSON.stringify({ passed: result.passed, phase, failure, root_id: rootId, evidence_directory: evidence }) + "\n");
  }
}

main().catch(() => { process.stderr.write("Local verification setup failed; no automatic retry.\n"); process.exitCode = 1; });
