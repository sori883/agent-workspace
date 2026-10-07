import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {before,beforeEach,after,test} from "node:test";
import pg from "pg";
import {prepareTestAuth} from "./prepare-auth";
import {migrateData} from "../server/data-migrate";
import {AgentRepository} from "../data/agents";
import {DataRepository} from "../data/repository";
import {WorkspaceRepository} from "../data/workspaces";
import {sha256,utf8} from "../data/canonical";
import {createApi} from "../api/app";
import {postgresChatService} from "../api/chat-service";
import {postgresRunService} from "../api/run-service";

const schema=`agent_test_${randomBytes(8).toString("hex")}`;
const owner=randomUUID(), other=randomUUID(), controller="agent-test", image=`localhost:5001/runner@sha256:${"a".repeat(64)}`;
let pool:pg.Pool, admin:pg.Pool, agents:AgentRepository, data:DataRepository, workspace:string;
const call=async(name:string,args:unknown[]=[]) => (await pool.query(`SELECT ${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0].value;
const tokenHash="b".repeat(64);
const exp=()=>Math.floor(Date.now()/1000)+300;
const begin=()=>agents.start(owner,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"短い案内文"},exp(),tokenHash);
const error=(code:string)=>(e:unknown)=>e instanceof Error&&e.message===code;
const usage={prompt_token_count:100,candidates_token_count:20,thoughts_token_count:0,total_token_count:120,model_call_count:1};
const metadata={promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:0,totalTokenCount:120};
before(async()=>{
 const {caPath,...database}=prepareTestAuth().database;
 const options={...database,ssl:caPath?{ca:readFileSync(caPath,"utf8"),rejectUnauthorized:true}:false,max:10,statement_timeout:10000};
 admin=new pg.Pool(options);await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({...options,options:`-c search_path=${schema}`});
 await pool.query(readFileSync(new URL("../server/auth-schema.sql",import.meta.url),"utf8"));
 await pool.query(readFileSync(new URL("../server/auth-schema-v2.sql",import.meta.url),"utf8"));
 await migrateData(pool);
 await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','A'),($2,'active','B')",[owner,other]);
 workspace=(await new WorkspaceRepository(pool).create(owner,{key:randomUUID(),name:"Agent"})).workspace.id;
 await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[workspace,other]);
 agents=new AgentRepository(pool,image);data=new DataRepository(pool,{image});
});
beforeEach(async()=>{
 await pool.query("TRUNCATE ax_conversations,ax_runs,ax_agent_revocations CASCADE");
 await pool.query("INSERT INTO ax_execution_slot VALUES(true,NULL,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL,hold_reason=NULL");
 await pool.query("UPDATE ax_control SET accepting=true");
});
after(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
async function effect(c:any,operation:string){
 const op=await call("ax_intent",[c.run_id,c.generation,controller,operation]);
 const evidence=operation==="egress_deny"?{egress_denied:true,actor:c.run_id}:operation==="suspend"?{phase:"SUSPENDED",worker_assignment:null,actor:c.run_id}:{confirmed:true,actor:c.run_id};
 await call("ax_evidence",[c.run_id,c.generation,controller,op.operation_id,evidence]);
}
async function start(){const c=await call("ax_claim",[controller,30]);for(const op of ["create","resume","stage","egress_prepare","start"])await effect(c,op);return c;}
async function operation(c:any,sequence:number,body:any,replyBody:any,u:any){
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence,kind:sequence===1?"model":"tool",body}));
 assert.equal((await call("ax_agent_reserve",[c.run_id,c.generation,controller,sequence,bytes])).send,true);
 const response={version:1,run_id:c.run_id,sequence,request_sha256:await sha256(bytes),status:"ok",body:replyBody};
 await call("ax_agent_settle",[c.run_id,c.generation,controller,sequence,response,u,1]);
 return {bytes,response};
}
async function proposal(c:any,kind="question",text="誰向けですか？"){
 const p={kind,text};
 const m=await operation(c,1,{contents:[]},{response:{candidates:[{content:{parts:[{text:JSON.stringify(p)}]}}],usageMetadata:metadata}},usage);
 const t=await operation(c,2,p,{accepted:true},{});return {p,m,t};
}
async function collect(c:any,text:string,changes:Record<string,unknown>={}){
 const bytes=utf8(text);const result={schema_version:1,run_id:c.run_id,adapter:"interactive",status:"succeeded",exit_code:0,stop_reason:"UNSPECIFIED",usage,estimated_usd:0,error_type:null,artifact:{name:"reply.txt",size_bytes:bytes.length,sha256:await sha256(bytes)},...changes};
 await call("ax_collect",[c.run_id,c.generation,controller,result,bytes]);
}
async function finish(c:any){await effect(c,"egress_deny");await effect(c,"suspend");return call("ax_finish",[c.run_id,c.generation,controller]);}
async function question(){const accepted=await begin(),c=await start();const {p}=await proposal(c);await collect(c,p.text);const stopping=await agents.get(owner,workspace,accepted.root_id);assert.equal(stopping.can_answer,false);assert.equal(stopping.state,"running");await assert.rejects(agents.answer(owner,workspace,stopping.id,{key:randomUUID(),question_id:stopping.id,expected_revision:stopping.revision,text:"early"},exp(),tokenHash),error("agent_answer_conflict"));await finish(c);return {accepted,c,root:await agents.get(owner,workspace,accepted.root_id)};}

test("atomic same-key root admission, isolation and legacy submit bypass rejection",async()=>{
 const input={key:randomUUID(),conversation_id:randomUUID(),text:"案内文"};
 const values=await Promise.all(Array.from({length:6},()=>agents.start(owner,workspace,input,exp(),tokenHash)));
 assert.equal(new Set(values.map(v=>v.run_id)).size,1);assert.equal(values.filter(v=>!v.replayed).length,1);
 await assert.rejects(agents.start(owner,workspace,{...input,text:"changed"},exp(),tokenHash),error("idempotency_conflict"));
 await assert.rejects(agents.get(other,workspace,values[0].root_id),error("agent_not_found"));
 const detail=await data.getConversation(owner,input.conversation_id,workspace);assert.equal(detail.agent_root_id,values[0].root_id);assert.equal(detail.can_send,false);
 await assert.rejects(data.submitChat(owner,input.conversation_id,{key:randomUUID(),parent_run_id:values[0].run_id,text:"bypass",allow_model:true},workspace),error("agent_managed_conversation"));
});
test("question becomes waiting only after stop; one answer creates a new Task and cumulative totals",async()=>{
 const {accepted,root,c}=await question();assert.equal(root.state,"waiting_input");assert.equal(root.can_answer,true);
 const input={key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"新入社員向け"};
 const answers=await Promise.all(Array.from({length:5},()=>agents.answer(owner,workspace,root.id,input,exp(),tokenHash)));
 assert.equal(new Set(answers.map(a=>a.run_id)).size,1);assert.notEqual(answers[0].run_id,c.run_id);
 await assert.rejects(agents.answer(owner,workspace,root.id,{...input,key:randomUUID()},exp(),tokenHash),error("agent_answer_conflict"));
 const next=await start();assert.equal(JSON.parse(next.request.inputs["runtime.json"]).phase,"answer");
 const {p}=await proposal(next,"output","新入社員のみなさんへ。");await collect(next,p.text);await finish(next);
 const completed=await agents.get(owner,workspace,root.id);assert.equal(completed.state,"succeeded");assert.equal(completed.model_calls,2);assert.equal(completed.tool_calls,2);
 const history=await data.getConversation(owner,accepted.conversation_id,workspace);assert.equal(history.turns.length,2);assert.equal(history.turns[1].assistant,p.text);
});
test("settled mailbox replay returns stored response, unresolved reservation never resends",async()=>{
 await begin();const c=await start();const {m}=await proposal(c);
 assert.deepEqual(await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,m.bytes]),{send:false,response:m.response});
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{changed:true}}))]),error("agent_operation_conflict"));
});
test("unknown operation holds global slot despite confirmed stop",async()=>{
 await begin();const c=await start();const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_operation_unknown"));
 assert.equal((await finish(c)).resolved,false);assert.equal((await pool.query("SELECT hold_reason FROM ax_execution_slot")).rows[0].hold_reason,"agent_operation_unknown");
 await assert.rejects(begin(),error("unresolved_run"));
});
test("artifact must match approved proposal and usage must match gateway",async()=>{
 await begin();const c=await start();await proposal(c);await collect(c,"改ざん");
 await effect(c,"egress_deny");await effect(c,"suspend");await assert.rejects(call("ax_finish",[c.run_id,c.generation,controller]),error("agent_proposal_mismatch"));
});
test("stop and logout revoke prevent new model requests without blocking cleanup",async()=>{
 const accepted=await begin();const c=await start();await agents.revoke(owner,tokenHash);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_stopped"));
 await effect(c,"egress_deny");await effect(c,"suspend");assert.equal((await agents.get(owner,workspace,accepted.root_id)).stop_requested,true);
});
test("grant expiration, stale claim and root time budget are checked before dispatch",async()=>{
 const accepted=await begin();const c=await start();const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation+1,controller,1,bytes]),error("stale_claim"));
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.root_id]);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_grant_expired"));
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()+interval '1 hour',active_ms=90000 WHERE id=$1",[accepted.root_id]);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_budget_exhausted"));
});
test("nested duplicate mailbox keys fail before any reservation",async()=>{
 await begin();const c=await start();const bytes=utf8(`{"version":1,"run_id":"${c.run_id}","sequence":1,"kind":"model","body":{"a":1,"a":2}}`);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("invalid_request"));
 assert.equal((await pool.query("SELECT count(*) FROM ax_agent_operations")).rows[0].count,"0");
});
test("API uses verified exp and owner, validates input and does not permit forged identity",async()=>{
 const config={apiOrigin:"http://127.0.0.1:3999",apiToken:"a".repeat(64)};
 const app=createApi(config,undefined,postgresRunService(data),postgresChatService(data),async()=>({ownerUserId:owner,expiresAt:exp(),tokenFingerprint:tokenHash}),undefined,agents);
 const headers={host:"127.0.0.1:3999",authorization:`Bearer ${config.apiToken}`,"X-AX-Access-Token":"fixture","X-AX-Workspace-ID":workspace,"content-type":"application/json"};
 const input={key:randomUUID(),conversation_id:randomUUID(),text:"作成"};
 const bad=await app.request("http://127.0.0.1:3999/v1/agent-roots",{method:"POST",headers,body:JSON.stringify({...input,owner_user_id:other})});assert.equal(bad.status,400);
 const good=await app.request("http://127.0.0.1:3999/v1/agent-roots",{method:"POST",headers,body:JSON.stringify(input)});assert.equal(good.status,202);
 const noGrant=createApi(config,undefined,undefined,undefined,async()=>owner,undefined,agents);
 assert.equal((await noGrant.request("http://127.0.0.1:3999/v1/agent-roots",{method:"POST",headers,body:JSON.stringify(input)})).status,401);
});
test("stop before create resolves root through existing no-restart cancellation",async()=>{
 const accepted=await begin();const c=await call("ax_claim",[controller,30]);await agents.stop(owner,workspace,accepted.root_id);
 await assert.rejects(effect(c,"create"),error("agent_stopped"));
 await call("ax_cancel_unstarted",[c.run_id,c.generation,controller]);
 assert.equal((await agents.get(owner,workspace,accepted.root_id)).state,"stopped");
 assert.equal((await pool.query("SELECT run_id FROM ax_execution_slot")).rows[0].run_id,null);
});
test("waiting releases global slot; busy answer rolls back and same key works after slot clears",async()=>{
 const {root}=await question();
 const otherRoot=await agents.start(other,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"other"},exp(),tokenHash);
 const input={key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"担当者"};
 await assert.rejects(agents.answer(owner,workspace,root.id,input,exp(),tokenHash),error("unresolved_run"));
 assert.equal((await agents.get(owner,workspace,root.id)).state,"waiting_input");
 await data.recover(other,otherRoot.run_id,workspace);
 assert.equal((await agents.get(other,workspace,otherRoot.root_id)).state,"failed");
 assert.equal((await agents.answer(owner,workspace,root.id,input,exp(),tokenHash)).replayed,false);
});
test("unknown claim expiration does not permit another reservation or recover-start",async()=>{
 const accepted=await begin();const c=await start();
 await pool.query("UPDATE ax_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1",[c.run_id]);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("stale_claim"));
 await data.recover(owner,c.run_id,workspace);
 assert.equal(await call("ax_claim",[controller,30]),null);
 assert.equal((await pool.query("SELECT count(*) FROM ax_agent_segments WHERE root_id=$1",[accepted.root_id])).rows[0].count,"1");
});
test("member removal blocks gateway while cleanup remains available",async()=>{
 const accepted=await agents.start(other,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"test"},exp(),tokenHash);const c=await start();
 await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[workspace,other]);
 try{
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_stopped"));
 await assert.rejects(agents.get(other,workspace,accepted.root_id),error("workspace_not_found"));
 await effect(c,"egress_deny");await effect(c,"suspend");
 }finally{await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[workspace,other]);}
});
test("expired waiting, stale revision and altered answer replay are rejected",async()=>{
 const {root}=await question();const input={key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"回答"};
 await assert.rejects(agents.answer(owner,workspace,root.id,{...input,expected_revision:root.revision+1},exp(),tokenHash),error("agent_answer_conflict"));
 await pool.query("UPDATE ax_agent_roots SET wait_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[root.id]);
 await assert.rejects(agents.answer(owner,workspace,root.id,input,exp(),tokenHash),error("agent_answer_conflict"));
 await pool.query("UPDATE ax_agent_roots SET wait_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[root.id]);
 await agents.answer(owner,workspace,root.id,input,exp(),tokenHash);
 await assert.rejects(agents.answer(owner,workspace,root.id,{...input,text:"別回答"},exp(),tokenHash),error("idempotency_conflict"));
});
test("gateway usage forgery cannot settle or release hold",async()=>{
 await begin();const c=await start();const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]);
 const response={version:1,run_id:c.run_id,sequence:1,request_sha256:await sha256(bytes),status:"ok",body:{response:{candidates:[{content:{parts:[{text:JSON.stringify({kind:"output",text:"test"})}]}}],usageMetadata:metadata}}};
 await assert.rejects(call("ax_agent_settle",[c.run_id,c.generation,controller,1,response,{...usage,total_token_count:0},1]),error("agent_usage_mismatch"));
 assert.equal((await finish(c)).resolved,false);
});
test("root-wide limits and answer re-question are enforced by database",async()=>{
 const {root}=await question();
 await agents.answer(owner,workspace,root.id,{key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"回答"},exp(),tokenHash);const c=await start();
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await pool.query("UPDATE ax_agent_roots SET model_calls=3 WHERE id=$1",[root.id]);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_budget_exhausted"));
 await pool.query("UPDATE ax_agent_roots SET model_calls=1 WHERE id=$1",[root.id]);
 await assert.rejects(proposal(c,"question","再質問"),error("agent_proposal_mismatch"));
});
test("confirmed stop with no gateway operation finalizes zero usage without guest receipt",async()=>{
 const accepted=await begin();const c=await start();await agents.stop(owner,workspace,accepted.root_id);
 assert.deepEqual(await finish(c),{resolved:true,outcome:"failed"});
 const root=await agents.get(owner,workspace,accepted.root_id);assert.equal(root.state,"stopped");
 const run=await data.get(owner,c.run_id,workspace);assert.equal(run.result?.usage?.model_call_count,0);assert.equal(run.result?.estimated_usd,0);
 assert.equal((await pool.query("SELECT run_id FROM ax_execution_slot")).rows[0].run_id,null);
});
test("confirmed denial after model settles uses gateway usage and never invents tool completion",async()=>{
 const accepted=await begin();const c=await start();
 await operation(c,1,{contents:[]},{response:{candidates:[{content:{parts:[{text:JSON.stringify({kind:"question",text:"質問"})}]}}],usageMetadata:metadata}},usage);
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.root_id]);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:2,kind:"tool",body:{kind:"question",text:"質問"}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,2,bytes]),error("agent_grant_expired"));
 assert.deepEqual(await finish(c),{resolved:true,outcome:"failed"});
 const root=await agents.get(owner,workspace,accepted.root_id);assert.equal(root.state,"failed");assert.equal(root.tool_calls,0);
 assert.deepEqual((await data.get(owner,c.run_id,workspace)).result?.usage,usage);
 assert.equal((await pool.query("SELECT count(*) FROM ax_artifacts WHERE run_id=$1",[c.run_id])).rows[0].count,"0");
});
test("guest failure with unknown SDK usage preserves original receipt and settles from stopped gateway",async()=>{
 const accepted=await begin();const c=await start();
 const failed={schema_version:1,run_id:c.run_id,adapter:"interactive",status:"failed",exit_code:1,stop_reason:null,usage:null,estimated_usd:null,error_type:"sdk_initialization_failed",artifact:null};
 await call("ax_collect",[c.run_id,c.generation,controller,failed,null]);
 assert.deepEqual(await finish(c),{resolved:true,outcome:"failed"});
 assert.equal((await agents.get(owner,workspace,accepted.root_id)).state,"failed");
 const observations=await pool.query("SELECT evidence FROM ax_observations WHERE run_id=$1 AND evidence->>'kind'='gateway_terminal'",[c.run_id]);
 assert.deepEqual(observations.rows[0].evidence.original_result,failed);
 assert.equal((await data.get(owner,c.run_id,workspace)).result?.usage?.model_call_count,0);
});
test("logout fingerprint is permanent for new admission; a new token may start",async()=>{
 await agents.revoke(owner,tokenHash);
 await assert.rejects(begin(),error("agent_grant_revoked"));
 const result=await agents.start(owner,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"fresh login"},exp(),"c".repeat(64));
 assert.equal((await agents.get(owner,workspace,result.root_id)).stop_requested,false);
 assert.equal((await pool.query("SELECT token_hash FROM ax_agent_revocations WHERE owner_user_id=$1",[owner])).rows[0].token_hash,tokenHash);
});
test("concurrent start and logout cannot leave a live grant from the revoked token",async()=>{
 const outcomes=await Promise.allSettled([begin(),agents.revoke(owner,tokenHash)]);
 assert.equal(outcomes[1].status,"fulfilled");
 if(outcomes[0].status==="fulfilled")assert.equal((await agents.get(owner,workspace,outcomes[0].value.root_id)).stop_requested,true);
 else assert.equal((outcomes[0].reason as Error).message,"agent_grant_revoked");
 assert.equal((await pool.query("SELECT count(*) FROM ax_agent_roots WHERE owner_user_id=$1 AND NOT stop_requested",[owner])).rows[0].count,"0");
});
test("concurrent answer and logout cannot revive a waiting root",async()=>{
 const {root}=await question();
 const input={key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"answer"};
 const outcomes=await Promise.allSettled([agents.answer(owner,workspace,root.id,input,exp(),tokenHash),agents.revoke(owner,tokenHash)]);
 assert.equal(outcomes[1].status,"fulfilled");
 assert.equal((await agents.get(owner,workspace,root.id)).stop_requested,true);
 assert.equal((await pool.query("SELECT count(*)::int n FROM ax_agent_segments WHERE root_id=$1",[root.id])).rows[0].n<=2,true);
});
test("removal and rejoining cannot restore an old root grant",async()=>{
 const accepted=await agents.start(other,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"test"},exp(),tokenHash);const c=await start();
 await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[workspace,other]);
 await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[workspace,other]);
 assert.equal((await agents.get(other,workspace,accepted.root_id)).stop_requested,true);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_stopped"));
});
test("disabled and re-enabled user cannot restore an old root grant",async()=>{
 const accepted=await begin();const c=await start();
 await pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
 await pool.query("UPDATE users SET status='active' WHERE id=$1",[owner]);
 assert.equal((await agents.get(owner,workspace,accepted.root_id)).stop_requested,true);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{}}));
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_stopped"));
});
test("membership revocation and runtime intent serialize workspace before root",async()=>{
 await agents.start(other,workspace,{key:randomUUID(),conversation_id:randomUUID(),text:"test"},exp(),tokenHash);
 const c=await call("ax_claim",[controller,30]);const client=await pool.connect();
 try{
  await client.query("BEGIN");await client.query("SELECT id FROM org_workspaces WHERE id=$1 FOR UPDATE",[workspace]);
  const pending=call("ax_intent",[c.run_id,c.generation,controller,"create"]).then(()=>"granted",(e:Error)=>e.message);
  await client.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[workspace,other]);
  await client.query("COMMIT");assert.equal(await pending,"agent_stopped");
 }finally{await client.query("ROLLBACK");client.release();await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING",[workspace,other]);}
});
