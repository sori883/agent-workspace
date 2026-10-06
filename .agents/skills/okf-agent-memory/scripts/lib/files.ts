import { link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const hasCode = (error: unknown, code: string) => error !== null && typeof error === "object" && "code" in error && error.code === code;
export async function rootPath(path: string, create = false): Promise<string> {
  if (create) await mkdir(resolve(path), { recursive: true });
  const root = await realpath(resolve(path));
  if (!(await lstat(root)).isDirectory()) throw new Error(`Not a bundle directory: ${path}`);
  return root;
}
export function conceptID(input: string): string {
  const id = input.trim().replace(/\.md$/, "");
  const parts = id.split("/");
  if (!id || /[\p{Cc}\p{Cf}\\:]/u.test(id) || parts.length > 8 || parts.some(part => !part || part.startsWith(".") || part.startsWith("-"))) throw new Error("Concept ID must be a relative path without traversal, hidden entries or control characters (maximum depth 8).");
  if (["index", "log"].includes(parts.at(-1)!.toLowerCase()) || id.toLowerCase() === "agents") throw new Error("Reserved concept ID.");
  return id;
}
export async function safePath(root: string, relative: string, createParents = false): Promise<string> {
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || relative.includes("\\") || relative.includes("\0")) throw new Error("Invalid bundle-relative path.");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (i === parts.length - 1 || !createParents) continue;
      await mkdir(current).catch(error => { if (!hasCode(error, "EEXIST")) throw error; });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlinks inside a bundle are not supported: ${relative}`);
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Unexpected file type: ${relative}`);
  }
  return current;
}
export async function optionalRead(root: string, relative: string): Promise<string | undefined> {
  const path = await safePath(root, relative);
  try { return await readFile(path, "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}
export interface FileChange { relative: string; before?: string; after: string }
export interface FileDeletion { relative: string; before: string; after: null }
export class WriteError extends Error {
  constructor(cause: unknown, public readonly writtenPaths: string[]) {
    super(`${cause instanceof Error ? cause.message : String(cause)}; files already written: ${writtenPaths.join(", ") || "none"}`, { cause });
  }
}

// Preflight every path before any file changes. Each replacement is atomic; the
// group is not a crash-proof transaction. Callers must report partial failures.
export async function applyChanges(root: string, changes: (FileChange | FileDeletion)[]): Promise<void> {
  const writtenPaths: string[] = [];
  try {
    for (const change of changes) {
      if (await optionalRead(root, change.relative) !== change.before) throw new Error(`File changed during operation: ${change.relative}`);
    }
    for (const change of changes) {
      if (change.before === change.after) continue;
      const target = await safePath(root, change.relative, change.after !== null);
      if (change.after === null) {
        if (await optionalRead(root, change.relative) !== change.before) throw new Error(`File changed during operation: ${change.relative}`);
        await unlink(target);
        writtenPaths.push(change.relative);
        continue;
      }
      const temporary = join(dirname(target), `.okf-${crypto.randomUUID()}.tmp`);
      try {
        const mode = change.before === undefined ? 0o644 : (await lstat(target)).mode & 0o777;
        const file = await open(temporary, "wx", mode);
        try { await file.writeFile(change.after); await file.sync(); }
        finally { await file.close(); }
        if (change.before === undefined) await link(temporary, target);
        else {
          if (await optionalRead(root, change.relative) !== change.before) throw new Error(`File changed during operation: ${change.relative}`);
          await rename(temporary, target);
        }
        writtenPaths.push(change.relative);
      } finally { await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; }); }
    }
  } catch (error) { throw new WriteError(error, writtenPaths); }
}
export async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(root, ".okf-write-lock");
  try { await mkdir(lock); }
  catch (error) { if (hasCode(error, "EEXIST")) throw new Error("Another mutation owns .okf-write-lock; retry after it completes."); throw error; }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true }); }
}
