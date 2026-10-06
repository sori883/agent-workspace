import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function bootstrap(directory = import.meta.dir): Promise<boolean> {
  const directoryModules = join(directory, "node_modules");
  const marker = join(directoryModules, ".orch-bootstrap.json");
  const lock = join(directoryModules, ".orch-bootstrap.lock");
  const packageText = await readFile(join(directory, "package.json"));
  const manifest = JSON.parse(packageText.toString());
  const hasDependencies = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(key => Object.keys(manifest[key] ?? {}).length > 0);
  const lockText = hasDependencies ? await readFile(join(directory, "bun.lock")) : Buffer.alloc(0);
  const digest = createHash("sha256").update(packageText).update(lockText).update(Bun.version).digest("hex");
  const ready = async () => {
    try {
      if (JSON.parse(await readFile(marker, "utf8")).digest !== digest) return false;
      await Promise.all(Object.keys(manifest.dependencies ?? {}).map(name => access(join(directoryModules, name, "package.json"))));
      return true;
    } catch { return false; }
  };
  if (await ready()) return false;
  await mkdir(directoryModules, { recursive: true });
  let handle;
  for (let tries = 0; tries < 100; tries++) {
    try { handle = await open(lock, "wx"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (await ready()) return true; await Bun.sleep(50); }
  }
  if (!handle) throw new Error("orch dependency bootstrap is locked; inspect scripts/node_modules/.orch-bootstrap.lock");
  const temporary = `${marker}.${crypto.randomUUID()}.tmp`;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    if (await ready()) return true;
    if (hasDependencies) {
      const processInstall = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([processInstall.exited, new Response(processInstall.stdout).text(), new Response(processInstall.stderr).text()]);
      if (code !== 0) throw new Error(`orch dependency installation failed (${code}): ${err || out}`);
    }
    await writeFile(temporary, JSON.stringify({ digest, bunVersion: Bun.version }) + "\n", { flag: "wx" }); await rename(temporary, marker);
    return true;
  } finally { await rm(temporary, { force: true }); await handle.close(); await rm(lock, { force: true }); }
}
