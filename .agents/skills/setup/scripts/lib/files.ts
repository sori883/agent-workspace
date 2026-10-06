import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { SetupError } from "./model.ts";

export const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export function relativePath(value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes("\0") || value.split("/").some(p => !p || p === "." || p === "..")) throw new SetupError("INVALID_PATH", `Invalid relative path: ${String(value)}`);
  return value;
}
export async function safePath(root: string, relative: string): Promise<string> {
  relativePath(relative); let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new SetupError("SYMLINK", `Refusing symlink: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}
export async function readOptional(root: string, relative: string): Promise<Buffer | null> {
  const path = await safePath(root, relative);
  try { const stat = await lstat(path); if (!stat.isFile()) throw new SetupError("INVALID_FILE", `Not a regular file: ${path}`); return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function safeMkdir(root: string, relative: string): Promise<void> {
  relativePath(relative); let current = root;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(current); if (stat.isSymbolicLink()) throw new SetupError("SYMLINK", `Refusing symlink: ${current}`);
    if (!stat.isDirectory()) throw new SetupError("INVALID_DIRECTORY", `Not a directory: ${current}`);
  }
}
export async function atomicWrite(root: string, relative: string, content: Buffer): Promise<void> {
  await safePath(root, relative);
  if (dirname(relative) !== ".") await safeMkdir(root, dirname(relative));
  const path = await safePath(root, relative), temporary = `${path}.${randomUUID()}.tmp`;
  let mode = 0o644;
  try { mode = (await lstat(path)).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(content); await handle.sync(); await handle.close(); await safePath(root, relative); await rename(temporary, path); }
  finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
