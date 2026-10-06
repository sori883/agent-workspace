import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

async function assertIndependentWorkspace(directory: string): Promise<void> {
  for (let parent = dirname(resolve(directory)); ; parent = dirname(parent)) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(parent, "package.json"), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const patterns: unknown = Array.isArray(manifest?.workspaces) ? manifest.workspaces : manifest?.workspaces?.packages;
    if (Array.isArray(patterns)) {
      const includes = patterns.filter((value): value is string => typeof value === "string" && !value.startsWith("!"));
      const excludes = patterns.filter((value): value is string => typeof value === "string" && value.startsWith("!"));
      for (let candidate = resolve(directory); candidate !== parent; candidate = dirname(candidate)) {
        const path = relative(parent, candidate).replaceAll("\\", "/");
        if (includes.some(pattern => new Bun.Glob(pattern.replace(/\/$/, "")).match(path)) && !excludes.some(pattern => new Bun.Glob(pattern.slice(1).replace(/\/$/, "")).match(path))) {
          throw new Error(`OKF scripts belongs to an ancestor workspace (${join(parent, "package.json")}); place this skill outside its workspace patterns before installing dependencies.`);
        }
      }
    }
    if (parent === dirname(parent)) return;
  }
}

export async function bootstrap(directory = import.meta.dir): Promise<boolean> {
  const directoryModules = join(directory, "node_modules");
  const marker = join(directoryModules, ".okf-bootstrap.json");
  const lock = join(directoryModules, ".okf-bootstrap.lock");
  const packageText = await readFile(join(directory, "package.json"));
  const manifest = JSON.parse(packageText.toString());
  const lockText = await readFile(join(directory, "bun.lock"));
  const digest = createHash("sha256").update(packageText).update(lockText).update(Bun.version).digest("hex");
  const ready = async () => {
    try {
      if (JSON.parse(await readFile(marker, "utf8")).digest !== digest) return false;
      await Promise.all(Object.keys(manifest.dependencies ?? {}).map(name => access(join(directoryModules, name, "package.json"))));
      return true;
    } catch { return false; }
  };
  if (await ready()) return false;
  await assertIndependentWorkspace(directory);
  await mkdir(directoryModules, { recursive: true });
  let handle;
  for (let tries = 0; tries < 100; tries++) {
    try { handle = await open(lock, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await ready()) return true;
      await Bun.sleep(50);
    }
  }
  if (!handle) throw new Error("OKF dependency bootstrap is locked; inspect scripts/node_modules/.okf-bootstrap.lock");
  const temporary = `${marker}.${crypto.randomUUID()}.tmp`;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    if (await ready()) return true;
    const installation = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([installation.exited, new Response(installation.stdout).text(), new Response(installation.stderr).text()]);
    if (code !== 0) throw new Error(`OKF dependency installation failed (${code}): ${stderr || stdout}`);
    await Promise.all(Object.keys(manifest.dependencies ?? {}).map(name => access(join(directoryModules, name, "package.json"))));
    await writeFile(temporary, JSON.stringify({ digest, bunVersion: Bun.version }) + "\n", { flag: "wx" });
    await rename(temporary, marker);
    return true;
  } finally {
    await rm(temporary, { force: true });
    await handle.close();
    await rm(lock, { force: true });
  }
}
