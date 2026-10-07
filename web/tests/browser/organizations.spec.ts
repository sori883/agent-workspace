import { randomUUID } from "node:crypto";
import { test, expect, type Page, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { login, workspacePath } from "./auth-helper";
import { createPool } from "../../server/auth-store";
import { prepareTestAuth } from "../prepare-auth";
import { browserSchema } from "./test-database";
test.setTimeout(60000);
const origin = "http://127.0.0.1:3210";

test.beforeEach(async () => {
  const pool = createPool(prepareTestAuth());
  try {
    expect((await pool.query("SELECT current_schema() AS schema")).rows[0].schema).toBe(browserSchema);
    await pool.query("TRUNCATE org_workspaces CASCADE");
  } finally { await pool.end(); }
});
async function seedOwned(subject: string, count: number) {
  const pool = createPool(prepareTestAuth());
  try {
    expect((await pool.query("SELECT current_schema() AS schema")).rows[0].schema).toBe(browserSchema);
    const user = (await pool.query("SELECT user_id FROM identities WHERE subject=$1", [subject])).rows[0].user_id;
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      await pool.query("SELECT org_create($1,$2,$3,$4)", [user, randomUUID(), `所有数検証${index + 1}`, id]);
      ids.push(id);
    }
    return ids;
  } finally { await pool.end(); }
}
async function join(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(page).toHaveURL(/\/workspaces\/[a-f0-9-]+$/);
}
async function propose(page: Page, label: string) {
  await page.getByRole("group", { name: "譲渡先のメンバー", exact: false }).getByRole("radio", { name: label, exact: true }).check();
  await page.getByRole("button", { name: "譲渡を申請する", exact: true }).click();
  await expect(page.getByRole("heading", { name: "譲渡の承諾待ち", exact: true })).toBeVisible();
}
async function acceptOwnership(page: Page) {
  await page.getByLabel("所有者になることと、譲渡するまで退出できないことを確認しました").check();
  await page.getByRole("button", { name: "所有権の譲渡を承諾する", exact: true }).click();
}

async function manage(page: Page) {
  const id = new URL(page.url()).searchParams.get("workspace")!;
  await page.goto(`${origin}/workspaces/${id}`);
  await expect(page.getByRole("heading", { name: "メンバー", exact: true })).toBeVisible();
  return id;
}
async function invite(page: Page, email: string) {
  await page.getByLabel("招待先メールアドレス", { exact: false }).fill(email);
  await page.getByRole("button", { name: "招待リンクを発行", exact: true }).click();
  await expect(page.getByLabel("今回発行した招待リンク")).toBeVisible();
  return await page.getByLabel("今回発行した招待リンク").inputValue();
}
async function send(page: Page, text: string) {
  await page.getByLabel("メッセージ", { exact: true }).fill(text);
  await page.getByLabel("会話の外部送信とモデル利用料金を確認しました").check();
  await page.getByRole("button", { name: "送信する", exact: true }).click();
  await expect(page.getByLabel("エージェントの返答")).toHaveCount(1, { timeout: 15000 });
}

test("empty membership, atomic creation replay, fifty-owned-workspace limit and independent tabs", async ({ page, context }, testInfo) => {
  await login(page, "alice", origin, false);
  await expect(page.getByText("まだ参加していません。", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("empty-workspaces.png") });
  await page.getByLabel("ワークスペース名", { exact: false }).fill("一つ目の会社");
  const key = await page.locator('input[name="key"]').inputValue(), csrf = await page.locator('input[name="csrf"]').inputValue();
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("一つ目の会社");
  const first = page.url().split("/").at(-1)!;
  const replay = await page.request.post(`${origin}/workspaces`, { headers: { origin }, form: { csrf, key, name: "一つ目の会社" }, maxRedirects: 0 });
  expect(replay.status()).toBe(303); expect(replay.headers().location).toBe(`/workspaces/${first}`);
  const changed = await page.request.post(`${origin}/workspaces`, { headers: { origin }, form: { csrf, key, name: "別の名前" } });
  expect(changed.status()).toBe(409);
  await page.goto("/workspaces");
  await page.getByLabel("ワークスペース名", { exact: false }).fill("二つ目の会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("二つ目の会社");
  const second = page.url().split("/").at(-1)!;
  const tab = await context.newPage();
  await page.goto(`/?workspace=${first}`); await tab.goto(`${origin}/?workspace=${second}`);
  await send(page, "一つ目だけの会話"); await send(tab, "二つ目だけの会話");
  await expect(page.getByText("選択中：一つ目の会社")).toBeVisible();
  await expect(tab.getByText("選択中：二つ目の会社")).toBeVisible();
  await page.reload(); expect(new URL(page.url()).searchParams.get("workspace")).toBe(first);
  await expect(page.getByRole("link", { name: "二つ目だけの会話", exact: false })).toHaveCount(0);
  await tab.goto(page.url().replace(first, second));
  await expect(tab.getByLabel("あなたのメッセージ")).toHaveCount(0);
  await page.goto("/workspaces");
  await page.getByLabel("ワークスペース名", { exact: false }).fill("三つ目の会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("三つ目の会社");
  await page.goto("/workspaces");
  await expect(page.getByText("所有中：3 / 50")).toBeVisible();
  await seedOwned("alice", 47);
  await page.reload();
  await expect(page.getByText("所有中：50 / 50")).toBeVisible();
  await expect(page.getByRole("button", { name: "作成する", exact: true })).toHaveCount(0);
  const excess = await page.request.post(`${origin}/workspaces`, { headers: { origin }, form: { csrf, key: randomUUID(), name: "五十一個目" } });
  expect(excess.status()).toBe(409); expect(await excess.text()).toContain("所有できるワークスペースは50個まで");
  await tab.close();
});

test("email invitation survives login; roles, multiple groups and private data remain separate", async ({ page, browser, context }, testInfo) => {
  await login(page);
  const id = await manage(page);
  const url = await invite(page, "bob@example.test");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "リンクをコピー", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const second = await browser.newContext();
  try {
    const bob = await second.newPage();
    await bob.goto(url);
    await expect(bob).toHaveURL((value) => value.pathname === "/login" && value.searchParams.get("returnTo") === new URL(url).pathname + new URL(url).search);
    await bob.getByRole("button", { name: "ログインへ進む", exact: true }).click();
    await bob.getByRole("button", { name: "Bobでログイン", exact: true }).click();
    await expect(bob).toHaveURL(url);
    await bob.getByRole("button", { name: "参加する", exact: true }).click();
    await expect(bob).toHaveURL(`${origin}/workspaces/${id}`);
    await expect(bob.getByTestId("workspace-member").filter({ hasText: "Bob" })).toContainText("操作権限：一般メンバー ／ 業務ロール：一般");
    await expect(bob.getByRole("heading", { name: "招待", exact: true })).toHaveCount(0);
    await page.reload();
    const member = page.getByTestId("workspace-member").filter({ hasText: "Bob" });
    await member.getByLabel("開発者", { exact: true }).check();
    await member.getByRole("button", { name: "メンバーの設定を保存" }).click();
    await expect(member).toContainText("操作権限：一般メンバー ／ 業務ロール：開発者");
    for (const name of ["開発チーム", "共通プロジェクト"]) {
      await page.getByLabel("新しいグループ名", { exact: false }).fill(name);
      await page.getByRole("button", { name: "グループを作成", exact: true }).click();
      const group = page.getByTestId("workspace-group").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await group.getByLabel("bob@example.test", { exact: true }).check();
      await group.getByRole("button", { name: /参加を保存.*bob@example.test/ }).click();
      await expect(group.getByLabel("bob@example.test", { exact: true })).toBeChecked();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("workspace-management.png") });
    await bob.reload();
    await expect(bob.getByTestId("workspace-group").filter({ hasText: "Bob" })).toHaveCount(2);
    await expect(bob.getByRole("button", { name: "グループを作成", exact: true })).toHaveCount(0);
    const own = page.getByTestId("workspace-member").filter({ hasText: "Alice" });
    await expect(own.getByLabel("一般メンバー", { exact: true })).toBeDisabled();
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    const ownId = await own.locator('input[name="user_id"]').first().inputValue();
    const refused = await page.request.post(page.url(), { headers: { origin }, form: { csrf, intent: "member", user_id: ownId, access_level: "member", business_role: "general" } });
    expect(refused.status()).toBe(409); expect(await refused.text()).toContain("所有者は退出・削除・一般メンバーへの変更ができません");
    const forged = await page.request.post(page.url(), { headers: { origin }, form: { csrf: "wrong", intent: "rename", name: "不正変更" } }); expect(forged.status()).toBe(403);
    await page.goto(`/?workspace=${id}`); await send(page, "同じ会社でも本人限定");
    await bob.goto(page.url()); await expect(bob.getByLabel("あなたのメッセージ")).toHaveCount(0); expect(await bob.content()).not.toContain("同じ会社でも本人限定");
    await page.goto(`/workspaces/${id}`);
    await member.getByText("このメンバーを外す", { exact: true }).click();
    await member.getByLabel("所属とグループ参加を解除することを確認しました").check();
    await member.getByRole("button", { name: "メンバーを外す", exact: true }).click();
    await expect(page.getByTestId("workspace-member").filter({ hasText: "Bob" })).toHaveCount(0);
    expect((await bob.request.get(`${origin}/workspaces/${id}`)).status()).toBe(404);
    await bob.reload(); await expect(bob.getByRole("heading", { name: "会話を表示できません" })).toBeVisible();
    await expect(bob.getByRole("button", { name: "送信できません", exact: true })).toBeDisabled();
    await expect(bob.getByRole("alert")).toContainText("現在は参加していません");
  } finally { await second.close(); }
});

test("invitation replay keeps its link; mismatch, missing verified email, expiry and revoke are explained", async ({ page, browser }) => {
  await login(page); const id = await manage(page);
  const form = page.locator('form').filter({ has: page.getByRole("button", { name: "招待リンクを発行", exact: true }) });
  const key = await form.locator('input[name="key"]').inputValue(), csrf = await form.locator('input[name="csrf"]').inputValue();
  const url = await invite(page, "bob@example.test");
  const replay = await page.request.post(page.url(), { headers: { origin }, form: { csrf, intent: "invite", key, email: "bob@example.test" } });
  expect(replay.status()).toBe(200); expect(await replay.text()).toContain("発行済みのリンクは再表示できません"); expect(await replay.text()).not.toContain(new URL(url).searchParams.get("token")!);
  await page.goto(url); await page.getByRole("button", { name: "参加する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("一致しません");
  const second = await browser.newContext(); const pool = createPool(prepareTestAuth());
  try {
    const bob = await second.newPage(); await login(bob, "bob", origin, false);
    await pool.query("UPDATE users SET verified_email=NULL WHERE id IN (SELECT user_id FROM identities WHERE subject='bob')");
    await bob.goto(url); await expect(bob.getByRole("button", { name: "参加する", exact: true })).toBeDisabled();
    await expect(bob.getByText("メールアドレスの確認が必要です。", { exact: false })).toBeVisible();
    const bobCsrf = await bob.locator('input[name="csrf"]').inputValue();
    const blocked = await bob.request.post(url, { headers: { origin }, form: { csrf: bobCsrf, token: new URL(url).searchParams.get("token")! } });
    expect(blocked.status()).toBe(403);
    await pool.query("UPDATE users SET verified_email='bob@example.test' WHERE id IN (SELECT user_id FROM identities WHERE subject='bob')");
    await pool.query("UPDATE org_invitations SET expires_at=now()-interval '1 second' WHERE workspace_id=$1", [id]);
    await bob.reload(); await bob.getByRole("button", { name: "参加する", exact: true }).click();
    await expect(bob.getByRole("alert")).toContainText("期限切れ");
    await page.goto(`/workspaces/${id}`); const renewed = await invite(page, "bob@example.test");
    await page.getByRole("button", { name: "招待を取り消す", exact: true }).click();
    await bob.goto(renewed); await bob.getByRole("button", { name: "参加する", exact: true }).click();
    await expect(bob.getByRole("alert")).toContainText("取り消し済み");
  } finally { await pool.query("UPDATE users SET verified_email='bob@example.test' WHERE id IN (SELECT user_id FROM identities WHERE subject='bob')"); await pool.end(); await second.close(); }
});

test("legacy is read-only with safe recovery, and native organization forms fit 320px", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 740 } });
  try {
    const page = await context.newPage(); await login(page);
    await page.goto(`${origin}/tasks?legacy=1`);
    await expect(page.getByRole("button", { name: "実行する", exact: true })).toHaveCount(0);
    await page.locator(".run-link").first().click();
    expect(new URL(page.url()).searchParams.get("legacy")).toBe("1");
    await page.getByRole("button", { name: "状態を確認して終了する", exact: true }).click();
    await expect(page.getByRole("heading", { name: "開始せず終了", exact: true })).toBeVisible();
    await page.goto(`${origin}/tasks?legacy=1`);
    await page.goto(`${origin}/?legacy=1`);
    await expect(page.getByLabel("メッセージ", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "新しいチャット", exact: false })).toHaveCount(0);
    await page.goto(workspacePath(page, "/tasks"));
    const token = await page.locator('input[name="csrf"]').inputValue();
    const rejected = await page.request.post(`${origin}/tasks?legacy=1`, { headers: { origin }, form: { csrf: token, key: randomUUID(), mode: "offline", instruction: "送信禁止", input_text: "", output_name: "result.txt" } });
    expect(rejected.status()).toBe(403);
    await page.goto(`${origin}/workspaces`);
    await page.getByRole("link", { name: "メンバー・設定", exact: true }).last().click();
    await page.getByLabel("新しいグループ名", { exact: false }).fill("JavaScriptなしの部署");
    await page.getByRole("button", { name: "グループを作成", exact: true }).click();
    await expect(page.getByRole("heading", { name: "JavaScriptなしの部署", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath("workspace-320.png") });
    const hydrated = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 320, height: 740 } });
    try { const check = await hydrated.newPage(); await check.goto(page.url()); expect((await new AxeBuilder({ page: check }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); }
    finally { await hydrated.close(); }
  } finally { await context.close(); }
});


test("uncertain workspace and invitation acceptance reuse the same form key without another record", async ({ page }) => {
  await login(page, "alice", origin, false);
  await page.getByLabel("ワークスペース名", { exact: false }).fill("受付結果が不明な会社");
  const key = await page.locator('input[name="key"]').inputValue();
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("受付結果を確認できませんでした");
  await expect(page.locator('input[name="key"]')).toHaveValue(key);
  await expect(page.getByLabel("ワークスペース名", { exact: false })).toHaveValue("受付結果が不明な会社");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("受付結果が不明な会社");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "招待リンクを発行", exact: true }) });
  const inviteKey = await form.locator('input[name="key"]').inputValue();
  await page.getByLabel("招待先メールアドレス", { exact: false }).fill("uncertain@example.test");
  await page.getByRole("button", { name: "招待リンクを発行", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("受付結果を確認できませんでした");
  await expect(form.locator('input[name="key"]')).toHaveValue(inviteKey);
  await expect(page.getByLabel("招待先メールアドレス", { exact: false })).toHaveValue("uncertain@example.test");
  await page.getByRole("button", { name: "招待リンクを発行", exact: true }).click();
  await expect(page.getByText("発行済みのリンクは再表示できません。必要なら取り消して再発行してください。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("今回発行した招待リンク")).toHaveCount(0);
  await expect(page.getByText("uncertain@example.test", { exact: true })).toHaveCount(1);
  await page.goto("/workspaces"); await expect(page.getByText("所有中：1 / 50")).toBeVisible();
});

for (const javaScriptEnabled of [true, false]) {
  test(`overlong organization input is preserved with a 400 error (JavaScript ${javaScriptEnabled})`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, permissions: ["clipboard-read", "clipboard-write"] });
    const longName = "N".repeat(101), longEmail = `${"a".repeat(250)}@example.test`;
    try {
      const page = await context.newPage(); await login(page, "alice", origin, false);
      async function paste(label: string, value: string, container: Page | Locator = page) {
        const field = container.getByLabel(label, { exact: false });
        await page.evaluate((text) => navigator.clipboard.writeText(text), value);
        await field.focus(); await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        await expect(field).toHaveValue(value);
      }
      async function rejected(button: string) {
        const response = page.waitForResponse((value) => value.request().method() === "POST" && new URL(value.url()).pathname.startsWith("/workspaces"));
        await page.getByRole("button", { name: button, exact: true }).click();
        expect((await response).status()).toBe(400);
        await expect(page.getByRole("alert")).toBeVisible();
      }
      await paste("ワークスペース名", longName); await rejected("作成する");
      await expect(page.getByLabel("ワークスペース名", { exact: false })).toHaveValue(longName);
      await page.getByLabel("ワークスペース名", { exact: false }).fill("入力検証の会社");
      await page.getByRole("button", { name: "作成する", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("入力検証の会社");
      await paste("新しいグループ名", longName); await rejected("グループを作成");
      await expect(page.getByLabel("新しいグループ名", { exact: false })).toHaveValue(longName);
      await page.getByLabel("新しいグループ名", { exact: false }).fill("検証グループ");
      await page.getByRole("button", { name: "グループを作成", exact: true }).click();
      const group = page.getByTestId("workspace-group");
      await expect(group.getByRole("heading", { name: "検証グループ", exact: true })).toBeVisible();
      await group.getByLabel("グループ名", { exact: false }).fill("");
      await paste("グループ名", longName, group); await rejected("グループ名を保存");
      await expect(group.getByLabel("グループ名", { exact: false })).toHaveValue(longName);
      await page.getByLabel("ワークスペース名", { exact: false }).fill("");
      await paste("ワークスペース名", longName); await rejected("名前を保存");
      await expect(page.getByLabel("ワークスペース名", { exact: false })).toHaveValue(longName);
      await paste("招待先メールアドレス", longEmail); await rejected("招待リンクを発行");
      await expect(page.getByLabel("招待先メールアドレス", { exact: false })).toHaveValue(longEmail);
      await expect(page.getByRole("alert")).toContainText("254文字以内");
    } finally { await context.close(); }
  });
}

for (const javaScriptEnabled of [true, false]) {
  test(`ownership transfer needs recipient consent and preserves private data (JavaScript ${javaScriptEnabled})`, async ({ browser }, testInfo) => {
    const aliceContext = await browser.newContext({ javaScriptEnabled, viewport: { width: 320, height: 740 } });
    const bobContext = await browser.newContext({ javaScriptEnabled, viewport: { width: 320, height: 740 } });
    try {
      const alice = await aliceContext.newPage(), bob = await bobContext.newPage();
      await login(alice); const id = await manage(alice), workspaceUrl = alice.url();
      const invitation = await invite(alice, "bob@example.test");
      await login(bob, "bob", origin, false); await join(bob, invitation); await alice.reload();
      const bobMember = alice.getByTestId("workspace-member").filter({ hasText: "bob@example.test" });
      await bobMember.getByLabel("管理者", { exact: true }).check();
      await bobMember.getByLabel("開発者", { exact: true }).check();
      await bobMember.getByRole("button", { name: "メンバーの設定を保存", exact: true }).click();
      await expect(bobMember).toContainText("操作権限：管理者 ／ 業務ロール：開発者");
      await alice.getByLabel("新しいグループ名", { exact: false }).fill("譲渡後も残るグループ");
      await alice.getByRole("button", { name: "グループを作成", exact: true }).click();
      const group = alice.getByTestId("workspace-group");
      await group.getByLabel("bob@example.test", { exact: true }).check();
      await group.getByRole("button", { name: /参加を保存.*bob@example.test/ }).click();
      let privateUrl: string | null = null;
      if (javaScriptEnabled) { await alice.goto(`${origin}/?workspace=${id}`); await send(alice, "所有権を譲渡しても共有されない会話"); privateUrl = alice.url(); await alice.goto(workspaceUrl); }
      const csrf = await alice.locator('input[name="csrf"]').first().inputValue();
      const aliceMember = alice.getByTestId("workspace-member").filter({ hasText: "alice@example.test" });
      const aliceId = await aliceMember.locator('input[name="user_id"]').first().inputValue();
      await expect(aliceMember.getByLabel("一般メンバー", { exact: true })).toBeDisabled();
      await expect(alice.getByText("所有者は退出できません。", { exact: false })).toBeVisible();
      for (const form of [{ intent: "leave", confirm: "yes" }, { intent: "member", user_id: aliceId, access_level: "member", business_role: "general" }, { intent: "remove_member", user_id: aliceId, confirm: "yes" }] as Array<Record<string, string>>) {
        const response = await alice.request.post(workspaceUrl, { headers: { origin }, form: { csrf, ...form } });
        expect(response.status()).toBe(409); expect(await response.text()).toContain("先に所有権を譲渡");
      }
      await bob.reload();
      const bobCsrf = await bob.locator('input[name="csrf"]').first().inputValue();
      const forged = await bob.request.post(workspaceUrl, { headers: { origin }, form: { csrf: bobCsrf, intent: "propose_ownership", key: randomUUID(), to_user_id: aliceId } });
      expect(forged.status()).toBe(403);
      await propose(alice, "bob@example.test");
      await alice.getByRole("button", { name: "譲渡申請を取り消す", exact: true }).click();
      await expect(alice.getByText("譲渡申請を取り消しました。", { exact: true })).toBeVisible();
      await bob.reload(); await expect(bob.getByTestId("ownership-transfer")).toHaveCount(0);
      await propose(alice, "bob@example.test"); await bob.reload();
      await bob.getByRole("button", { name: "譲渡を辞退する", exact: true }).click();
      await expect(bob.getByText("譲渡を辞退しました。", { exact: true })).toBeVisible();
      await alice.reload(); await propose(alice, "bob@example.test");
      const transferId = await alice.getByTestId("ownership-transfer").locator('input[name="transfer_id"]').inputValue();
      const wrongRecipient = await alice.request.post(workspaceUrl, { headers: { origin }, form: { csrf, intent: "respond_ownership", transfer_id: transferId, ownership_action: "accept", confirm: "yes" } });
      expect(wrongRecipient.status()).toBe(403);
      const invalidCsrf = await bob.request.post(workspaceUrl, { headers: { origin }, form: { csrf: "wrong", intent: "respond_ownership", transfer_id: transferId, ownership_action: "accept", confirm: "yes" } });
      expect(invalidCsrf.status()).toBe(403);
      await bob.reload();
      expect(await bob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await bob.getByTestId("ownership-transfer").scrollIntoViewIfNeeded();
      await bob.screenshot({ path: testInfo.outputPath("ownership-320.png") });
      if (javaScriptEnabled) expect((await new AxeBuilder({ page: bob }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await acceptOwnership(bob); await expect(bob.getByText("所有権を受け取りました。", { exact: true })).toBeVisible();
      await expect(bob.getByText("所有者：bob@example.test（あなた）", { exact: true })).toBeVisible();
      await expect(bob.getByTestId("workspace-member").filter({ hasText: "bob@example.test" })).toContainText("業務ロール：開発者");
      await expect(bob.getByTestId("workspace-group").getByLabel("bob@example.test", { exact: true })).toBeChecked();
      const replay = await bob.request.post(workspaceUrl, { headers: { origin }, form: { csrf: bobCsrf, intent: "respond_ownership", transfer_id: transferId, ownership_action: "accept", confirm: "yes" } });
      expect(replay.status()).toBe(200);
      if (privateUrl) { await bob.goto(privateUrl); expect(await bob.content()).not.toContain("所有権を譲渡しても共有されない会話"); await expect(bob.getByLabel("あなたのメッセージ")).toHaveCount(0); }
      await bob.goto(`${origin}/workspaces`); await expect(bob.getByText("所有中：1 / 50")).toBeVisible();
      await alice.goto(`${origin}/workspaces`); await expect(alice.getByText("所有中：0 / 50")).toBeVisible();
      await alice.goto(workspaceUrl); await alice.getByText("退出の確認を開く", { exact: true }).click();
      await alice.getByLabel("退出することを確認しました", { exact: true }).check();
      await alice.getByRole("button", { name: "ワークスペースから退出する", exact: true }).click();
      await expect(alice).toHaveURL(`${origin}/workspaces`); expect((await alice.request.get(workspaceUrl)).status()).toBe(404);
    } finally { await aliceContext.close(); await bobContext.close(); }
  });
}

test("joining is unlimited at fifty owned workspaces; transfer returns a slot for acceptance", async ({ page: alice, browser }) => {
  await login(alice); const id = await manage(alice), aliceWorkspace = alice.url();
  const invitation = await invite(alice, "bob@example.test");
  const context = await browser.newContext();
  try {
    const bob = await context.newPage(); await login(bob, "bob", origin, false);
    const [bobWorkspace] = await seedOwned("bob", 50);
    await bob.reload(); await expect(bob.getByText("所有中：50 / 50")).toBeVisible();
    await join(bob, invitation); await expect(bob).toHaveURL(aliceWorkspace);
    await alice.reload(); await propose(alice, "bob@example.test");
    await bob.reload(); await acceptOwnership(bob);
    await expect(bob.getByRole("alert")).toContainText("所有できるワークスペースは50個まで");
    await expect(bob.getByText("所有者：alice@example.test", { exact: true })).toBeVisible();
    await bob.goto(`${origin}/workspaces/${bobWorkspace}`);
    const reverseInvitation = await invite(bob, "alice@example.test");
    await join(alice, reverseInvitation); await bob.reload(); await propose(bob, "alice@example.test");
    await alice.reload(); await acceptOwnership(alice);
    await expect(alice.getByText("所有権を受け取りました。", { exact: true })).toBeVisible();
    await bob.goto(`${origin}/workspaces`); await expect(bob.getByText("所有中：49 / 50")).toBeVisible();
    await bob.goto(aliceWorkspace); await acceptOwnership(bob);
    await expect(bob.getByText("所有権を受け取りました。", { exact: true })).toBeVisible();
    await bob.goto(`${origin}/workspaces`); await expect(bob.getByText("所有中：50 / 50")).toBeVisible();
    await alice.goto(`${origin}/workspaces`); await expect(alice.getByText("所有中：1 / 50")).toBeVisible();
  } finally { await context.close(); }
});
