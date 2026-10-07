import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { WorkbenchService } from "../../api/workbench-service";
import { RunServiceError } from "../../api/run-service";
import { WorkbenchRepository } from "../../data/workbench";
import { FileRepository } from "../../data/files";

export async function workbenchFixture(pool: pg.Pool): Promise<WorkbenchService> {
  await pool.query("UPDATE ax_control SET accepting=true");
  await pool.query("CREATE TABLE ax_browser_workbench_faults(root_id uuid PRIMARY KEY)");
  await pool.query("UPDATE ax_workbench_control SET runtime_image=$1", [`localhost:5001/browser-fixture@sha256:${"a".repeat(64)}`]);
  const repository = new WorkbenchRepository(pool), files = new FileRepository(pool), controller = "browser-workbench-fixture";
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const call = async (name: string, args: unknown[]) => (await pool.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args)).rows[0].value;
  async function complete(runId: string, proposal: { kind: "question" | "output"; text: string }) {
    const claim = await call("ax_claim", [controller, 30]);
    if (claim?.run_id !== runId) throw new Error("Browser fixture claimed another run");
    const base = [runId, claim.generation, controller];
    async function effect(operation: string, evidence = { confirmed: true, actor: runId } as object) {
      const intent = await call("ax_intent", [...base, operation]);
      await call("ax_evidence", [...base, intent.operation_id, evidence]);
    }
    for (const op of ["create", "resume", "stage", "egress_prepare", "start"]) await effect(op);
    const usage = { prompt_token_count: 100, candidates_token_count: 20, thoughts_token_count: 0, total_token_count: 120, model_call_count: 1 };
    for (const sequence of [1, 2]) {
      const request = Buffer.from(JSON.stringify({ version: 2, run_id: runId, sequence, kind: sequence === 1 ? "model" : "tool", body: sequence === 1 ? {} : proposal }));
      await call("ax_agent_reserve", [...base, sequence, request]);
      const body = sequence === 1 ? { response: { candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 120 } } } : { accepted: true };
      await call("ax_agent_settle", [...base, sequence, { version: 2, run_id: runId, sequence, request_sha256: hash(request), status: "ok", body }, sequence === 1 ? usage : {}, 1, {}]);
    }
    await call("ax_collect", [...base, { schema_version: 2, run_id: runId, adapter: "interactive", status: "succeeded", exit_code: 0, error_type: null, summary: proposal.text, usage, estimated_usd: 0 }, null]);
    await effect("egress_deny", { egress_denied: true, actor: runId });
    await effect("suspend", { phase: "SUSPENDED", worker_assignment: null, actor: runId });
    await call("ax_finish", base);
  }
  return {
    list: repository.list.bind(repository), stop: repository.stop.bind(repository), recover: repository.recover.bind(repository),
    async get(owner, workspace, rootId) {
      const result = await repository.get(owner, workspace, rootId);
      if ((await pool.query("DELETE FROM ax_browser_workbench_faults WHERE root_id=$1 RETURNING root_id", [rootId])).rowCount) throw new RunServiceError("bridge_unavailable", 503);
      return result;
    },
    async start(owner, workspace, input, expires, fingerprint) {
      if (input.mode === "model") throw new RunServiceError("workbench_disabled", 503);
      const result = await repository.start(owner, workspace, input, expires, fingerprint);
      if (!result.replayed) await complete(result.run_id, { kind: "question", text: "集計する列を教えてください。" });
      return result;
    },
    async answer(owner, workspace, rootId, input, expires, fingerprint) {
      const result = await repository.answer(owner, workspace, rootId, input, expires, fingerprint);
      if (!result.replayed) {
        await complete(result.run_id, { kind: "output", text: `模擬応答を完了しました。回答：${input.text}` });
        if (input.text === "ブラウザ成果物の確認") {
          const bytes = Buffer.from("kind,total\nfixture,42\n");
          const file = (await files.begin(owner, workspace, { key: randomUUID(), name: "browser-fixture.csv", size_bytes: bytes.length, sha256: hash(bytes) })).file;
          await files.putChunk(owner, workspace, file.id, 0, bytes); await files.seal(owner, workspace, file.id);
          await pool.query("INSERT INTO ax_workbench_files VALUES($1,$2,$3,'output_fixture',$4,$5)", [rootId, owner, workspace, file.id, result.run_id]);
        }
      }
      return result;
    },
  };
}
