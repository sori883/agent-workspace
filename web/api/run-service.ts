import { runInputSchema, type ArtifactResult, type RecoverResult, type RunDetail, type RunErrorStatus, type RunInput, type RunList, type SubmitResult } from "../shared/run-contracts";
import type { DataRepository } from "../data/repository";

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
export function postgresRunService(repository: DataRepository): RunService {
  return {
    submit(owner, input) {
      const parsed = runInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      return repository.submit(owner, parsed.data);
    },
    list: (owner) => repository.list(owner),
    get: (owner, id) => repository.get(owner, id),
    artifact: (owner, id) => repository.artifact(owner, id),
    recover: (owner, id) => repository.recover(owner, id),
  };
}
