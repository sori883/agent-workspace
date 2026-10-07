import type { AgentRepository } from "../data/agents";
export type AgentService = Pick<AgentRepository,"list"|"get"|"start"|"answer"|"stop"|"revoke">;
export function postgresAgentService(repository:AgentRepository):AgentService{return repository;}
