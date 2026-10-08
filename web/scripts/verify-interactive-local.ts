import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webOrigin = "http://127.0.0.1:3100";
const keycloakOrigin = "http://localhost:8180";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceName = "AX 対話Runtime検証";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runId = /^ax-run-[0-9a-f]{16}$/;
const question = "成果物に含めたい内容を教えてください。";
const stateLabels = {
  running: "返答を準備しています", waiting_input: "あなたの回答を待っています",
  succeeded: "完了しました", failed: "完了できませんでした",
  blocked_unknown: "実行の状態を確認する必要があります", stopped: "停止しました",
  stopping: "停止を確認しています",
} as const;
type Phase = "setup" | "alice_login" | "workspace" | "request" | "question" | "answer" | "artifact" | "bob_login" | "isolation" | "complete";

class VerificationError extends Error {}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new VerificationError(code);
}
function identifier(value: string | null) {
  check(value && uuid.test(value), "invalid_identifier");
  return value.toLowerCase();
}
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
  check(args.includes("--run") && args.every(arg => ["--run", "--headed", "--real-model"].includes(arg)) && new Set(args).size === args.length, "run_flag_required");
  const realModel = args.includes("--real-model");
  process.umask(0o077);
  const evidenceDir = join(repository, "ax-local/.state/verification", `interactive-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const marker = randomUUID().slice(0, 8);
  const requestText = realModel ? `チーム向けの短い会議案内を作りたいです。日時が未定なので、まず日時を一つ質問してください。検証番号 ${marker}。` : `ローカル対話プレビュー検証 ${marker}。質問の後、回答をそのまま成果物にしてください。`;
  const answerText = realModel ? "10月8日15時、30分の開発定例です。本文は80字以内、日本語で日時と会議名を必ず含めてください。" : `AX 対話Runtime検証 ${marker}\n質問への回答を成果物として保存できました。`;
  const mutations = { workspace: 0, start: 0, answer: 0 };
  const observations: Record<string, boolean | number | string | string[] | null> = {
    mock_preview_only: !realModel, model_consent_submissions: realModel ? 1 : 0, server_paid_usage_verified: false,
    workspace_id: null, conversation_id: null, root_id: null, run_ids: [], workspace_created: false,
    question_verified: false, reload_preserved_question: false, artifact_matches_answer: false,
    bob_cannot_view: false, bob_artifact_status: null, blocked_requests: 0, page_error_count: 0,
  };
  let phase: Phase = "setup";
  let browser: Browser | undefined;
  let currentPage: Page | undefined;
  let failure: string | null = null;
  let screenshot: string | null = null;
  async function save() {
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify({
      version: 1, observed_at: new Date().toISOString(), phase, passed: phase === "complete" && failure === null,
      failure, observations, mutations, screenshot,
      limitations: ["Browser evidence does not prove server-side billing or Actor stop; verify those independently.",
        "A failed or uncertain submission is not retried or automatically stopped. Inspect root_id before another run.",
        "Test workspace and runs are retained. Browser contexts are closed without revoking unrelated user work."],
    }, null, 2) + "\n", { mode: 0o600 });
  }
  async function step(next: Phase) { phase = next; await save(); process.stdout.write(JSON.stringify({ phase }) + "\n"); }
  async function newPage(user: "alice" | "bob") {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP", acceptDownloads: true, serviceWorkers: "block" });
    await guard(context, user);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(30_000);
    page.on("pageerror", () => { observations.page_error_count = Number(observations.page_error_count) + 1; });
    currentPage = page;
    return page;
  }
  async function guard(context: BrowserContext, user: "alice" | "bob") {
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      let allowed = [webOrigin, keycloakOrigin].includes(url.origin) && ["GET", "HEAD"].includes(request.method());
      if (request.method() === "POST") {
        if (url.origin === keycloakOrigin) allowed = url.pathname === "/realms/ax/login-actions/authenticate";
        else if (url.origin === webOrigin) {
          const path = url.pathname.replace(/\.data$/, "");
          const fields = new URLSearchParams(request.postData() ?? "");
          const only = (names: string[]) => [...fields.keys()].every(key => names.includes(key) && fields.getAll(key).length === 1);
          if (path === "/login") allowed = only(["csrf", "returnTo"]);
          if (user === "alice" && phase === "workspace" && path === "/workspaces" && only(["csrf", "key", "name"]) && fields.get("name") === workspaceName && mutations.workspace === 0) {
            mutations.workspace++; allowed = true;
          }
          if (user === "alice" && path === "/agent" && url.searchParams.get("workspace") === observations.workspace_id && only(["csrf", "intent", "key", "text", "conversation_id", "root_id", "question_id", "expected_revision", "mode", "allow_model"])) {
            if (phase === "request" && fields.get("intent") === "start" && fields.get("text") === requestText && fields.get("mode") === (realModel ? "model" : "preview") && fields.has("allow_model") === realModel && (!realModel || fields.get("allow_model") === "yes") && mutations.start === 0) {
              mutations.start++; allowed = true;
            }
            if (phase === "answer" && fields.get("intent") === "answer" && fields.get("text")?.replace(/\r\n?/g, "\n") === answerText && fields.get("root_id") === observations.root_id && mutations.answer === 0) {
              mutations.answer++; allowed = true;
            }
          }
        }
      }
      if (allowed) await route.continue();
      else { observations.blocked_requests = Number(observations.blocked_requests) + 1; await route.abort("blockedbyclient"); }
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === "3100") socket.connectToServer();
      else { observations.blocked_requests = Number(observations.blocked_requests) + 1; socket.close(); }
    });
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
  }
  async function waitState(page: Page, target: "waiting_input" | "succeeded") {
    await page.waitForFunction(({ labels, expected }) => {
      const status = document.querySelector(".run-status-panel h2")?.textContent?.trim();
      return status === labels[expected] || [labels.failed, labels.blocked_unknown, labels.stopped, labels.stopping].some(label => label === status) || document.querySelector('[role="alert"]') !== null;
    }, { labels: stateLabels, expected: target }, { timeout: 180_000 });
    const state = (await page.locator(".run-status-panel h2").textContent().catch(() => null))?.trim();
    observations.last_state = Object.entries(stateLabels).find(([, label]) => label === state)?.[0] ?? "unavailable";
    check(state === stateLabels[target], "unexpected_dialogue_state");
    check(await page.getByRole("alert").count() === 0, "dialogue_error_visible");
  }
  try {
    await save();
    browser = await chromium.launch({ headless: !args.includes("--headed") });
    await step("alice_login");
    const alice = await newPage("alice");
    await login(alice, "alice");
    await step("workspace");
    const cards = () => alice.locator(".org-cards > li").filter({ has: alice.getByRole("heading", { name: workspaceName, exact: true }) });
    check(await alice.getByRole("alert").count() === 0, "workspace_list_failed");
    if (await cards().count() === 0) {
      await alice.getByLabel("ワークスペース名", { exact: false }).fill(workspaceName);
      await alice.getByRole("button", { name: "作成する", exact: true }).click();
      await alice.waitForURL(url => url.origin === webOrigin && /^\/workspaces\/[0-9a-f-]{36}$/.test(url.pathname));
      observations.workspace_created = true;
      await alice.goto(`${webOrigin}/workspaces`);
    }
    check(await cards().count() === 1, "workspace_missing_or_ambiguous");
    const href = await cards().getByRole("link", { name: "エージェントを開く", exact: true }).getAttribute("href");
    check(href, "workspace_link_missing");
    const workspace = identifier(localURL(href).searchParams.get("workspace"));
    observations.workspace_id = workspace;
    await alice.goto(`${webOrigin}/agent?workspace=${workspace}`);
    await expect(alice.getByRole("heading", { name: "依頼に合わせた返答と成果物を受け取れます", exact: true })).toBeVisible();
    await alice.getByRole("radio", { name: realModel ? "実モデルで依頼を進める" : "模擬応答で操作を試す（無料）", exact: true }).check();
    if (realModel) await alice.getByRole("checkbox", { name: "会話の外部送信とモデル利用料金を確認しました", exact: true }).check();
    else check(await alice.locator('input[name="allow_model"],input[name="model_consent"]').count() === 0, "model_consent_present");
    observations.conversation_id = identifier(new URL(alice.url()).searchParams.get("draft"));
    await step("request");
    await alice.getByLabel("依頼内容", { exact: true }).fill(requestText);
    await alice.getByRole("button", { name: "対話を始める", exact: true }).click();
    await alice.waitForURL(url => url.origin === webOrigin && url.pathname === "/agent" && uuid.test(url.searchParams.get("root") ?? ""));
    observations.root_id = identifier(new URL(alice.url()).searchParams.get("root"));
    await step("question");
    await waitState(alice, "waiting_input");
    if (realModel) await expect(alice.getByLabel("エージェントの返答", { exact: true }).locator("p")).toContainText(/日時|いつ|何時/);
    else await expect(alice.getByLabel("エージェントの返答", { exact: true }).locator("p")).toHaveText(question);
    observations.question_verified = true;
    await alice.reload();
    await waitState(alice, "waiting_input");
    if (realModel) await expect(alice.getByLabel("エージェントの返答", { exact: true }).locator("p")).toContainText(/日時|いつ|何時/);
    else await expect(alice.getByLabel("エージェントの返答", { exact: true }).locator("p")).toHaveText(question);
    observations.reload_preserved_question = true;
    if (realModel) {
      const usage = await alice.locator(".agent-usage").textContent();
      const amount = usage?.match(/(\d+\.\d+) USD/);
      check(amount && Number(amount[1]) > 0 && Number(amount[1]) < 0.002, "first_segment_usage_unconfirmed");
      observations.first_segment_estimated_usd = Number(amount[1]);
    }
    await step("answer");
    await alice.getByLabel("質問への回答", { exact: true }).fill(answerText);
    await alice.getByRole("button", { name: "回答して続ける", exact: true }).click();
    await waitState(alice, "succeeded");
    await expect(alice.getByLabel("あなたのメッセージ", { exact: true })).toHaveCount(2);
    await expect(alice.getByLabel("エージェントの返答", { exact: true })).toHaveCount(2);
    const expectedArtifact = await alice.getByLabel("エージェントの返答", { exact: true }).last().locator("p").textContent();
    check(expectedArtifact && (realModel ? expectedArtifact.includes("10月8日") && /15[時:：]/.test(expectedArtifact) && expectedArtifact.includes("開発定例") && expectedArtifact !== answerText : expectedArtifact === answerText), "reply_mismatch");
    const runLinks = await alice.getByRole("link", { name: "実行の詳細", exact: true }).evaluateAll(links => links.map(link => link.getAttribute("href")));
    const runs = runLinks.map(link => localURL(link ?? "").pathname.split("/").at(-1) ?? "");
    check(runs.length === 2 && runs.every(value => runId.test(value)) && new Set(runs).size === 2, "invalid_segment_runs");
    observations.run_ids = runs;
    await step("artifact");
    const artifactLink = alice.getByRole("link", { name: "成果物をダウンロード", exact: true });
    const artifactURL = localURL((await artifactLink.getAttribute("href")) ?? "");
    check(artifactURL.pathname === `/runs/${runs[1]}/artifact` && artifactURL.searchParams.get("workspace") === workspace, "unexpected_artifact_link");
    const downloadPromise = alice.waitForEvent("download");
    await artifactLink.click();
    const download = await downloadPromise;
    check(await download.failure() === null && download.suggestedFilename() === "reply.txt", "download_failed");
    const artifactPath = join(evidenceDir, "reply.txt");
    await download.saveAs(artifactPath);
    await chmod(artifactPath, 0o600);
    const artifact = await readFile(artifactPath);
    check(artifact.equals(Buffer.from(expectedArtifact, "utf8")), "artifact_mismatch");
    observations.artifact_matches_answer = !realModel;
    observations.artifact_matches_request_and_answer = realModel;
    observations.artifact_bytes = artifact.length;
    observations.artifact_sha256 = createHash("sha256").update(artifact).digest("hex");
    screenshot = "completed.png";
    await alice.screenshot({ path: join(evidenceDir, screenshot), fullPage: true, mask: [alice.locator(".sidebar")] });
    await step("bob_login");
    const bob = await newPage("bob");
    await login(bob, "bob");
    await step("isolation");
    await bob.goto(`${webOrigin}/agent?root=${observations.root_id}&workspace=${workspace}`);
    await expect(bob.getByRole("heading", { name: "対話を表示できません", exact: true })).toBeVisible();
    check(await bob.getByLabel("あなたのメッセージ", { exact: true }).count() === 0 && await bob.getByRole("link", { name: "成果物をダウンロード", exact: true }).count() === 0, "private_dialogue_visible");
    observations.bob_cannot_view = true;
    const denied = await bob.request.get(artifactURL.href, { maxRedirects: 0, timeout: 15_000 });
    try {
      observations.bob_artifact_status = denied.status();
      check([403, 404].includes(denied.status()), "private_artifact_not_denied");
    } finally { await denied.dispose(); }
    check(mutations.start === 1 && mutations.answer === 1 && observations.blocked_requests === 0, "unexpected_network_activity");
    check(observations.page_error_count === 0, "browser_page_error");
    await step("complete");
  } catch (cause) {
    failure = cause instanceof VerificationError ? cause.message : "browser_or_local_io_failed";
    if (currentPage && !currentPage.isClosed()) {
      const location = new URL(currentPage.url());
      const agent = location.origin === webOrigin && location.pathname === "/agent" && location.searchParams.get("workspace") === observations.workspace_id;
      const webSetup = location.origin === webOrigin && /^(\/login|\/workspaces(?:\/[0-9a-f-]{36})?)$/.test(location.pathname);
      const keycloak = location.origin === keycloakOrigin && location.pathname.startsWith("/realms/ax/");
      if (agent || webSetup || keycloak) {
        try {
          screenshot = "failure.png";
          await currentPage.screenshot({ path: join(evidenceDir, screenshot), fullPage: false,
            mask: [currentPage.locator(".sidebar, .org-cards, input, textarea")], timeout: 5000 });
        } catch { screenshot = null; }
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
  process.stderr.write(JSON.stringify({ passed: false, failure: cause instanceof VerificationError ? cause.message : "verification_setup_failed",
    usage: "node web/node_modules/tsx/dist/cli.mjs web/scripts/verify-interactive-local.ts --run [--headed] [--real-model]" }) + "\n");
  process.exitCode = 1;
});
