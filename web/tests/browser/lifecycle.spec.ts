import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { login } from "./auth-helper";
import { test, expect } from "@playwright/test";

function launch(mode: "dev" | "start", port: number) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run.ts", mode], {
    env: { ...process.env, WEB_PORT: String(port), API_PORT: String(port + 1), API_CONFIG_FILE: process.env.AUTH_CONFIG_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
async function expectPortClosed(port: number) {
  await expect.poll(async () => {
    try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); return false; }
    catch { return true; }
  }).toBe(true);
}

test("development startup, API failure display, no automatic resend, and owned-child cleanup", async ({ page }) => {
  const { child, output } = launch("dev", 3230);
  try {
    await expect.poll(output, { timeout: 20000 }).toContain("AX workspace ready:");
    await login(page, "alice", "http://127.0.0.1:3230", false);
    await page.goto("http://127.0.0.1:3230/connection");
    await page.getByLabel("確認用のメッセージ").fill("停止後にも保持する入力");
    await expect(page.locator("#message-count")).toHaveText("11 / 200");
    const apiPid = Number(output().match(/API ready.*\(pid (\d+)\)/)?.[1]);
    expect(apiPid).toBeGreaterThan(0);
    process.kill(apiPid, "SIGTERM");
    await expectPortClosed(3231);
    await page.getByRole("button", { name: "送信して接続を確認" }).click();
    await expect(page.getByRole("heading", { name: "送信を完了できませんでした" })).toBeVisible();
    await expect(page.getByLabel("確認用のメッセージ")).toHaveValue("停止後にも保持する入力");
    await expect(page.getByText("接続先を確認できません", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "送信して接続を確認" })).toBeEnabled();
    expect(output()).not.toContain('"event":"connection-check"');
    expect(child.exitCode).toBeNull();
  } finally {
    await stop(child);
  }
  await expectPortClosed(3230);
  await expectPortClosed(3231);
});

for (const mode of ["dev", "start"] as const) {
  test(`${mode} startup failure preserves an occupied port and cleans up its API`, async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    occupied.listen(3240, "127.0.0.1");
    await once(occupied, "listening");
    const { child, output } = launch(mode, 3240);
    try {
      await expect.poll(() => child.exitCode, { timeout: 20000 }).toBe(1);
      expect(await (await fetch("http://127.0.0.1:3240")).text()).toBe("occupied");
      await expectPortClosed(3241);
    } finally {
      await stop(child);
      occupied.closeAllConnections();
      occupied.close();
    }
    expect(output()).not.toContain("AX workspace ready:");
  });
}
