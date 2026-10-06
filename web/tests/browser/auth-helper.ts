import { expect, type Page } from "@playwright/test";

export async function login(page: Page, user: "alice" | "bob" = "alice", baseUrl = "http://127.0.0.1:3210") {
  await page.goto(`${baseUrl}/login`);
  await page.getByRole("button", { name: "ログインへ進む", exact: true }).click();
  await page.getByRole("button", { name: user === "alice" ? "Aliceでログイン" : "Bobでログイン", exact: true }).click();
  await expect(page).toHaveURL((url) => url.origin === baseUrl && url.pathname === "/");
  await expect(page.getByLabel("メッセージ", { exact: true })).toBeVisible();
}
