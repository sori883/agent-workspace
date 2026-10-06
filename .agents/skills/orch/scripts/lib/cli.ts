import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { execute, READ_COMMANDS, WRITE_COMMANDS } from "./engine.ts";
import { OrchError, requireThat, type Request } from "./model.ts";
import { integer, object, str } from "./validation.ts";

const noId = new Set(["init", "export", "status", "doctor", "unit list", "unit counts", "unit ready", "ledger summary", "inbox list", "gate list"]);
const help = `orch — unit bookkeeping\n\nUsage: bun <orch>/scripts/task.ts [options] <command> [id] [stage]\n\n${[...WRITE_COMMANDS, ...READ_COMMANDS, "export"].map(c => `  ${c}${noId.has(c) ? "" : " <id>"}${c === "unit stage" ? " <stage>" : ""}`).join("\n")}\n\nOptions:\n  --store <dir>             Explicit store (or ORCH_STORE)\n  --actor <role> --session <id>\n  --operation-id <id>       Required for store mutations; reuse only on exact retry\n  --if-version <n> --attempt <n>\n  --input <file|->          JSON payload; '-' reads stdin\n  --project <dir>           init project\n  --on <unit>              dependency target\n  --submission <id>        accept/return submission\n  --state <value> --reason <text>\n  --parent <id> --owner <role> --track <name> --recipient <role>\n  --history                Include historical records on supported reads\n  --json                   Compact JSON output\n  --help\n\nRead references/cli.md for payloads and session handoff.\n`;

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      store: { type: "string" }, actor: { type: "string" }, session: { type: "string" }, "operation-id": { type: "string" }, "if-version": { type: "string" }, attempt: { type: "string" }, input: { type: "string" }, project: { type: "string" }, on: { type: "string" }, submission: { type: "string" }, state: { type: "string" }, reason: { type: "string" }, parent: { type: "string" }, owner: { type: "string" }, track: { type: "string" }, recipient: { type: "string" }, history: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
    } });
    if (values.help) { process.stdout.write(help); return 0; }
    const first = positionals[0]; const grouped = ["unit", "dependency", "ledger", "inbox", "gate"].includes(first ?? "");
    const length = grouped ? 2 : 1; const command = positionals.slice(0, length).join(" ");
    requireThat([...READ_COMMANDS, ...WRITE_COMMANDS, "export"].includes(command), "UNKNOWN_COMMAND", "Specify a supported command; use --help");
    const expected = length + (noId.has(command) ? 0 : 1) + (command === "unit stage" ? 1 : 0);
    requireThat(positionals.length === expected, "INVALID_INPUT", "Unexpected or missing positional arguments");
    let input: Record<string, unknown> = {};
    if (values.input) { const text = values.input === "-" ? await new Response(Bun.stdin.stream()).text() : await readFile(values.input, "utf8"); try { input = object(JSON.parse(text)); } catch { throw new OrchError("INVALID_INPUT", "Input must be a JSON object"); } }
    for (const name of ["project", "on", "submission", "state", "reason", "parent", "owner", "track", "recipient", "history"] as const) if (values[name] !== undefined) { requireThat(input[name] === undefined, "INVALID_INPUT", `Do not supply ${name} in both flags and input`); input[name] = values[name]; }
    const request: Request = { command, id: noId.has(command) ? undefined : positionals[length], stage: command === "unit stage" ? positionals[length + 1] : undefined, actor: values.actor, session: values.session, operationId: values["operation-id"], input };
    if (values["if-version"] !== undefined) request.ifVersion = integer(Number(values["if-version"]), "if-version");
    if (values.attempt !== undefined) request.attempt = integer(Number(values.attempt), "attempt");
    const result = await execute(str(values.store ?? process.env.ORCH_STORE, "--store or ORCH_STORE"), request);
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, json ? undefined : 2) + "\n"); return 0;
  } catch (error) {
    const known = error instanceof OrchError;
    const invalidArgs = typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
    const value = { code: known ? error.code : invalidArgs ? "INVALID_INPUT" : "IO_ERROR", message: error instanceof Error ? error.message : String(error) };
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: value }) + "\n"); else process.stderr.write(`${value.code}: ${value.message}\n`);
    return known ? error.exitCode : invalidArgs ? 2 : 1;
  }
}
