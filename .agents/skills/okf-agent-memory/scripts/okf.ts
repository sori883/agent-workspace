#!/usr/bin/env bun
import { bootstrap } from "./bootstrap.ts";
import { fileURLToPath } from "node:url";

export async function main(args: string[]): Promise<number> {
  try {
    await bootstrap();
    const child = Bun.spawn([process.execPath, "--no-install", fileURLToPath(new URL("./run.ts", import.meta.url)), ...args], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) process.stdout.write(JSON.stringify({ status: "error", error: message }) + "\n");
    else process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
