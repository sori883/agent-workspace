import { runInputSchema, type ArtifactResult, type RecoverResult, type RunDetail, type RunErrorStatus, type RunInput, type RunList, type SubmitResult } from "../shared/run-contracts";
import type { DataRepository } from "../data/repository";

export class RunServiceError extends Error {
  constructor(public readonly code: string, public readonly status: RunErrorStatus = 503) { super(code); }
}
export interface RunService {
  submit(ownerUserId: string, input: RunInput, workspace?: string | null): Promise<SubmitResult>;
  list(ownerUserId: string, workspace?: string | null): Promise<RunList>;
  get(ownerUserId: string, runId: string, workspace?: string | null): Promise<RunDetail>;
  artifact(ownerUserId: string, runId: string, workspace?: string | null): Promise<ArtifactResult>;
  recover(ownerUserId: string, runId: string, workspace?: string | null): Promise<RecoverResult>;
}
export function postgresRunService(repository: DataRepository): RunService {
  return {
    submit(owner, input, workspace) {
      const parsed = runInputSchema.safeParse(input);
      if (!parsed.success) throw new RunServiceError("invalid_request", 400);
      return repository.submit(owner, parsed.data, workspace);
    },
    list: (owner, workspace) => repository.list(owner, workspace),
    get: (owner, id, workspace) => repository.get(owner, id, workspace),
    artifact: (owner, id, workspace) => repository.artifact(owner, id, workspace),
    recover: (owner, id, workspace) => repository.recover(owner, id, workspace),
  };
}
