try {
  const { main } = await import("./lib/cli.ts");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ status: "error", error: message }) + "\n");
  else process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
