import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {before,beforeEach,after,test} from "node:test";
import pg from "pg";
import {prepareTestAuth} from "./prepare-auth";
import {migrateData} from "../server/data-migrate";
import {AgentRepository} from "../data/agents";
import {DataRepository} from "../data/repository";
import {WorkspaceRepository} from "../data/workspaces";
import {sha256,utf8} from "../data/canonical";
import {apiFunctions,executionFunctions} from "../data/permissions";
import {createApi} from "../api/app";
import {postgresChatService} from "../api/chat-service";
import {postgresRunService} from "../api/run-service";

const schema=`agent_test_${randomBytes(8).toString("hex")}`;
const owner=randomUUID(), other=randomUUID(), controller="agent-test", image=`localhost:5001/runner@sha256:${"a".repeat(64)}`;
let pool:pg.Pool, admin:pg.Pool, agents:AgentRepository, data:DataRepository, workspace:string, connectionOptions:pg.PoolConfig;
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
 connectionOptions=options;admin=new pg.Pool(options);await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({...options,options:`-c search_path=${schema}`});
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
 assert.deepEqual(await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,m.bytes]),{send:false,response:m.response,input_limit:0,output_limit:0,profile_id:"preview-v1"});
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

const paidProfile="gemini-3.1-flash-lite-standard-2026-10-07-v1";
const payloadHash="d".repeat(64);
const realUsage={prompt_token_count:1000,candidates_token_count:100,thoughts_token_count:10,total_token_count:1110,model_call_count:1};
const zeroUsage={prompt_token_count:0,candidates_token_count:0,thoughts_token_count:0,total_token_count:0,model_call_count:0};
const price=(u=realUsage)=>Math.round((u.prompt_token_count*.25+(u.candidates_token_count+u.thoughts_token_count)*1.5)*1000)/1e9;
const beginPaid=(text="案内文")=>agents.start(owner,workspace,{key:randomUUID(),conversation_id:randomUUID(),text,mode:"model",allow_model:true},exp(),tokenHash);
async function reservePaid(c:any){
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{contents:[{role:"user",parts:[{text:"hello"}]}]}}));
 const reservation=await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]);return {bytes,reservation};
}
async function authorizePaid(c:any,count=1000){return call("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,payloadHash,count]);}
async function settlePaid(c:any,bytes:Uint8Array,options:{outcome?:string;kind?:string;text?:string;usage?:typeof realUsage;code?:string;count?:number;metadata?:unknown;billing?:number}={}){
 const outcome=options.outcome??"ok", u=options.usage??realUsage, code=options.code??(outcome==="ok"?"ok":"invalid_proposal");
 const p={kind:options.kind??"question",text:options.text??"誰向けですか？"};
 const md=options.metadata??{promptTokenCount:u.prompt_token_count,candidatesTokenCount:u.candidates_token_count,thoughtsTokenCount:u.thoughts_token_count,totalTokenCount:u.total_token_count};
 const response={version:1,run_id:c.run_id,sequence:1,request_sha256:await sha256(bytes),status:outcome==="ok"?"ok":"denied",body:outcome==="ok"?{response:{candidates:[{content:{parts:[{text:JSON.stringify(p)}]},finishReason:"STOP"}],usageMetadata:md},billing:{profile_id:paidProfile,estimated_usd:options.billing??price(u)}}:{code}};
 const evidence={outcome,code,payload_sha256:outcome==="no_send"?null:payloadHash,counted_input_tokens:outcome==="no_send"?null:(options.count??1000),count_attempt:1,http_status:200,finish_reason:outcome==="ok"?"STOP":null,response_sha256:outcome==="no_send"?null:"e".repeat(64)};
 await call("ax_agent_settle",[c.run_id,c.generation,controller,1,response,u,3,evidence]);
 return {p,response,evidence,saved:await call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes])};
}

test("model requires explicit consent; preview default/replay and immutable mode are preserved",async()=>{
 const input={key:randomUUID(),conversation_id:randomUUID(),text:"hello"};
 await assert.rejects(call("ax_agent_start",[owner,workspace,{...input,mode:"model"},image,"ax-run-aaaaaaaaaaaaaaaa",exp(),tokenHash]),error("model_not_allowed"));
 const accepted=await agents.start(owner,workspace,input,exp(),tokenHash);
 const replay=await agents.start(owner,workspace,{...input,mode:"preview",allow_model:false},exp(),tokenHash);assert.equal(replay.run_id,accepted.run_id);assert.equal(replay.replayed,true);
 const view=await agents.get(owner,workspace,accepted.root_id);assert.equal(view.mode,"preview");assert.equal(view.preview,true);assert.equal(view.estimated_usd,0);
 await assert.rejects(agents.start(owner,workspace,{...input,mode:"model",allow_model:true},exp(),tokenHash),error("idempotency_conflict"));
 await assert.rejects(pool.query("UPDATE ax_agent_roots SET mode='model',profile_id=$2 WHERE id=$1",[accepted.root_id,paidProfile]),error("immutable_agent_mode"));
});

test("paid claim, generation permission and two segments preserve profile and real totals",async()=>{
 const accepted=await beginPaid();const c=await start();assert.deepEqual(c.agent,{mode:"model",profile_id:paidProfile});
 const m=await reservePaid(c);assert.equal(m.reservation.input_limit,6000);assert.equal(m.reservation.output_limit,256);assert.equal(m.reservation.profile_id,paidProfile);
 assert.equal((await agents.get(owner,workspace,accepted.root_id)).estimated_usd,null);
 assert.deepEqual(await authorizePaid(c),{send:true});await assert.rejects(authorizePaid(c),error("agent_operation_unknown"));
 const result=await settlePaid(c,m.bytes);assert.equal(result.saved.send,false);
 await operation(c,2,result.p,{accepted:true},{});await collect(c,result.p.text,{usage:realUsage,estimated_usd:price()});await finish(c);
 const root=await agents.get(owner,workspace,accepted.root_id);assert.equal(root.state,"waiting_input");assert.equal(root.mode,"model");assert.equal(root.preview,false);assert.equal(root.model,"gemini-3.1-flash-lite");assert.equal(root.estimated_usd,price());
 assert.equal((await data.get(owner,c.run_id,workspace)).summary.agent_mode,"model");
 await agents.answer(owner,workspace,root.id,{key:randomUUID(),question_id:root.id,expected_revision:root.revision,text:"社員向け"},exp(),tokenHash);
 const next=await start();assert.deepEqual(next.agent,c.agent);const n=await reservePaid(next);assert.equal(n.reservation.input_limit,5000);assert.equal(n.reservation.output_limit,256);
 await authorizePaid(next);const final=await settlePaid(next,n.bytes,{kind:"output",text:"社員のみなさんへ。"});await operation(next,2,final.p,{accepted:true},{});await collect(next,final.p.text,{usage:realUsage,estimated_usd:price()});await finish(next);
 const done=await agents.get(owner,workspace,root.id);assert.equal(done.state,"succeeded");assert.equal(done.model_calls,2);assert.equal(done.estimated_usd,price()*2);
 assert.equal(Number(await call("ax_paid_total",[false])),price()*2);
});

test("stop during count forbids generation but permits proven no-send settlement",async()=>{
 const accepted=await beginPaid();const c=await start(),m=await reservePaid(c);await agents.stop(owner,workspace,accepted.root_id);
 await assert.rejects(authorizePaid(c),error("agent_stopped"));await settlePaid(c,m.bytes,{outcome:"no_send",usage:zeroUsage,code:"agent_stopped"});
 assert.equal((await finish(c)).resolved,true);assert.equal((await agents.get(owner,workspace,accepted.root_id)).state,"stopped");assert.equal(Number(await call("ax_paid_total",[true])),0);
});

test("count rejection has no generation charge, while authorization ACK loss cannot release reservation",async()=>{
 await beginPaid();const c=await start(),m=await reservePaid(c);await assert.rejects(authorizePaid(c,5873),error("agent_budget_exhausted"));
 await authorizePaid(c);await assert.rejects(settlePaid(c,m.bytes,{outcome:"no_send",usage:zeroUsage}),error("agent_usage_mismatch"));
 assert.equal((await finish(c)).resolved,false);assert.equal((await pool.query("SELECT generation_started,reserved_usd,actual_usd FROM ax_agent_operations WHERE run_id=$1 AND sequence=1",[c.run_id])).rows[0].actual_usd,null);
 assert.equal((await call("ax_paid_total",[true]))>0,true);
});

test("grant expiry, logout and membership revocation after count cannot generate",async()=>{
 const accepted=await beginPaid();const c=await start();await reservePaid(c);
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[accepted.root_id]);await assert.rejects(authorizePaid(c),error("agent_grant_expired"));
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()+interval '5 minute' WHERE id=$1",[accepted.root_id]);await agents.revoke(owner,tokenHash);await assert.rejects(authorizePaid(c),error("agent_stopped"));
});

test("settlement after logout retains known usage and cannot turn a cancelled run into success",async()=>{
 const accepted=await beginPaid();const c=await start(),m=await reservePaid(c);await authorizePaid(c);await agents.revoke(owner,tokenHash);await settlePaid(c,m.bytes,{outcome:"failed",code:"invalid_proposal"});
 assert.equal((await finish(c)).resolved,true);const view=await agents.get(owner,workspace,accepted.root_id);assert.equal(view.state,"stopped");assert.equal(view.estimated_usd,price());
});

test("known usage malformed proposal settles failure and blocks paid retry until review",async()=>{
 await beginPaid();const c=await start(),m=await reservePaid(c);await authorizePaid(c);const result=await settlePaid(c,m.bytes,{kind:"invalid"});assert.equal(result.saved.response.status,"denied");
 await call("ax_agent_settle",[c.run_id,c.generation,controller,1,result.response,realUsage,3,result.evidence]);
 assert.deepEqual(await finish(c),{resolved:true,outcome:"failed"});assert.equal((await data.get(owner,c.run_id,workspace)).result?.estimated_usd,price());
 await assert.rejects(beginPaid("different request"),error("paid_failure_requires_review"));
 await call("ax_review_failure",[c.run_id,"Offline diagnosis complete; changed request."]);
 await assert.rejects(beginPaid(),error("failed_request_already_attempted"));
 await beginPaid("different request");
});

test("known usage overflow is persisted without granting fixed tool or clearing the charge",async()=>{
 const accepted=await beginPaid();const c=await start(),m=await reservePaid(c);await authorizePaid(c);
 const over={prompt_token_count:6100,candidates_token_count:280,thoughts_token_count:0,total_token_count:6380,model_call_count:1};
 const result=await settlePaid(c,m.bytes,{usage:over});assert.equal(result.saved.response.status,"denied");assert.equal(result.saved.response.body.code,"agent_budget_exhausted");
 assert.equal((await pool.query("SELECT budget_exceeded FROM ax_agent_operations WHERE run_id=$1 AND sequence=1",[c.run_id])).rows[0].budget_exceeded,true);
 assert.equal((await finish(c)).resolved,true);const view=await agents.get(owner,workspace,accepted.root_id);assert.equal(view.state,"failed");assert.equal(view.estimated_usd,price(over));
});

test("unknown paid reservation stays held with stopped Actor and zero-cost receipt cannot erase it",async()=>{
 await beginPaid();const c=await start();await reservePaid(c);await authorizePaid(c);await collect(c,"fake",{usage:zeroUsage,estimated_usd:0,status:"failed",exit_code:1,error_type:"unknown_provider"});
 assert.equal((await finish(c)).resolved,false);await assert.rejects(beginPaid("next"),error("unresolved_run"));assert.equal((await call("ax_paid_total",[true]))>0,true);
});

test("legacy and new model costs share the pilot guard without double counting",async()=>{
 await beginPaid();const c=await start(),m=await reservePaid(c);await authorizePaid(c);const u={prompt_token_count:40000,candidates_token_count:0,thoughts_token_count:0,total_token_count:40000,model_call_count:1};
 await settlePaid(c,m.bytes,{outcome:"failed",usage:u});await finish(c);await call("ax_review_failure",[c.run_id,"Investigated unexpected provider token consumption."]);
 assert.equal(await call("ax_paid_total",[false]),"0.010000000");
 await assert.rejects(data.submit(owner,{key:randomUUID(),mode:"model",instruction:"legacy request",input_text:"",output_name:"a.txt",allow_model:true},workspace),error("pilot_estimate_limit_reached"));
 await assert.rejects(beginPaid("new request"),error("pilot_estimate_limit_reached"));
});

test("forged usage or payload evidence cannot settle a paid operation",async()=>{
 await beginPaid();const c=await start(),m=await reservePaid(c);await authorizePaid(c);
 await assert.rejects(settlePaid(c,m.bytes,{metadata:{promptTokenCount:9}}),error("agent_usage_mismatch"));
 await assert.rejects(settlePaid(c,m.bytes,{count:1001}),error("agent_usage_mismatch"));
 await assert.rejects(settlePaid(c,m.bytes,{billing:0}),error("agent_usage_mismatch"));
 const response={version:1,run_id:c.run_id,sequence:1,request_sha256:await sha256(m.bytes),status:"denied",body:{code:"invalid_proposal"}};
 await assert.rejects(call("ax_agent_settle",[c.run_id,c.generation,controller,1,response,realUsage,1,{outcome:null,code:"invalid_proposal",payload_sha256:payloadHash,counted_input_tokens:1000,count_attempt:1,http_status:200,finish_reason:"STOP",response_sha256:"e".repeat(64)}]),error("agent_response_mismatch"));
 assert.equal(await call("ax_agent_proposal",[{candidates:[{content:{parts:[{text:JSON.stringify({kind:null,text:"unexpected"})}]},finishReason:"STOP"}]},1]),null);
 assert.equal((await finish(c)).resolved,false);
});

test("remaining pilot allowance includes legacy spend before reserving a new model request",async()=>{
 await data.submit(owner,{key:randomUUID(),mode:"model",instruction:"legacy",input_text:"",output_name:"reply.txt",allow_model:true},workspace);
 const legacy=await call("ax_claim",[controller,30]);for(const op of ["create","resume","stage","egress_allow","start"])await effect(legacy,op);
 await collect(legacy,"legacy",{adapter:"antigravity",estimated_usd:.0085});await finish(legacy);
 const accepted=await beginPaid();const c=await start();await assert.rejects(reservePaid(c),error("pilot_estimate_limit_reached"));
 assert.equal((await pool.query("SELECT count(*)::int n FROM ax_agent_operations WHERE run_id=$1",[c.run_id])).rows[0].n,0);
 await finish(c);assert.equal((await agents.get(owner,workspace,accepted.root_id)).estimated_usd,0);
 assert.equal(Number(await call("ax_paid_total",[false])),.0085);
});

test("concurrent reservation and generation authorization issue a single send permission",async()=>{
 await beginPaid();const c=await start();const res=await Promise.allSettled(Array.from({length:4},()=>reservePaid(c)));
 assert.equal(res.filter(x=>x.status==="fulfilled").length,1);
 const attempts=await Promise.allSettled(Array.from({length:4},()=>authorizePaid(c)));
 assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);
 assert.equal((await pool.query("SELECT model_calls FROM ax_agent_roots")).rows[0].model_calls,1);
});

test("paid manifest is immutable and old owner/private reads cannot select its mode",async()=>{
 const accepted=await beginPaid();const c=await start();
 await assert.rejects(pool.query("UPDATE ax_agent_segments SET execution_manifest=$2 WHERE run_id=$1",[c.run_id,{version:1,mode:"preview",profile_id:"preview-v1"}]),error("immutable_agent_manifest"));
 await assert.rejects(agents.get(other,workspace,accepted.root_id),error("agent_not_found"));
 await assert.rejects(data.get(other,c.run_id,workspace),error("run_not_found"));
 assert.equal((await data.get(owner,c.run_id,workspace)).summary.agent_mode,"model");
});

test("API model consent is explicit and response exposes persisted mode without accepting answer mode",async()=>{
 const config={apiOrigin:"http://127.0.0.1:3999",apiToken:"a".repeat(64)};
 const app=createApi(config,undefined,postgresRunService(data),postgresChatService(data),async()=>({ownerUserId:owner,expiresAt:exp(),tokenFingerprint:tokenHash}),undefined,agents);
 const headers={host:"127.0.0.1:3999",authorization:`Bearer ${config.apiToken}`,"content-type":"application/json","x-ax-workspace-id":workspace};
 const input={key:randomUUID(),conversation_id:randomUUID(),text:"hello",mode:"model"};
 const bad=await app.request("http://127.0.0.1:3999/v1/agent-roots",{method:"POST",headers,body:JSON.stringify(input)});assert.equal(bad.status,400);
 const response=await app.request("http://127.0.0.1:3999/v1/agent-roots",{method:"POST",headers,body:JSON.stringify({...input,allow_model:true})});assert.equal(response.status,202);
 const accepted=await response.json();const detail=await app.request(`http://127.0.0.1:3999/v1/agent-roots/${accepted.root_id}`,{headers});assert.equal((await detail.json()).mode,"model");
 const forged=await app.request(`http://127.0.0.1:3999/v1/agent-roots/${accepted.root_id}/answer`,{method:"POST",headers,body:JSON.stringify({key:randomUUID(),question_id:accepted.root_id,expected_revision:1,text:"x",mode:"preview"})});assert.equal(forged.status,400);
});

test("v4 preview migration retains original run bytes, old-key replay and pending claims",async()=>{
 const oldSchema=`agent_v4_${randomBytes(8).toString("hex")}`;
 await admin.query(`CREATE SCHEMA ${oldSchema}`);const old=new pg.Pool({...connectionOptions,options:`-c search_path=${oldSchema}`});
 try {
  await old.query(readFileSync(new URL("../server/auth-schema.sql",import.meta.url),"utf8"));await old.query(readFileSync(new URL("../server/auth-schema-v2.sql",import.meta.url),"utf8"));
  const client=await old.connect();try {
   await client.query("BEGIN");await client.query("CREATE TABLE ax_migrations(version integer PRIMARY KEY,digest text NOT NULL)");
   for(const [i,name] of ["schema.sql","schema-v2.sql","schema-v3.sql","schema-v4.sql"].entries()){
    const source=readFileSync(new URL(`../data/${name}`,import.meta.url),"utf8");await client.query(source);await client.query("INSERT INTO ax_migrations VALUES($1,$2)",[i+1,createHash("sha256").update(source).digest("hex")]);
   }
   await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  await old.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','old')",[owner]);await old.query("UPDATE ax_control SET accepting=true");
  const wid=(await new WorkspaceRepository(old).create(owner,{key:randomUUID(),name:"old"})).workspace.id;
  const repo=new AgentRepository(old,image),input={key:randomUUID(),conversation_id:randomUUID(),text:"old pending"};
  const oldCall=async(name:string,args:unknown[]=[]) => (await old.query(`SELECT ${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0].value;
  const oldAccepted=await repo.start(owner,wid,{key:randomUUID(),conversation_id:randomUUID(),text:"old settled"},exp(),tokenHash);
  const oldClaim=await oldCall("ax_claim",[controller,30]);
  for(const operation of ["create","resume","stage","egress_prepare","start"]){const op=await oldCall("ax_intent",[oldClaim.run_id,oldClaim.generation,controller,operation]);await oldCall("ax_evidence",[oldClaim.run_id,oldClaim.generation,controller,op.operation_id,{confirmed:true,actor:oldClaim.run_id}]);}
  const priorBytes=utf8(JSON.stringify({version:1,run_id:oldClaim.run_id,sequence:1,kind:"model",body:{contents:[]}}));
  await oldCall("ax_agent_reserve",[oldClaim.run_id,oldClaim.generation,controller,1,priorBytes]);
  const priorReply={version:1,run_id:oldClaim.run_id,sequence:1,request_sha256:await sha256(priorBytes),status:"ok",body:{response:{candidates:[{content:{parts:[{text:JSON.stringify({kind:"question",text:"Who?"})}]}}],usageMetadata:metadata}}};
  await oldCall("ax_agent_settle",[oldClaim.run_id,oldClaim.generation,controller,1,priorReply,usage,1]);
  for(const operation of ["egress_deny","suspend"]){const op=await oldCall("ax_intent",[oldClaim.run_id,oldClaim.generation,controller,operation]);await oldCall("ax_evidence",[oldClaim.run_id,oldClaim.generation,controller,op.operation_id,operation==="egress_deny"?{egress_denied:true,actor:oldClaim.run_id}:{phase:"SUSPENDED",worker_assignment:null,actor:oldClaim.run_id}]);}
  await oldCall("ax_finish",[oldClaim.run_id,oldClaim.generation,controller]);
  const accepted=await repo.start(owner,wid,input,exp(),tokenHash);
  const before=(await old.query("SELECT to_jsonb(r) value FROM ax_runs r ORDER BY run_id")).rows.map(r=>r.value);
  await migrateData(old);await migrateData(old);
  assert.deepEqual((await old.query("SELECT to_jsonb(r) value FROM ax_runs r ORDER BY run_id")).rows.map(r=>r.value),before);
  assert.deepEqual((await old.query("SELECT response,usage FROM ax_agent_operations WHERE run_id=$1",[oldAccepted.run_id])).rows[0],{response:priorReply,usage});
  assert.equal((await repo.get(owner,wid,accepted.root_id)).mode,"preview");
  assert.equal((await repo.start(owner,wid,{...input,mode:"preview"},exp(),tokenHash)).replayed,true);
  assert.deepEqual((await old.query("SELECT ax_claim($1,30) v",[controller])).rows[0].v.agent,{mode:"preview",profile_id:"preview-v1"});
 }finally{await old.end();await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`);}
});

test("limited API and controller roles can use v5 entry points but cannot bypass them",async()=>{
 const roles=(await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN ('ax_api','ax_execution')")).rows.map(x=>x.rolname);
 assert.equal(roles.length,2,"Prepared test server provides the existing API and controller roles");
 const functions=(await pool.query("SELECT p.oid::regprocedure::text signature,p.proname FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace")).rows;
 for(const [role,names] of [["ax_api",apiFunctions],["ax_execution",executionFunctions]] as const){
  await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  for(const f of functions.filter(x=>names.includes(x.proname)))await pool.query(`GRANT EXECUTE ON FUNCTION ${f.signature} TO ${role}`);
 }
 const transaction=(role:string,sql:string)=>execFileSync("docker",["exec","-i",process.env.POSTGRES_CONTAINER??"ax-local-postgres","psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","app_auth_test"],{input:`BEGIN; SET LOCAL search_path=${schema},pg_temp; SET LOCAL ROLE ${role}; ${sql} COMMIT;`,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:10000}).trim();
 const literal=(value:unknown):string=>value instanceof Uint8Array?`decode('${Buffer.from(value).toString("hex")}','hex')`:value===null?"NULL":typeof value==="number"?String(value):`'${(typeof value==="string"?value:JSON.stringify(value)).replaceAll("'","''")}'`;
 const restricted=(name:string,args:unknown[]=[],role="ax_execution")=>{
  const value=transaction(role,`SELECT ${name}(${args.map(literal).join(",")});`);return value?JSON.parse(value):null;
 };
 const denied=(e:any)=>e.status===3&&String(e.stderr).includes("permission denied");
 const input={key:randomUUID(),conversation_id:randomUUID(),text:"limited role",mode:"model",allow_model:true};
 const accepted=restricted("ax_agent_start",[owner,workspace,input,image,`ax-run-${randomBytes(8).toString("hex")}`,exp(),tokenHash],"ax_api");
 assert.throws(()=>restricted("ax_claim",["forged",30],"ax_api"),denied);
 assert.throws(()=>transaction("ax_api","SELECT * FROM ax_agent_operations;"),denied);
 const c=restricted("ax_claim",[controller,30]);assert.equal(c.run_id,accepted.run_id);assert.equal(c.agent.mode,"model");
 assert.throws(()=>restricted("ax_agent_start",[owner,workspace,input,image,`ax-run-${randomBytes(8).toString("hex")}`,exp(),tokenHash]),denied);
 assert.throws(()=>restricted("ax_agent_settle_v4",[c.run_id,c.generation,controller,1,{}, {},1]),denied);
 assert.throws(()=>restricted("ax_agent_reserve_v4",[c.run_id,c.generation,controller,1,utf8("{}")]),denied);
 const restrictedEffect=(operation:string)=>{const op=restricted("ax_intent",[c.run_id,c.generation,controller,operation]);restricted("ax_evidence",[c.run_id,c.generation,controller,op.operation_id,operation==="egress_deny"?{egress_denied:true,actor:c.run_id}:operation==="suspend"?{phase:"SUSPENDED",worker_assignment:null,actor:c.run_id}:{confirmed:true,actor:c.run_id}]);};
 for(const op of ["create","resume","stage","egress_prepare","start"])restrictedEffect(op);
 const bytes=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{contents:[]}}));
 assert.equal(restricted("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]).send,true);
 assert.equal(restricted("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,payloadHash,1000]).send,true);
 const response={version:1,run_id:c.run_id,sequence:1,request_sha256:await sha256(bytes),status:"denied",body:{code:"invalid_proposal"}};
 const evidence={outcome:"failed",code:"invalid_proposal",payload_sha256:payloadHash,counted_input_tokens:1000,count_attempt:1,http_status:200,finish_reason:"MAX_TOKENS",response_sha256:"e".repeat(64)};
 restricted("ax_agent_settle",[c.run_id,c.generation,controller,1,response,realUsage,3,evidence]);
 assert.equal(restricted("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]).send,false);
 restrictedEffect("egress_deny");restrictedEffect("suspend");assert.equal(restricted("ax_finish",[c.run_id,c.generation,controller]).resolved,true);
 assert.equal((await agents.get(owner,workspace,accepted.root_id)).estimated_usd,price());
 await call("ax_review_failure",[c.run_id,"Restricted role failure was checked."]);
 for(const scenario of ["no_send","unknown"]){
  const next=restricted("ax_agent_start",[owner,workspace,{...input,key:randomUUID(),conversation_id:randomUUID(),text:scenario},image,`ax-run-${randomBytes(8).toString("hex")}`,exp(),tokenHash],"ax_api");
  Object.assign(c,restricted("ax_claim",[controller,30]));
  for(const op of ["create","resume","stage","egress_prepare","start"])restrictedEffect(op);
  const body=utf8(JSON.stringify({version:1,run_id:c.run_id,sequence:1,kind:"model",body:{contents:[]}}));restricted("ax_agent_reserve",[c.run_id,c.generation,controller,1,body]);
  if(scenario==="no_send"){
   restricted("ax_agent_settle",[c.run_id,c.generation,controller,1,{version:1,run_id:c.run_id,sequence:1,request_sha256:await sha256(body),status:"denied",body:{code:"count_rejected"}},zeroUsage,1,{outcome:"no_send",code:"count_rejected",payload_sha256:null,counted_input_tokens:null,count_attempt:1,http_status:400,finish_reason:null,response_sha256:null}]);
  }else restricted("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,payloadHash,1000]);
  restrictedEffect("egress_deny");restrictedEffect("suspend");assert.equal(restricted("ax_finish",[c.run_id,c.generation,controller]).resolved,scenario==="no_send");
  assert.equal((await agents.get(owner,workspace,next.root_id)).estimated_usd,scenario==="no_send"?0:null);
 }
});
