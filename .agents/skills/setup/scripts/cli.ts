import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runSetup } from "./lib/setup.ts";
import { isProduct, SetupError } from "./lib/model.ts";

export async function main(args = process.argv.slice(2)): Promise<number> {
  let compact = args.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: { project: { type: "string" }, product: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    compact = values.json ?? false;
    if (values.help) { console.log("Usage: bun <setup-skill>/scripts/setup.ts <plan|apply|status> --project <directory> [--product <codex|claude-code|copilot>] [--json]\nplan/status are read-only for the project. apply writes only declared files and managed instruction blocks.\nSetup data and setup-manifest.json are read from this skill's assets directory.\nThe product defaults to that manifest. Other products require their corresponding manifest in assets."); return 0; }
    const command = positionals[0];
    if (positionals.length !== 1 || !["plan", "apply", "status"].includes(command ?? "")) throw new SetupError("INPUT", "Specify exactly one command: plan, apply, or status");
    if (!values.project?.trim()) throw new SetupError("INPUT", "--project is required");
    if (values.product !== undefined && !isProduct(values.product)) throw new SetupError("INPUT", "--product must be codex, claude-code, or copilot");
    const data = await runSetup({ command: command as "plan" | "apply" | "status", project: resolve(values.project), pluginRoot: resolve(import.meta.dir, "../assets"), skillRoot: resolve(import.meta.dir, "../.."), product: values.product });
    console.log(JSON.stringify({ ok: true, data }, null, compact ? undefined : 2)); return 0;
  } catch (error) {
    const code = error instanceof SetupError ? error.code : (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") ? "INPUT" : error instanceof SyntaxError ? "INVALID_DATA" : "IO";
    console.log(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(error instanceof SetupError && error.details ? { details: error.details } : {}) } }, null, compact ? undefined : 2));
    return ["LOCKED", "CONFLICT", "PARTIAL"].includes(code) ? 3 : ["IO"].includes(code) ? 1 : 2;
  }
}
