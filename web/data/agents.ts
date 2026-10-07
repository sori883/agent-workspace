import { z } from "zod";
import { agentAnswerSchema, agentListSchema, agentMutationSchema, agentRootSchema, agentStartSchema, agentSubmitSchema, type AgentAnswer, type AgentStart } from "../shared/agent-contracts";
import { RunServiceError } from "../api/run-service";
import type { Database } from "./db";
import { hex } from "./canonical";

export class AgentRepository {
  constructor(readonly database: Database, readonly image: string) {}
  private async call<T>(name: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      const {rows} = await this.database.query<{value:unknown}>(`SELECT ${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) AS value`,args);
      if (rows.length!==1) throw new Error();
      return schema.parse(rows[0].value);
    } catch(error) {
      if(error instanceof RunServiceError) throw error;
      if(error && typeof error === "object" && "code" in error && error.code==="P0001" && "message" in error && typeof error.message === "string") {
        const code=error.message;
        if(["agent_not_found","conversation_not_found","workspace_not_found"].includes(code)) throw new RunServiceError(code,404);
        if(["workspace_forbidden","workspace_access_revoked"].includes(code)) throw new RunServiceError(code,403);
        if(["invalid_request","invalid_owner_user_id"].includes(code)) throw new RunServiceError(code,400);
        if(["agent_grant_expired","agent_grant_revoked","agent_answer_conflict","agent_budget_exhausted","agent_stopped","idempotency_conflict","conversation_conflict","conversation_busy","unresolved_run","unknown_paid_usage","paid_failure_requires_review","pilot_estimate_limit_reached","invalid_conversation_state"].includes(code)) throw new RunServiceError(code,409);
      }
      throw new RunServiceError("bridge_unavailable");
    }
  }
  private id(value:string){const parsed=z.uuid().safeParse(value); if(!parsed.success) throw new RunServiceError("invalid_request",400); return parsed.data.toLowerCase();}
  private run(){return `ax-run-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;}
  list(owner:string,workspace:string){return this.call("ax_agent_list",[this.id(owner),this.id(workspace)],agentListSchema);}
  get(owner:string,workspace:string,root:string){return this.call("ax_agent_get",[this.id(owner),this.id(workspace),this.id(root)],agentRootSchema);}
  start(owner:string,workspace:string,input:AgentStart,expires:number,tokenFingerprint:string){return this.call("ax_agent_start",[this.id(owner),this.id(workspace),JSON.stringify(agentStartSchema.parse(input)),this.image,this.run(),expires,tokenFingerprint],agentSubmitSchema);}
  answer(owner:string,workspace:string,root:string,input:AgentAnswer,expires:number,tokenFingerprint:string){return this.call("ax_agent_answer",[this.id(owner),this.id(workspace),this.id(root),JSON.stringify(agentAnswerSchema.parse(input)),this.image,this.run(),expires,tokenFingerprint],agentSubmitSchema);}
  stop(owner:string,workspace:string,root:string){return this.call("ax_agent_stop",[this.id(owner),this.id(workspace),this.id(root)],agentMutationSchema);}
  revoke(owner:string,tokenFingerprint:string){return this.call("ax_agent_revoke",[this.id(owner),tokenFingerprint],agentMutationSchema);}
}
