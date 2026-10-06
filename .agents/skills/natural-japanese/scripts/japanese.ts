#!/usr/bin/env bun
import { bootstrap } from "./bootstrap.ts";
import { fileURLToPath } from "node:url";

try {
  await bootstrap();
  const child = Bun.spawn([process.execPath, "--no-install", fileURLToPath(new URL("./run.ts", import.meta.url)), ...process.argv.slice(2)], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exit(await child.exited);
} catch (error) {
  process.stderr.write(`natural-japanese: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
