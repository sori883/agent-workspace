import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_CHAT_RESPONSE_BYTES } from "../shared/chat-contracts";
import { artifactResultSchema, bridgeErrorSchema, MAX_RUN_REQUEST_BYTES, MAX_RUN_RESPONSE_BYTES, recoverResultSchema, runDetailSchema, runIdSchema, runInputSchema, runListSchema, submitResultSchema, type ArtifactResult, type RecoverResult, type RunDetail, type RunErrorStatus, type RunInput, type RunList, type SubmitResult } from "../shared/run-contracts";

export class RunServiceError extends Error {
  constructor(public readonly code: string, public readonly status: RunErrorStatus = 503) { super(code); }
}

export interface RunService {
  submit(ownerUserId: string, input: RunInput): Promise<SubmitResult>;
  list(ownerUserId: string): Promise<RunList>;
  get(ownerUserId: string, runId: string): Promise<RunDetail>;
  artifact(ownerUserId: string, runId: string): Promise<ArtifactResult>;
  recover(ownerUserId: string, runId: string): Promise<RecoverResult>;
}

type Operation = "submit" | "list" | "get" | "artifact" | "recover" | "conversations" | "conversation" | "chat";
export type BridgeInvoke = (operation: Operation, input: unknown) => Promise<unknown>;
type SpawnBridge = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ReturnType<typeof spawn>;
const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("../../ax-local/web_bridge.py", import.meta.url));

export async function invokeBridge(operation: Operation, input: unknown, launch: SpawnBridge = spawn, timeoutMs = 5000): Promise<unknown> {
  const payload = JSON.stringify(input);
  const maxBytes = ["conversations", "conversation", "chat"].includes(operation) ? MAX_CHAT_RESPONSE_BYTES : MAX_RUN_RESPONSE_BYTES;
  if (Buffer.byteLength(payload) > MAX_RUN_REQUEST_BYTES) throw new RunServiceError("body_too_large", 413);
  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnBridge>;
    try { child = launch("python3", [script, operation], { cwd: root, stdio: "pipe", windowsHide: true }); }
    catch { reject(new RunServiceError("bridge_unavailable")); return; }
    let complete = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (code: string) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new RunServiceError(code));
    };
    const timer = setTimeout(() => fail("bridge_timeout"), Math.min(timeoutMs, 5000));
    child.on("error", () => fail("bridge_unavailable"));
    child.stdin?.on("error", () => fail("bridge_unavailable"));
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail("invalid_bridge_response");
      else chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail("invalid_bridge_response");
    });
    child.on("close", (code) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (code !== 0 && !bridgeErrorSchema.safeParse(value).success) throw new Error();
        resolve(value);
      } catch { reject(new RunServiceError("invalid_bridge_response")); }
    });
    child.stdin?.end(payload);
  });
}

export async function bridgeRequest<T>(operation: Operation, input: unknown, schema: z.ZodType<T>, invoke: BridgeInvoke = invokeBridge): Promise<T> {
  let value: unknown;
  try { value = await invoke(operation, input); }
  catch (error) {
    if (error instanceof RunServiceError) throw error;
    throw new RunServiceError("bridge_unavailable");
  }
  const error = bridgeErrorSchema.safeParse(value);
  if (error.success) throw new RunServiceError(error.data.error.code, error.data.error.status);
  const result = z.object({ ok: z.literal(true), data: schema }).strict().safeParse(value);
  if (!result.success) throw new RunServiceError("invalid_bridge_response");
  return result.data.data;
}

export function pythonRunService(invoke: BridgeInvoke = invokeBridge): RunService {
  const command = <T>(ownerUserId: string, operation: Operation, input: unknown, schema: z.ZodType<T>) => {
    const owner = z.uuid().safeParse(ownerUserId);
    if (!owner.success) throw new RunServiceError("invalid_owner_user_id", 400);
    return bridgeRequest(operation, { owner_user_id: owner.data.toLowerCase(), input }, schema, invoke);
  };
  function validId(runId: string) {
    if (!runIdSchema.safeParse(runId).success) throw new RunServiceError("invalid_run_id", 400);
    return { run_id: runId };
  }
  return {
    submit(ownerUserId, input) {
      const parsed = runInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      return command(ownerUserId, "submit", parsed.data, submitResultSchema);
    },
    list: (ownerUserId) => command(ownerUserId, "list", {}, runListSchema),
    get: (ownerUserId, runId) => command(ownerUserId, "get", validId(runId), runDetailSchema).then((detail) => {
      if (detail.summary.run_id !== runId) throw new RunServiceError("invalid_bridge_response");
      return detail;
    }),
    artifact: (ownerUserId, runId) => command(ownerUserId, "artifact", validId(runId), artifactResultSchema),
    recover: (ownerUserId, runId) => command(ownerUserId, "recover", validId(runId), recoverResultSchema).then((result) => {
      if (result.run_id !== runId) throw new RunServiceError("invalid_bridge_response");
      return result;
    }),
  };
}
