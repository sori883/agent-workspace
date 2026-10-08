import { chromium, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinCatalog } from "../app/lib/builtin-catalog";
import { workbenchStateLabels } from "../app/lib/workbench-copy";
import { workbenchSubmitSchema } from "../shared/workbench-contracts";
import { workbenchTransferSchema } from "../shared/workbench-transfer";

const webOrigin = "http://127.0.0.1:3100";
const keycloakOrigin = "http://localhost:8180";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceName = "AX ファイル作業検証";
const requestText = "10月8日15時から30分の開発定例を開きます。社内向けに80字以内の案内文を日本語で作ってください。日時・所要時間・会議名を含めてください。";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Phase = "setup" | "login" | "workspace" | "builtins" | "compose" | "request" | "waiting" | "result" | "reload" | "complete";
class VerificationError extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new VerificationError(code); }
function localURL(path: string) {
  const url = new URL(path, webOrigin);
  check(url.origin === webOrigin && !url.username && !url.password, "nonlocal_link");
  return url;
}
async function password() {
  const file = await open(join(repository, "ax-local/.state/auth/alice.password"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size > 0 && stat.size <= 512 && (stat.mode & 0o077) === 0, "unsafe_password_file");
    const value = (await file.readFile("utf8")).trim();
    check(value.length > 0 && !/[\r\n\0]/.test(value), "invalid_password_file");
    return value;
  } finally { await file.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  check(args.includes("--run") && args.includes("--real-model") && args.every(arg => ["--run", "--real-model", "--headed"].includes(arg)) && new Set(args).size === args.length, "explicit_run_and_real_model_required");
  process.umask(0o077);
  const evidenceDir = join(repository, "ax-local/.state/verification", `general-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const counters = { login: 0, authenticate: 0, start: 0, blocked_requests: 0, page_errors: 0 };
  const observations: Record<string, string | number | boolean | null> = {
    workspace_id: null, root_id: null, initial_run_id: null, draft_key: null, catalog_sha256: null,
    builtins_verified: false, default_agent_verified: false, submitted_input_files: null, submitted_skills: null,
    submitted_agent: false, last_state: null, wait_elapsed_ms: 0, python_stage_seen: false,
    assistant_messages: null, output_files_visible: null, answer_characters: null, answer_sha256: null,
    answer_context_verified: false, reload_preserved_result: false, request_sha256: hash(Buffer.from(requestText)),
    server_model_calls: null, server_python_calls: null, server_cleanup_verified: false,
  };
  let phase: Phase = "setup", failure: string | null = null, screenshot: string | null = null;
  let browser: Browser | undefined, page: Page | undefined, submittedAt = 0;
  let saveQueue = Promise.resolve();
  function save() {
    const body = JSON.stringify({ version: 1, observed_at: new Date().toISOString(), phase, passed: phase === "complete" && failure === null, failure, observations, counters, screenshot,
      limitations: ["One browser start request is allowed. Model/Python call counts, cost and cleanup must be joined independently by root_id; absence of a Python stage in polling is not proof of zero server executions.",
        "Missing workspace, failed, unknown, waiting-input or timed-out work stops verification. There is no workspace creation, answer, retry, stop or recovery action.",
        "Only hashes, identifiers, counts and checks are saved as JSON. Screenshots are restricted to this synthetic request or builtin information. No passwords, tokens, storage, trace, HTML or response bodies are saved.",
        "The created root is retained. Browser shutdown does not prove the server execution has stopped."] }, null, 2) + "\n";
    saveQueue = saveQueue.then(async () => {
      await writeFile(join(evidenceDir, "result.next"), body, { mode: 0o600 });
      await rename(join(evidenceDir, "result.next"), join(evidenceDir, "result.json"));
    });
    return saveQueue;
  }
  async function step(next: Phase) { phase = next; await save(); process.stdout.write(JSON.stringify({ phase }) + "\n"); }
  function healthy() {
    check(!failure, failure ?? "verification_failed");
    check(counters.blocked_requests === 0, "unexpected_network_request");
    check(counters.page_errors === 0, "browser_page_error");
  }
  async function receiveSubmission(route: Route) {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15_000 });
      check(response.status() === 200, "receipt_not_confirmed");
      const bytes = await response.body();
      check(bytes.length <= 65_536, "receipt_too_large");
      const result = workbenchSubmitSchema.parse(JSON.parse(bytes.toString("utf8")));
      observations.root_id = result.root_id; observations.initial_run_id = result.run_id;
      check(!result.replayed, "unexpected_replayed_root");
      await save(); await route.fulfill({ response });
    } catch {
      failure ??= "receipt_not_confirmed_no_retry";
      await route.abort("failed").catch(() => {});
    } finally { await response?.dispose(); }
  }
  async function guard(context: BrowserContext) {
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      const local = !url.username && !url.password && [webOrigin, keycloakOrigin].includes(url.origin);
      let allowed = local && ["GET", "HEAD"].includes(request.method());
      if (local && request.method() === "POST") {
        if (phase === "login" && url.origin === keycloakOrigin && url.pathname === "/realms/ax/login-actions/authenticate" && counters.authenticate === 0) {
          counters.authenticate++; allowed = true;
        } else if (url.origin === webOrigin) {
          const path = url.pathname.replace(/\.data$/, "");
          if (phase === "login" && path === "/login" && counters.login === 0) {
            const fields = new URLSearchParams(request.postData() ?? "");
            allowed = [...fields.keys()].every(key => ["csrf", "returnTo"].includes(key) && fields.getAll(key).length === 1);
            if (allowed) counters.login++;
          }
          if (phase === "request" && path === "/workbench/transfer" && counters.start === 0 && observations.builtins_verified === true
            && url.searchParams.getAll("workspace").length === 1 && url.searchParams.get("workspace") === observations.workspace_id
            && request.headers()["content-type"]?.split(";")[0] === "application/json") {
            let json: unknown; try { json = JSON.parse(request.postData() ?? ""); } catch { json = null; }
            const parsed = workbenchTransferSchema.safeParse(json);
            if (parsed.success && parsed.data.intent === "start") {
              const value = parsed.data.input;
              if (value.key === observations.draft_key && value.mode === "model" && value.allow_model === true && value.text === requestText
                && value.input_file_ids.length === 0 && !value.agent_version_id && (value.skill_version_ids?.length ?? 0) === 0) {
                counters.start++; submittedAt = Date.now(); observations.submitted_input_files = 0; observations.submitted_skills = 0;
                await save(); await receiveSubmission(route); return;
              }
            }
          }
        }
      }
      if (allowed) await route.continue();
      else { counters.blocked_requests++; await route.abort("blockedbyclient"); }
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (!url.username && !url.password && url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === "3100") socket.connectToServer();
      else { counters.blocked_requests++; socket.close(); }
    });
  }
  async function waitComplete() {
    let previous = "", notifiedAt = 0;
    while (Date.now() - submittedAt < 300_000) {
      healthy();
      const status = await page!.locator(".run-status-panel h2").allTextContents();
      const state = Object.entries(workbenchStateLabels).find(([, label]) => label === status[0]?.trim())?.[0] ?? "unavailable";
      const stage = (await page!.locator(".run-status-panel p").allTextContents()).join("");
      if (stage === "計算・ファイル処理を進めています。" || stage === "選んだファイルを処理しています。") observations.python_stage_seen = true;
      observations.last_state = state; observations.wait_elapsed_ms = Date.now() - submittedAt;
      if (previous !== state || Date.now() - notifiedAt >= 10_000) {
        previous = state; notifiedAt = Date.now(); await save();
        process.stdout.write(JSON.stringify({ phase, state, elapsed_ms: observations.wait_elapsed_ms, deadline_ms: 300_000 }) + "\n");
      }
      check(await page!.locator('.result-error, [role="alert"]').count() === 0, "workbench_error_visible");
      check(observations.python_stage_seen === false, "unexpected_python_stage_no_retry");
      if (state === "succeeded") return;
      check(state === "running" || state === "unavailable", `workbench_${state}_no_retry`);
      await page!.waitForTimeout(Math.min(1000, Math.max(1, 300_000 - (Date.now() - submittedAt))));
    }
    throw new VerificationError("workbench_deadline_no_retry");
  }
  async function resultText() {
    const thread = page!.getByLabel("作業の会話", { exact: true });
    await expect(thread.locator(".user-message > p")).toHaveText(requestText);
    await expect(thread.locator(".assistant-message")).toHaveCount(1);
    await expect(thread.locator(".assistant-message .message-author")).toHaveText("AX エージェント");
    await expect(page!.locator('[aria-labelledby="workbench-outputs"]')).toHaveCount(0);
    observations.assistant_messages = 1; observations.output_files_visible = 0;
    return (await thread.locator(".assistant-message > p").innerText()).trim();
  }
  async function safeScreenshot(name: string) {
    if (!page || page.isClosed() || observations.root_id === null) return;
    const url = new URL(page.url());
    if (url.origin !== webOrigin || url.pathname !== "/workbench" || url.searchParams.get("root") !== observations.root_id) return;
    const thread = page.getByLabel("作業の会話", { exact: true });
    if (await thread.count() !== 1 || (await thread.locator(".user-message > p").allTextContents()).join("") !== requestText) return;
    await thread.screenshot({ path: join(evidenceDir, name), timeout: 5000 }); screenshot = name;
  }
  try {
    observations.catalog_sha256 = hash(await readFile(join(repository, "ax-local/task_runtime/builtin_catalog.json")));
    await save(); browser = await chromium.launch({ headless: !args.includes("--headed") });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", acceptDownloads: false, serviceWorkers: "block" });
    await guard(context); page = await context.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(30_000);
    page.on("pageerror", () => { counters.page_errors++; });
    await step("login"); await page.goto(`${webOrigin}/login`);
    await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
    await page.waitForURL(url => url.origin === keycloakOrigin && url.pathname.startsWith("/realms/ax/"));
    await page.locator("#username").fill("alice@example.test"); await page.locator("#password").fill(await password());
    await page.locator("#kc-login").click();
    await page.waitForURL(url => url.origin === webOrigin && url.pathname === "/workspaces");
    await expect(page.getByRole("heading", { name: "参加中のワークスペース", exact: true })).toBeVisible(); healthy();
    await step("workspace"); check(await page.getByRole("alert").count() === 0, "workspace_list_failed");
    const cards = page.locator(".org-cards > li").filter({ has: page.getByRole("heading", { name: workspaceName, exact: true }) });
    check(await cards.count() === 1, "existing_workspace_missing_or_ambiguous");
    const href = await cards.getByRole("link", { name: "エージェントを開く", exact: true }).getAttribute("href");
    check(href, "workspace_link_missing"); const workspace = localURL(href).searchParams.get("workspace");
    check(workspace && uuid.test(workspace), "workspace_identifier_invalid"); observations.workspace_id = workspace.toLowerCase();
    await step("builtins"); await page.goto(`${webOrigin}/library?workspace=${workspace}`);
    check(await page.getByRole("alert").count() === 0, "library_unavailable");
    const builtins = page.locator('[aria-labelledby="builtin-heading"]');
    await expect(builtins.getByRole("heading", { name: "標準で使える機能", exact: true })).toBeVisible();
    await expect(builtins.getByRole("heading", { name: builtinCatalog.defaultAgent.name, exact: true })).toBeVisible();
    await expect(builtins.getByText(builtinCatalog.defaultAgent.description, { exact: true })).toBeVisible();
    await expect(builtins.locator(".org-cards > li")).toHaveCount(builtinCatalog.skills.length);
    for (const skill of builtinCatalog.skills) {
      const card = builtins.locator(".org-cards > li").filter({ has: page.getByRole("heading", { name: skill.name, exact: true }) });
      await expect(card).toHaveCount(1); await expect(card.getByText(skill.description, { exact: true })).toBeVisible();
      await expect(card.getByText(skill.when, { exact: true })).toBeVisible();
    }
    observations.builtins_verified = true;
    await step("compose"); await builtins.getByRole("link", { name: "標準エージェントに依頼する", exact: true }).click();
    await expect(page.getByRole("heading", { name: "何を手伝いましょうか", exact: true })).toBeVisible();
    const draftURL = localURL(page.url()), draft = draftURL.searchParams.get("draft");
    check(draftURL.pathname === "/workbench" && draftURL.searchParams.get("workspace") === workspace && draft && uuid.test(draft)
      && !["root", "agent", "skill"].some(key => draftURL.searchParams.has(key)), "unexpected_draft_selection");
    observations.draft_key = draft;
    await expect(page.locator(".request-agent > span")).toHaveText(builtinCatalog.defaultAgent.name);
    await expect(page.locator("#workbench-agent")).toHaveCount(0);
    await expect(page.locator('.skill-picks > li, #request-files input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(page.locator(".request-selection")).toHaveCount(0); observations.default_agent_verified = true;
    await page.getByRole("radio", { name: "AIに依頼する", exact: true }).check();
    await page.getByRole("checkbox", { name: "外部送信とモデル利用料金を確認しました", exact: true }).check();
    await page.getByLabel("依頼内容", { exact: true }).fill(requestText); healthy();
    await step("request"); await page.getByRole("button", { name: "依頼を送る", exact: true }).click();
    await page.waitForURL(url => url.origin === webOrigin && url.pathname === "/workbench" && url.searchParams.get("root") === observations.root_id && uuid.test(url.searchParams.get("root") ?? ""));
    healthy(); check(observations.root_id && observations.initial_run_id && counters.start === 1 && submittedAt > 0, "submission_unconfirmed_no_retry");
    await step("waiting"); await waitComplete(); await step("result");
    const answer = await resultText(), normalized = answer.normalize("NFKC").replace(/\s/g, "");
    observations.answer_characters = Array.from(answer).length; observations.answer_sha256 = hash(Buffer.from(answer));
    check(Array.from(answer).length > 0 && Array.from(answer).length <= 80, "answer_length_mismatch");
    check(/(?:10月8日|10[/.\-]8(?!\d))/.test(answer.normalize("NFKC")) && /(?:15時(?:00分)?|15:00|午後3時(?:00分)?)(?![\d分])/.test(normalized)
      && /30分/.test(normalized) && /開発定例/.test(normalized) && /[ぁ-んァ-ヶ一-龯]/.test(answer), "answer_context_mismatch");
    observations.answer_context_verified = true;
    await step("reload"); await page.reload(); await expect(page.locator(".run-status-panel h2")).toHaveText(workbenchStateLabels.succeeded);
    check(new URL(page.url()).searchParams.get("root") === observations.root_id, "reload_changed_root");
    check(await resultText() === answer, "reload_changed_answer"); observations.reload_preserved_result = true;
    await safeScreenshot("completed.png"); check(screenshot !== null, "result_screenshot_unavailable");
    healthy(); check(counters.start === 1, "unexpected_submission_count"); await step("complete");
  } catch (cause) {
    failure ??= cause instanceof VerificationError ? cause.message : "browser_or_local_io_failed";
    try { await safeScreenshot("failure.png"); } catch { screenshot = null; }
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch { failure ??= "browser_close_failed"; process.exitCode = 1; }
    await save(); process.stdout.write(JSON.stringify({ passed: failure === null && String(phase) === "complete", phase, failure, evidence_directory: evidenceDir }) + "\n");
  }
}

main().catch(cause => {
  process.stderr.write(JSON.stringify({ passed: false, failure: cause instanceof VerificationError ? cause.message : "verification_setup_failed", usage: "node web/node_modules/tsx/dist/cli.mjs web/scripts/verify-general-local.ts --run --real-model [--headed]" }) + "\n");
  process.exitCode = 1;
});
