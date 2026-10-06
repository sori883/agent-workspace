#!/usr/bin/env bun
import { bootstrap } from "./bootstrap.ts";
import { fileURLToPath } from "node:url";

try {
  await bootstrap();
  const child = Bun.spawn([process.execPath, "--no-install", fileURLToPath(new URL("./run.ts", import.meta.url)), ...process.argv.slice(2)], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
} catch (error) {
  const result = { ok: false, error: { code: "BOOTSTRAP_FAILED", message: error instanceof Error ? error.message : String(error) } };
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(result) + "\n"); else process.stderr.write(result.error.message + "\n");
  process.exitCode = 1;
}
