try {
  const { main } = await import("./lib/cli.ts");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const result = { ok: false, error: { code: "BOOTSTRAP_FAILED", message: error instanceof Error ? error.message : String(error) } };
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(result) + "\n"); else process.stderr.write(result.error.message + "\n");
  process.exitCode = 1;
}
