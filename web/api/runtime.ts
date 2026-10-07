import { AgentRepository } from "../data/agents";
import { postgresAgentService } from "./agent-service";
import { WorkspaceRepository } from "../data/workspaces";
import { postgresWorkspaceService } from "./workspace-service";
import { createApi } from "./app";
import { postgresRunService } from "./run-service";
import { postgresChatService } from "./chat-service";
import { DataRepository } from "../data/repository";
import type { Database } from "../data/db";
import { createAuthenticator } from "../shared/access-token";
import { AuthenticationError } from "../shared/authentication";
import type { ApiApplicationSettings } from "./settings";

export function createRuntime(settings: ApiApplicationSettings, database: Database) {
  const repository = new DataRepository(database, { image: settings.image });
  const authenticate = createAuthenticator(settings.identity, async (issuer, subject) => {
    const { rows } = await database.query<{ id: string }>("SELECT u.id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2 AND u.status='active'", [issuer, subject]);
    if (rows.length !== 1) throw new AuthenticationError("unknown_identity");
    return rows[0]!.id;
  });
  return createApi(settings, undefined, postgresRunService(repository), postgresChatService(repository), authenticate, postgresWorkspaceService(new WorkspaceRepository(database)), postgresAgentService(new AgentRepository(database, settings.image)));
}
