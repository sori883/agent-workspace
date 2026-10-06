import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { OrchError, type State } from "./model.ts";
import { validateState } from "./validation.ts";

export async function load(store: string): Promise<State> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(store, "state.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OrchError("NOT_INITIALIZED", "Initialize this store explicitly first");
    throw new OrchError("CORRUPT_STATE", "Cannot read a valid state.json");
  }
  validateState(value); return value;
}

export async function writeTransaction<T>(store: string, action: () => Promise<{ state: State; result: T; unchanged?: boolean }>, options: { initialize?: boolean; beforeReplace?: () => Promise<void> } = {}): Promise<T> {
  if (options.initialize) await mkdir(store, { recursive: true });
  const lockPath = join(store, ".orch.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new OrchError("LOCKED", "Store is locked; inspect with doctor", 3);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OrchError("NOT_INITIALIZED", "Initialize this store explicitly first");
    throw error;
  }
  const temporary = join(store, `.state-${crypto.randomUUID()}.tmp`);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: crypto.randomUUID(), createdAt: new Date().toISOString() })); await lock.sync();
    const { state, result, unchanged } = await action();
    if (unchanged) return result;
    validateState(state);
    const file = await open(temporary, "wx");
    try { await file.writeFile(JSON.stringify(state, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
    await options.beforeReplace?.();
    await rename(temporary, join(store, "state.json"));
    const directory = await open(store, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return result;
  } finally {
    await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true });
  }
}
