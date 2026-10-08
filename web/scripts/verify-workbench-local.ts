import { chromium, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileInfoSchema, fileWriteResultSchema } from "../shared/file-contracts";
import { fileTransferSchema } from "../shared/file-transfer";
import { workbenchSubmitSchema } from "../shared/workbench-contracts";
import { workbenchTransferSchema } from "../shared/workbench-transfer";
import { workbenchStateLabels, workbenchError } from "../app/lib/workbench-copy";

const webOrigin = "http://127.0.0.1:3100";
const keycloakOrigin = "http://localhost:8180";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceName = "AX ファイル作業検証";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inputBytes = Buffer.from("amount\n100\n200\n");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Phase = "setup" | "alice_login" | "workspace" | "bob_login" | "bob_membership" | "upload" | "compose" | "request" | "waiting" | "download" | "reload" | "isolation" | "complete";
class VerificationError extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new VerificationError(code); }
function identifier(value: string | null) { check(value && uuid.test(value), "invalid_identifier"); return value.toLowerCase(); }
function localURL(path: string) {
  const url = new URL(path, webOrigin);
  check(url.origin === webOrigin && !url.username && !url.password, "nonlocal_link");
  return url;
}
async function password(user: "alice" | "bob") {
  const file = await open(join(repository, "ax-local/.state/auth", `${user}.password`), constants.O_RDONLY | constants.O_NOFOLLOW);
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
  const evidenceDir = join(repository, "ax-local/.state/verification", `workbench-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const inputName = `sales-${randomUUID().slice(0, 8)}.csv`;
  const requestText = `添付の ${inputName} の amount 列を合計し、summary.csv を作成してください。列名は total、データ行は合計値1行だけにしてください。Pythonで実ファイルを読み、結果ファイルを保存してください。追加の確認質問は不要です。`;
  const counters = { workspace: 0, file_begin: 0, file_put: 0, file_seal: 0, file_list: 0, start: 0, answer: 0, stop: 0, recover: 0, output_get: 0, output_read: 0, isolation_reads: 0, blocked_requests: 0, page_errors: 0 };
  const observations: Record<string, string | string[] | number | boolean | null> = {
    workspace_id: null, root_id: null, initial_run_id: null, input_file_id: null, output_file_id: null,
    input_bytes: inputBytes.length, input_sha256: hash(inputBytes), output_bytes: null, output_sha256: null,
    workspace_created: false, csv_total_verified: false, reload_preserved_result: false,
    bob_workspace_membership_verified: false, bob_root_denied: false, bob_input_denied: false, bob_output_denied: false,
    last_state: null, last_stage: null, wait_elapsed_ms: 0, server_model_calls: null, server_tool_calls: null,
    server_python_calls: null, server_cleanup_verified: false, server_paid_usage_verified: false,
  };
  let phase: Phase = "setup", failure: string | null = null, screenshot: string | null = null;
  let browser: Browser | undefined, currentPage: Page | undefined;
  let outputMetadata: { id: string; size_bytes: number; sha256: string } | undefined;
  let submittedAt = 0;
  const deniedReads = new Set<string>();
  let saveQueue = Promise.resolve();
  function save() {
    const body = JSON.stringify({ version: 1, observed_at: new Date().toISOString(), phase, passed: phase === "complete" && failure === null, failure, observations, counters, screenshot,
      limitations: ["The DOM and one submission receipt expose only the initial run ID; join all runs, server counters, costs and cleanup evidence independently by root_id.",
        "Bob must already be a member of the dedicated workspace. Missing membership stops before upload or model submission; this script never invites or joins users.",
        "Failed, unknown, waiting-input or timed-out work is never resubmitted, answered, stopped or recovered by this script.",
        "CSV bytes are checked in memory; no token, browser trace, storage state, response body or downloaded CSV is saved to evidence.",
        "Test workspace, files and run records are retained. Closing the browser is not proof that a server task has stopped."] }, null, 2) + "\n";
    saveQueue = saveQueue.then(async () => {
      await writeFile(join(evidenceDir, "result.next"), body, { mode: 0o600 });
      await rename(join(evidenceDir, "result.next"), join(evidenceDir, "result.json"));
    });
    return saveQueue;
  }
  async function step(next: Phase) { phase = next; await save(); process.stdout.write(JSON.stringify({ phase }) + "\n"); }
  function healthy() { check(!failure, failure ?? "verification_failed"); check(counters.blocked_requests === 0, "unexpected_network_request"); }
  async function interceptReceipt(route: Route, accept: (json: unknown) => void) {
    let response;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15_000 });
      check(response.status() === 200, "receipt_not_confirmed");
      const bytes = await response.body();
      check(bytes.length <= 65_536, "receipt_too_large");
      accept(JSON.parse(bytes.toString("utf8")));
      await save();
      await route.fulfill({ response });
    } catch {
      failure ??= "receipt_not_confirmed_no_retry";
      await route.abort("failed").catch(() => {});
    } finally { await response?.dispose(); }
  }
  async function guard(context: BrowserContext, user: "alice" | "bob") {
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      let allowed = !url.username && !url.password && [webOrigin, keycloakOrigin].includes(url.origin) && ["GET", "HEAD"].includes(request.method());
      if (request.method() === "POST") {
        const loginPhase = phase === `${user}_login`;
        if (url.origin === keycloakOrigin) allowed = loginPhase && url.pathname === "/realms/ax/login-actions/authenticate";
        else if (url.origin === webOrigin) {
          const path = url.pathname.replace(/\.data$/, ""), fields = new URLSearchParams(request.postData() ?? "");
          const only = (names: string[]) => [...fields.keys()].every(key => names.includes(key) && fields.getAll(key).length === 1);
          if (path === "/login") allowed = loginPhase && only(["csrf", "returnTo"]);
          if (user === "alice" && phase === "workspace" && path === "/workspaces" && only(["csrf", "key", "name"]) && fields.get("name") === workspaceName && counters.workspace === 0) {
            counters.workspace++; allowed = true;
          }
          if (url.searchParams.get("workspace") === observations.workspace_id && request.headers()["content-type"]?.split(";")[0] === "application/json") {
            let json: unknown;
            try { json = JSON.parse(request.postData() ?? ""); } catch { json = null; }
            if (path === "/files/transfer") {
              const parsed = fileTransferSchema.safeParse(json);
              if (parsed.success) {
                const value = parsed.data;
                if (user === "alice" && phase === "upload") {
                  if (value.intent === "begin" && counters.file_begin === 0 && value.input.name === inputName && value.input.size_bytes === inputBytes.length && value.input.sha256 === hash(inputBytes)) {
                    counters.file_begin++;
                    await interceptReceipt(route, body => {
                      const result = fileWriteResultSchema.parse(body);
                      check(!result.replayed && result.file.state === "uploading" && result.file.name === inputName && result.file.sha256 === hash(inputBytes) && result.file.size_bytes === inputBytes.length, "unexpected_upload_receipt");
                      observations.input_file_id = result.file.id;
                    });
                    return;
                  }
                  if (value.intent === "put" && counters.file_put === 0 && value.id === observations.input_file_id && value.index === 0 && value.content_base64 === inputBytes.toString("base64")) { counters.file_put++; allowed = true; }
                  if (value.intent === "seal" && counters.file_put === 1 && counters.file_seal === 0 && value.id === observations.input_file_id) { counters.file_seal++; allowed = true; }
                }
                if (user === "alice" && phase === "compose" && value.intent === "list" && counters.file_list < 10) { counters.file_list++; allowed = true; }
                if (user === "alice" && phase === "download") {
                  if (value.intent === "get" && counters.output_get === 0 && value.id !== observations.input_file_id) {
                    counters.output_get++;
                    await interceptReceipt(route, body => {
                      const file = fileInfoSchema.parse(body);
                      check(file.id === value.id && file.state === "ready" && file.name === "summary.csv" && file.size_bytes <= 4096 && file.chunk_count === 1, "unexpected_output_metadata");
                      outputMetadata = file; observations.output_file_id = file.id;
                    });
                    return;
                  }
                  if (value.intent === "read" && value.id === outputMetadata?.id && value.index === 0 && counters.output_read === 0) { counters.output_read++; allowed = true; }
                }
                if (user === "bob" && phase === "isolation" && (value.intent === "get" || value.intent === "read") && (value.intent !== "read" || value.index === 0)
                  && [observations.input_file_id, observations.output_file_id].includes(value.id) && !deniedReads.has(`${value.id}:${value.intent}`)) {
                  deniedReads.add(`${value.id}:${value.intent}`); counters.isolation_reads++; allowed = true;
                }
              }
            }
            if (user === "alice" && phase === "request" && path === "/workbench/transfer" && counters.start === 0 && observations.bob_workspace_membership_verified === true) {
              const parsed = workbenchTransferSchema.safeParse(json);
              if (parsed.success && parsed.data.intent === "start") {
                const value = parsed.data.input;
                if (value.mode === "model" && value.allow_model === true && value.text === requestText && value.input_file_ids.length === 1 && value.input_file_ids[0] === observations.input_file_id
                  && !value.agent_version_id && (value.skill_version_ids?.length ?? 0) === 0) {
                  counters.start++; submittedAt = Date.now();
                  await save();
                  await interceptReceipt(route, body => {
                    const result = workbenchSubmitSchema.parse(body);
                    observations.root_id = result.root_id; observations.initial_run_id = result.run_id;
                    check(!result.replayed, "unexpected_replayed_root");
                  });
                  return;
                }
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
      if (url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === "3100") socket.connectToServer();
      else { counters.blocked_requests++; socket.close(); }
    });
  }
  async function newPage(user: "alice" | "bob") {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", acceptDownloads: true, serviceWorkers: "block" });
    await guard(context, user);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(30_000);
    page.on("pageerror", () => { counters.page_errors++; });
    currentPage = page;
    return page;
  }
  async function login(page: Page, user: "alice" | "bob") {
    await page.goto(`${webOrigin}/login`);
    await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
    await page.waitForURL(url => url.origin === keycloakOrigin && url.pathname.startsWith("/realms/ax/"));
    await page.locator("#username").fill(`${user}@example.test`);
    await page.locator("#password").fill(await password(user));
    await page.locator("#kc-login").click();
    await page.waitForURL(url => url.origin === webOrigin && url.pathname === "/workspaces");
    await expect(page.getByRole("heading", { name: "参加中のワークスペース", exact: true })).toBeVisible();
    healthy();
  }
  async function waitComplete(page: Page) {
    let previous = "", notifiedAt = 0;
    while (Date.now() - submittedAt < 300_000) {
      healthy();
      const status = await page.locator(".run-status-panel h2").allTextContents();
      const state = Object.entries(workbenchStateLabels).find(([, label]) => label === status[0]?.trim())?.[0] ?? "unavailable";
      const stageText = (await page.locator(".run-status-panel p").allTextContents()).join("");
      observations.last_state = state;
      observations.last_stage = stageText === "選んだファイルを処理しています。" ? "python" : stageText === "依頼内容を確認しています。" ? "runtime" : null;
      observations.wait_elapsed_ms = Date.now() - submittedAt;
      if (previous !== `${state}:${observations.last_stage}` || Date.now() - notifiedAt >= 10_000) {
        previous = `${state}:${observations.last_stage}`; notifiedAt = Date.now(); await save();
        process.stdout.write(JSON.stringify({ phase, state, stage: observations.last_stage, elapsed_ms: observations.wait_elapsed_ms, deadline_ms: 300_000 }) + "\n");
      }
      check(await page.locator('.result-error, [role="alert"]').count() === 0, "workbench_error_visible");
      if (state === "succeeded") return;
      check(state === "running" || state === "unavailable", `workbench_${state}_no_retry`);
      await page.waitForTimeout(Math.min(1000, Math.max(1, 300_000 - (Date.now() - submittedAt))));
    }
    throw new VerificationError("workbench_deadline_no_retry");
  }
  try {
    await save();
    browser = await chromium.launch({ headless: !args.includes("--headed") });
    await step("alice_login"); const alice = await newPage("alice"); await login(alice, "alice");
    await step("workspace");
    const cards = () => alice.locator(".org-cards > li").filter({ has: alice.getByRole("heading", { name: workspaceName, exact: true }) });
    check(await alice.getByRole("alert").count() === 0, "workspace_list_failed");
    if (await cards().count() === 0) {
      await alice.getByLabel("ワークスペース名", { exact: false }).fill(workspaceName);
      await alice.getByRole("button", { name: "作成する", exact: true }).click();
      await alice.waitForURL(url => url.origin === webOrigin && /^\/workspaces\/[0-9a-f-]{36}$/.test(url.pathname));
      observations.workspace_created = true; await alice.goto(`${webOrigin}/workspaces`);
    }
    check(await cards().count() === 1, "workspace_missing_or_ambiguous");
    const href = await cards().getByRole("link", { name: "エージェントを開く", exact: true }).getAttribute("href");
    check(href, "workspace_link_missing");
    const workspace = identifier(localURL(href).searchParams.get("workspace")); observations.workspace_id = workspace;
    await step("bob_login"); const bob = await newPage("bob"); await login(bob, "bob");
    await step("bob_membership");
    check(await bob.getByRole("alert").count() === 0, "bob_workspace_list_failed");
    const bobWorkspaces = await bob.locator(".org-cards > li").getByRole("link", { name: "エージェントを開く", exact: true }).evaluateAll(links => links.map(link => link.getAttribute("href")));
    check(bobWorkspaces.filter(link => link && localURL(link).searchParams.get("workspace") === workspace).length === 1, "bob_workspace_membership_required_before_submission");
    check(Number(counters.start) === 0, "submission_before_membership_check");
    observations.bob_workspace_membership_verified = true;
    const bobCsrf = await bob.locator('input[name="csrf"]').first().inputValue(); check(bobCsrf.length > 0 && bobCsrf.length <= 128, "bob_csrf_unavailable");
    currentPage = alice;
    await step("upload"); await alice.goto(`${webOrigin}/files?workspace=${workspace}`);
    await expect(alice.getByRole("button", { name: "一覧を更新", exact: true })).toBeEnabled();
    await alice.getByLabel("CSV・Excelファイル", { exact: true }).setInputFiles({ name: inputName, mimeType: "text/csv", buffer: inputBytes });
    await alice.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(alice.locator(".file-progress")).toHaveText(`${inputName}を保存しました。`);
    healthy(); check(observations.input_file_id && counters.file_begin === 1 && counters.file_put === 1 && counters.file_seal === 1, "upload_not_confirmed");
    await step("compose"); await alice.goto(`${webOrigin}/workbench?workspace=${workspace}`);
    await alice.getByRole("button", { name: "ファイルを添付（任意）", exact: true }).click();
    const choice = alice.getByRole("checkbox", { name: `${inputName}（1 KiB）`, exact: true });
    for (let page = 0; await choice.count() === 0 && page < 10; page++) {
      const more = alice.getByRole("button", { name: "ファイルをさらに表示", exact: true });
      check(await more.count() === 1, "uploaded_file_not_selectable");
      const count = await alice.locator('.definition-choice input[type="checkbox"]').count();
      await more.click();
      await expect.poll(() => alice.locator('.definition-choice input[type="checkbox"]').count()).toBeGreaterThan(count);
    }
    check(await choice.count() === 1, "uploaded_file_ambiguous");
    await alice.getByRole("radio", { name: "AIに依頼する", exact: true }).check();
    await alice.getByRole("checkbox", { name: "外部送信とモデル利用料金を確認しました", exact: true }).check();
    await choice.check();
    await expect(alice.locator("#workbench-agent")).toHaveValue("");
    await alice.getByLabel("依頼内容", { exact: true }).fill(requestText);
    await step("request"); await alice.getByRole("button", { name: "依頼を送る", exact: true }).click();
    await alice.waitForURL(url => url.origin === webOrigin && url.pathname === "/workbench" && url.searchParams.get("root") === observations.root_id && uuid.test(url.searchParams.get("root") ?? ""));
    healthy(); check(observations.root_id && observations.initial_run_id && counters.start === 1 && submittedAt > 0, "submission_unconfirmed_no_retry");
    await step("waiting"); await waitComplete(alice);
    await step("download");
    const button = alice.getByRole("button", { name: "summary.csvをダウンロード", exact: true });
    await expect(button).toHaveCount(1);
    await expect(alice.locator('[aria-labelledby="workbench-outputs"]').getByRole("button")).toHaveCount(1);
    const downloadPromise = alice.waitForEvent("download"); await button.click(); const download = await downloadPromise;
    check(await download.failure() === null && download.suggestedFilename() === "summary.csv", "download_failed");
    const path = await download.path(); check(path, "download_missing"); const bytes = await readFile(path);
    check(outputMetadata && bytes.length === outputMetadata.size_bytes && hash(bytes) === outputMetadata.sha256, "download_hash_mismatch");
    const csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    check(/^(?:total|"total")\n(?:300(?:\.0+)?|"300(?:\.0+)?")\n?$/.test(csv), "csv_total_mismatch");
    observations.csv_total_verified = true; observations.output_bytes = bytes.length; observations.output_sha256 = hash(bytes); await download.delete();
    await step("reload"); await alice.reload();
    await expect(alice.locator(".run-status-panel h2")).toHaveText(workbenchStateLabels.succeeded);
    await expect(alice.getByRole("button", { name: "summary.csvをダウンロード", exact: true })).toHaveCount(1);
    check(new URL(alice.url()).searchParams.get("root") === observations.root_id, "reload_changed_root");
    observations.reload_preserved_result = true; screenshot = "completed.png";
    await alice.screenshot({ path: join(evidenceDir, screenshot), fullPage: true, mask: [alice.locator(".sidebar, .chat-history")] });
    currentPage = bob;
    await step("isolation"); await bob.goto(`${webOrigin}/workbench?root=${observations.root_id}&workspace=${workspace}`);
    await expect(bob.getByRole("heading", { name: "作業を表示できません", exact: true })).toBeVisible();
    const deniedText = (await bob.locator(".result-error").allTextContents()).join("");
    check(deniedText.includes(workbenchError("workbench_not_found")), "root_owner_denial_unconfirmed");
    check(await bob.getByLabel("作業の会話", { exact: true }).count() === 0 && await bob.locator("#workbench-outputs").count() === 0, "private_root_visible");
    observations.bob_root_denied = true;
    for (const [kind, id] of [["input", observations.input_file_id], ["output", observations.output_file_id]] as const) {
      check(typeof id === "string" && uuid.test(id), "file_identity_missing");
      for (const intent of ["get", "read"] as const) {
        const result = await bob.evaluate(async ({ url, csrf, id, intent }) => {
          const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(12000), body: JSON.stringify({ csrf, intent, id, ...(intent === "read" ? { index: 0 } : {}) }) });
          if (response.status !== 404) { await response.body?.cancel(); return { status: response.status, confirmed: false }; }
          const text = await response.text(); if (text.length > 4096) return { status: response.status, confirmed: false };
          let error: unknown; try { error = JSON.parse(text)?.error; } catch { error = null; }
          return { status: response.status, confirmed: error === "file_not_found" };
        }, { url: `${webOrigin}/files/transfer?workspace=${workspace}`, csrf: bobCsrf, id, intent });
        observations[`bob_${kind}_${intent}_status`] = result.status;
        check(result.confirmed, "private_file_denial_unconfirmed");
      }
      observations[`bob_${kind}_denied`] = true;
    }
    healthy(); check(counters.start === 1 && counters.output_get === 1 && counters.output_read === 1 && counters.isolation_reads === 4 && counters.page_errors === 0, "unexpected_browser_activity");
    await step("complete");
  } catch (cause) {
    failure ??= cause instanceof VerificationError ? cause.message : "browser_or_local_io_failed";
    if (currentPage && !currentPage.isClosed()) {
      const url = new URL(currentPage.url());
      if ([webOrigin, keycloakOrigin].includes(url.origin)) {
        try { screenshot = "failure.png"; await currentPage.screenshot({ path: join(evidenceDir, screenshot), fullPage: false, mask: [currentPage.locator(".sidebar, .chat-history, .org-cards, input, textarea")], timeout: 5000 }); }
        catch { screenshot = null; }
      }
    }
    process.exitCode = 1;
  } finally {
    try { await browser?.close(); } catch { failure ??= "browser_close_failed"; process.exitCode = 1; }
    await save();
    process.stdout.write(JSON.stringify({ passed: failure === null && String(phase) === "complete", phase, failure, evidence_directory: evidenceDir }) + "\n");
  }
}

main().catch(cause => {
  process.stderr.write(JSON.stringify({ passed: false, failure: cause instanceof VerificationError ? cause.message : "verification_setup_failed", usage: "node web/node_modules/tsx/dist/cli.mjs web/scripts/verify-workbench-local.ts --run --real-model [--headed]" }) + "\n");
  process.exitCode = 1;
});
