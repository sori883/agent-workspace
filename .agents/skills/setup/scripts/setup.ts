import { bootstrap } from "./bootstrap.ts";

try {
  if (await bootstrap()) {
    const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
  } else {
    const { main } = await import("./cli.ts"); process.exitCode = await main();
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: "BOOTSTRAP", message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 1;
}
