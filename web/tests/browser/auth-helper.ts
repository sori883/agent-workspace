import "./test-database";
import { expect, type Page } from "@playwright/test";
const selected = new WeakMap<Page, string>();
export function workspacePath(page: Page, path: string) {
  const url = new URL(path, new URL(page.url()).origin);
  const id = selected.get(page) ?? new URL(page.url()).searchParams.get("workspace");
  if (!id) throw new Error("Test workspace has not been selected");
  url.searchParams.set("workspace", id);
  return url.href;
}
export function artifactPath(path: string) { const url = new URL(path, "http://127.0.0.1:3210"); url.pathname += "/artifact"; return url.href; }
export async function login(page: Page, user: "alice" | "bob" = "alice", baseUrl = "http://127.0.0.1:3210", selectWorkspace = true) {
  await page.goto(`${baseUrl}/login`);
  await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
  await page.getByRole("button", { name: user === "alice" ? "Aliceでログイン" : "Bobでログイン", exact: true }).click();
  await expect(page).toHaveURL(`${baseUrl}/workspaces`);
  if (!selectWorkspace) return;
  const link = page.getByRole("link", { name: "チャットを開く", exact: true }).first();
  if (await link.count() === 0) {
    await page.getByLabel("ワークスペース名", { exact: false }).fill(`${user}のブラウザ試験`);
    await page.getByRole("button", { name: "作成する", exact: true }).click();
    await expect(page).toHaveURL(/\/workspaces\/[a-f0-9-]+$/);
  }
  const href = await link.getAttribute("href");
  const id = new URL(href!, baseUrl).searchParams.get("workspace")!;
  selected.set(page, id);
  await link.click();
  await expect(page.getByLabel("メッセージ", { exact: true })).toBeVisible();
}
