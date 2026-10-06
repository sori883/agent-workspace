import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function bootstrap(directory = import.meta.dir): Promise<boolean> {
  const version = Bun.version.split(".").map(Number);
  if ((version[0] ?? 0) < 1 || version[0] === 1 && ((version[1] ?? 0) < 4 || version[1] === 4 && (version[2] ?? 0) < 2)) throw new Error("setup requires Bun 1.4.2 or later");
  const packageText = await readFile(join(directory, "package.json")), manifest = JSON.parse(packageText.toString());
  if (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(key => Object.keys(manifest[key] ?? {}).length)) throw new Error("This setup runtime expects no external dependencies");
  const modules = join(directory, "node_modules"), marker = join(modules, ".setup-bootstrap.json"), lockPath = join(modules, ".setup-bootstrap.lock");
  const digest = createHash("sha256").update(packageText).update(Bun.version).digest("hex");
  try { const stat = await lstat(modules); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("setup scripts/node_modules must be a local directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const ready = async () => { try { return JSON.parse(await readFile(marker, "utf8")).digest === digest; } catch { return false; } };
  if (await ready()) return false;
  await mkdir(modules, { recursive: true });
  let lock;
  for (let retry = 0; retry < 100; retry++) {
    try { lock = await open(lockPath, "wx"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (await ready()) return false; await Bun.sleep(50); }
  }
  if (!lock) throw new Error("setup bootstrap is locked; inspect scripts/node_modules/.setup-bootstrap.lock");
  const temporary = `${marker}.${crypto.randomUUID()}.tmp`;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    if (await ready()) return false;
    await writeFile(temporary, JSON.stringify({ digest, bunVersion: Bun.version }) + "\n", { flag: "wx" }); await rename(temporary, marker); return true;
  } finally { await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true }); }
}
