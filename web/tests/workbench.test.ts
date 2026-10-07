import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { before, beforeEach, after, test } from "node:test";
import pg from "pg";
import { prepareTestAuth } from "./prepare-auth";
import { WorkbenchRepository } from "../data/workbench";
import { WorkspaceRepository } from "../data/workspaces";
import { FileRepository } from "../data/files";
import { AgentRepository } from "../data/agents";
import { DataRepository } from "../data/repository";
import { DefinitionRepository } from "../data/definitions";
import { execFileSync } from "node:child_process";
import { apiFunctions, executionFunctions } from "../data/permissions";
import { workbenchApiFunctions, workbenchExecutionFunctions } from "../shared/workbench-contracts";

const schema = `workbench_test_${randomBytes(8).toString("hex")}`;
const owner=randomUUID(), bob=randomUUID(), controller="workbench-test", token="b".repeat(64), image=`localhost:5001/runner@sha256:${"a".repeat(64)}`;
const exp=()=>Math.floor(Date.now()/1000)+3600;
const hash=(b:Uint8Array|string)=>createHash("sha256").update(b).digest("hex");
const usage={prompt_token_count:100,candidates_token_count:20,thoughts_token_count:0,total_token_count:120,model_call_count:1};
let pool:pg.Pool, admin:pg.Pool, repo:WorkbenchRepository, wid:string;
const call=async(name:string,args:unknown[]=[]) => (await pool.query(`SELECT ${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) value`,args)).rows[0].value;
const error=(name:string)=>(e:unknown)=>e instanceof Error&&e.message===name;
const begin=(extra:Record<string,unknown>={})=>repo.start(owner,wid,{key:randomUUID(),text:"集計",...extra},exp(),token);
before(async()=>{
 const {caPath,...database}=prepareTestAuth().database;
 const config={...database,ssl:caPath?{ca:readFileSync(caPath,"utf8"),rejectUnauthorized:true}:false,max:10,statement_timeout:10000};
 admin=new pg.Pool(config); await admin.query(`CREATE SCHEMA ${schema}`); pool=new pg.Pool({...config,options:`-c search_path=${schema}`});
 const client=await pool.connect();
 try {await client.query("BEGIN");for(const f of ["../server/auth-schema.sql","../server/auth-schema-v2.sql",...Array.from({length:8},(_,i)=>`../data/schema${i?`-v${i+1}`:""}.sql`)])await client.query(readFileSync(new URL(f,import.meta.url),"utf8"));await client.query("COMMIT");}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
 await pool.query("INSERT INTO users(id,status,display_name) VALUES($1,'active','A'),($2,'active','B')",[owner,bob]);
 wid=(await new WorkspaceRepository(pool).create(owner,{key:randomUUID(),name:"Workbench"})).workspace.id;
 await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[wid,bob]);repo=new WorkbenchRepository(pool);
});
beforeEach(async()=>{
 await pool.query("TRUNCATE ax_runs,ax_conversations,ax_agent_roots,ax_files,ax_agent_revocations CASCADE");
 await pool.query("INSERT INTO ax_execution_slot VALUES(true,NULL,NULL) ON CONFLICT(id) DO UPDATE SET run_id=NULL,hold_reason=NULL");
 await pool.query("UPDATE ax_control SET accepting=true");
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=false,python_enabled=false,runtime_image=$1,code_image=$1,code_profile='host-quota-8m-v1'",[image]);
 await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general') ON CONFLICT DO NOTHING",[wid,bob]);
});
after(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
async function effect(c:any,operation:string){const op=await call("ax_intent",[c.run_id,c.generation,controller,operation]);await call("ax_evidence",[c.run_id,c.generation,controller,op.operation_id,operation==="egress_deny"?{egress_denied:true,actor:c.run_id}:operation==="suspend"?{phase:"SUSPENDED",worker_assignment:null,actor:c.run_id}:{confirmed:true,actor:c.run_id}]);}
async function start(){const c=await call("ax_claim",[controller,30]);for(const op of ["create","resume","stage","egress_prepare","start"])await effect(c,op);return c;}
async function reserve(c:any,seq:number,body:any={}){const bytes=Buffer.from(JSON.stringify({version:2,run_id:c.run_id,sequence:seq,kind:seq===1?"model":"tool",body}));const value=await call("ax_agent_reserve",[c.run_id,c.generation,controller,seq,bytes]);return {bytes,value};}
async function proposal(c:any,p:any={kind:"output",text:"集計しました"},u=usage){
 const {bytes}=await reserve(c,1); const paid=c.workbench.mode==="model"; const payloadHash="c".repeat(64); if(paid)await call("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,payloadHash,100]);
 const cost=paid?(u.prompt_token_count*.25+(u.candidates_token_count+u.thoughts_token_count)*1.5)/1e6:0;
 const body={response:{candidates:[{content:{parts:[{text:JSON.stringify(p)}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:u.prompt_token_count,candidatesTokenCount:u.candidates_token_count,thoughtsTokenCount:u.thoughts_token_count,totalTokenCount:u.total_token_count}},...(paid?{billing:{profile_id:c.workbench.profile_id,estimated_usd:cost}}:{})};
 const response={version:2,run_id:c.run_id,sequence:1,request_sha256:hash(bytes),status:"ok",body};
 const evidence=paid?{outcome:"ok",code:"ok",payload_sha256:payloadHash,counted_input_tokens:100,count_attempt:1,http_status:200,finish_reason:"STOP",response_sha256:"d".repeat(64)}:{};
 await call("ax_agent_settle",[c.run_id,c.generation,controller,1,response,u,1,evidence]);
 return {bytes,response,evidence};
}
async function tool(c:any,p:any){const {bytes}=await reserve(c,2,p);await call("ax_agent_settle",[c.run_id,c.generation,controller,2,{version:2,run_id:c.run_id,sequence:2,request_sha256:hash(bytes),status:"ok",body:{accepted:true}},{},1,{}]);}
async function collect(c:any,summary="done",u:any=usage){await call("ax_collect",[c.run_id,c.generation,controller,{schema_version:2,run_id:c.run_id,adapter:c.request.adapter,status:"succeeded",exit_code:0,error_type:null,summary,usage:u,estimated_usd:0},null]);}
async function finish(c:any){await effect(c,"egress_deny");await effect(c,"suspend");return call("ax_finish",[c.run_id,c.generation,controller]);}
test("SQL accepts a v2 request with operator-pinned configuration",async()=>{
 const result=await call("ax_workbench_start",[owner,wid,{key:randomUUID(),text:"集計",mode:"preview",input_file_ids:[]},`ax-run-${randomBytes(8).toString("hex")}`,exp(),token]);assert.equal(result.protocol_version,2);
});
test("admission replays once and excludes v2 attempts from legacy views",async()=>{
 const input={key:randomUUID(),text:"集計"};const results=await Promise.all(Array.from({length:4},()=>repo.start(owner,wid,input,exp(),token)));
 assert.equal(new Set(results.map(r=>r.run_id)).size,1);assert.equal(results.filter(r=>!r.replayed).length,1);
 await assert.rejects(repo.start(owner,wid,{...input,text:"別"},exp(),token),error("idempotency_conflict"));
 await assert.rejects(repo.get(bob,wid,results[0].root_id),error("workbench_not_found"));
 assert.deepEqual(await new DataRepository(pool,{image}).list(owner,wid),{runs:[]});
 assert.deepEqual(await new AgentRepository(pool,image).list(owner,wid),{roots:[]});
 await assert.rejects(new AgentRepository(pool,image).get(owner,wid,results[0].root_id),error("agent_not_found"));
 const c=await start();assert.equal(c.workbench.version,2);assert.equal(c.request.schema_version,2);
});
test("trial gate is closed; preview question can answer only after actual stop",async()=>{
 await assert.rejects(begin({mode:"model",allow_model:true}),error("workbench_disabled"));
 const accepted=await begin(), c=await start(), p={kind:"question",text:"対象列は？"};await proposal(c,p);await tool(c,p);await collect(c);
 assert.equal((await repo.get(owner,wid,accepted.root_id)).can_answer,false);await finish(c);
 const root=await repo.get(owner,wid,accepted.root_id);assert.equal(root.can_answer,true);
 const input={key:randomUUID(),question_id:root.question_id!,expected_revision:root.revision,text:"amount"};
 const next=await repo.answer(owner,wid,root.id,input,exp(),token);assert.notEqual(next.run_id,c.run_id);assert.equal((await repo.answer(owner,wid,root.id,input,exp(),token)).run_id,next.run_id);
});
test("known model overage is saved; unpriced operations hold even after stop",async()=>{
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");const root=await begin({mode:"model",allow_model:true}),c=await start();
 await proposal(c,{kind:"output",text:"too much"},{...usage,prompt_token_count:7000,total_token_count:7020});
 const op=(await pool.query("SELECT actual_usd,settlement_outcome,budget_exceeded FROM ax_agent_operations WHERE run_id=$1",[c.run_id])).rows[0];
 assert.equal(op.settlement_outcome,"failed");assert.equal(op.budget_exceeded,true);assert.ok(Number(op.actual_usd)>0);
 assert.equal((await finish(c)).resolved,true);assert.ok((await repo.get(owner,wid,root.root_id)).estimated_usd!>0);
});
test("unsettled mailbox never resends and holds the common global slot",async()=>{
 await begin();const c=await start();const {bytes}=await reserve(c,1);
 await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]),error("agent_operation_unknown"));
 assert.equal((await finish(c)).resolved,false);await assert.rejects(begin(),error("unresolved_run"));
});
const python=(inputs:string[]=[])=>({kind:"python",source:"print('ok')",input_aliases:inputs,outputs:[{name:"result.csv",size_limit_bytes:8388608}],purpose:"集計"});
async function pythonStart(inputs:string[]=[],fileIds:string[]=[]){
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");const accepted=await begin({input_file_ids:fileIds}),c=await start(),p=python(inputs);
 await proposal(c,p);await tool(c,p);await collect(c);const done=await finish(c);assert.ok(done.next_run_id);assert.equal((await call("ax_finish",[c.run_id,c.generation,controller])).next_run_id,done.next_run_id);
 const next=await start();assert.equal(next.request.adapter,"python");assert.equal(next.run_id,done.next_run_id);return {accepted,c,next};
}
async function cleanup(c:any){await call("ax_workbench_cleanup",[c.run_id,c.generation,controller,{actor:c.run_id,actor_uid:randomUUID(),worker_uid:randomUUID(),generation:randomUUID(),image,profile:"host-quota-8m-v1",cleaned:true}]);}
async function upload(bytes:Buffer,user=owner){const files=new FileRepository(pool),x=await files.begin(user,wid,{key:randomUUID(),name:"input.csv",size_bytes:bytes.length,sha256:hash(bytes)});for(let i=0;i<bytes.length;i+=32768)await files.putChunk(user,wid,x.file.id,i/32768,bytes.subarray(i,i+32768));await files.seal(user,wid,x.file.id);return x.file.id;}
test("8 MiB sealed input and output roundtrip through sequential Runtime/code/Runtime",async()=>{
 const bytes=Buffer.alloc(8388608,97),file=await upload(bytes);const {accepted,c,next}=await pythonStart(["input_1"],[file]);
 assert.equal((await call("ax_workbench_input_manifest",[next.run_id,next.generation,controller])).length,1);
 await assert.rejects(call("ax_workbench_read_chunk",[c.run_id,c.generation,controller,file,0]),error("stale_claim"));
 for(const i of [0,127,255])assert.deepEqual(Buffer.from(await call("ax_workbench_read_chunk",[next.run_id,next.generation,controller,file,i]),"hex"),bytes.subarray(i*32768,(i+1)*32768));
 const alias=next.workbench.descriptor.outputs[0].alias;
 const output=await call("ax_workbench_output_begin",[next.run_id,next.generation,controller,alias,bytes.length,hash(bytes)]);
 assert.equal((await call("ax_workbench_output_begin",[next.run_id,next.generation,controller,alias,bytes.length,hash(bytes)])).file_id,output.file_id);
 assert.equal((await new FileRepository(pool).list(owner,wid)).files.length,1);
 await assert.rejects(new FileRepository(pool).get(owner,wid,output.file_id),error("file_not_found"));
 for(let i=0;i<256;i++)await call("ax_workbench_output_chunk",[next.run_id,next.generation,controller,alias,i,bytes.subarray(i*32768,(i+1)*32768)]);
 await call("ax_workbench_output_seal",[next.run_id,next.generation,controller,alias]);
 assert.deepEqual(Buffer.from(await new FileRepository(pool).readChunk(owner,wid,output.file_id,255)),bytes.subarray(255*32768));
 await collect(next,"done",null);await cleanup(next);const done=await finish(next);assert.ok(done.next_run_id);
 const final=await start(),p={kind:"output",text:"成果物を作りました"};await proposal(final,p);await tool(final,p);await collect(final);await finish(final);
 const root=await repo.get(owner,wid,accepted.root_id);assert.equal(root.state,"succeeded");assert.equal(root.python_calls,1);assert.equal(root.output_files.length,1);assert.equal(root.model_calls,2);
});
test("Python gate, source/input bounds, and host cleanup are mandatory",async()=>{
 await begin();const c=await start(),p=python();await proposal(c,p);await assert.rejects(tool(c,p),error("python_disabled"));
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");await tool(c,p);await collect(c);const first=await finish(c);assert.ok(first.next_run_id);
 const code=await start();await collect(code,"none",null);assert.equal((await finish(code)).resolved,false);
 assert.equal((await repo.list(owner,wid)).roots[0].state,"blocked_unknown");
});
test("stop between proposal and handoff commits prior result without next Task",async()=>{
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");const x=await begin(),c=await start(),p=python();await proposal(c,p);await tool(c,p);await collect(c);await repo.stop(owner,wid,x.root_id);const done=await finish(c);
 assert.equal(done.resolved,true);assert.equal(done.next_run_id,null);assert.equal((await repo.get(owner,wid,x.root_id)).state,"stopped");
});
test("grant expiry at handoff does not rollback known result and stopped effect",async()=>{
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");const x=await begin(),c=await start(),p=python();await proposal(c,p);await tool(c,p);await collect(c);
 await pool.query("UPDATE ax_agent_roots SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[x.root_id]);const done=await finish(c);
 assert.equal(done.resolved,true);assert.equal(done.next_run_id,null);assert.equal((await pool.query("SELECT resolved,result FROM ax_runs WHERE run_id=$1",[c.run_id])).rows[0].resolved,true);
});
test("unknown claimant cannot move a chunk or assert cleanup",async()=>{
 const file=await upload(Buffer.from("a\n1\n"));const {next}=await pythonStart(["input_1"],[file]);
 await assert.rejects(call("ax_workbench_read_chunk",[next.run_id,next.generation+1,controller,file,0]),error("stale_claim"));
 await assert.rejects(call("ax_workbench_read_chunk",[next.run_id,next.generation,controller,randomUUID(),0]),error("file_not_found"));
 await assert.rejects(call("ax_workbench_cleanup",[next.run_id,next.generation,controller,{cleaned:true}]),error("invalid_evidence"));
});
test("removed membership and revoked token cannot revive old roots",async()=>{
 const x=await repo.start(bob,wid,{key:randomUUID(),text:"集計"},exp(),token),c=await start();
 await pool.query("DELETE FROM org_memberships WHERE workspace_id=$1 AND user_id=$2",[wid,bob]);
 await pool.query("INSERT INTO org_memberships VALUES($1,$2,'member','general')",[wid,bob]);
 await assert.rejects(reserve(c,1),error("agent_stopped"));await finish(c);assert.equal((await repo.get(bob,wid,x.root_id)).state,"stopped");
 await new AgentRepository(pool,image).revoke(owner,token);await assert.rejects(begin(),error("agent_grant_revoked"));
});
test("public definition versions are pinned and every use reauthorizes dependencies",async()=>{
 const defs=new DefinitionRepository(pool);const skill=await defs.create(owner,wid,{key:randomUUID(),kind:"skill",visibility:"workspace",content:{name:"csv",description:"集計",instructions:"CSVを集計",files:[]}});
 const sv=(await defs.publish(owner,wid,skill.definition.id,{key:randomUUID(),expected_revision:skill.definition.revision!})).version!;
 const agent=await defs.create(owner,wid,{key:randomUUID(),kind:"agent",visibility:"workspace",content:{name:"担当",instructions:"集計する",skill_version_ids:[sv.id],allowed_tools:["python"]}});
 const av=(await defs.publish(owner,wid,agent.definition.id,{key:randomUUID(),expected_revision:agent.definition.revision!})).version!;
 const x=await begin({agent_version_id:av.id}),c=await start();assert.equal(c.workbench.descriptor.definition_manifest[0].kind,"agent");assert.equal(c.workbench.descriptor.definition_manifest[1].id,sv.id);
 const chunk=await call("ax_workbench_definition_chunk",[c.run_id,c.generation,controller,sv.id,0]);assert.equal(hash(Buffer.from(chunk.content_base64,"base64")),sv.sha256);
 if(process.env.WORKBENCH_WRITE_FIXTURE==="1"){const agentChunk=await call("ax_workbench_definition_chunk",[c.run_id,c.generation,controller,av.id,0]);writeFileSync(new URL("../../.space/tasks/ax-agent-workbench/evidence/workbench-pg-fixture.json",import.meta.url),JSON.stringify({claim:c,definition_chunks:[agentChunk,chunk]},null,2)+"\n");}
 await defs.archive(owner,wid,skill.definition.id,{key:randomUUID(),expected_revision:(await defs.get(owner,wid,skill.definition.id)).definition.revision!});
 await assert.rejects(reserve(c,1),error("definition_dependency_unavailable"));await finish(c);assert.equal((await repo.get(owner,wid,x.root_id)).state,"failed");
});
test("legacy preview and empty-effect cancel continue working after v8",async()=>{
 const old=new AgentRepository(pool,image);const x=await call("ax_agent_start",[owner,wid,{key:randomUUID(),conversation_id:randomUUID(),text:"従来"},image,`ax-run-${randomBytes(8).toString("hex")}`,exp(),token]);const c=await call("ax_claim",[controller,30]);assert.equal(c.request.schema_version,1);assert.equal(c.run_id,x.run_id);await call("ax_cancel_unstarted",[c.run_id,c.generation,controller]);
 const next=await begin();const v2=await call("ax_claim",[controller,30]);await call("ax_cancel_unstarted",[v2.run_id,v2.generation,controller]);assert.equal((await repo.get(owner,wid,next.root_id)).state,"failed");
});

test("standalone skill and reversed input selection keep descriptor order",async()=>{
 const defs=new DefinitionRepository(pool),item=await defs.create(owner,wid,{key:randomUUID(),kind:"skill",visibility:"personal",content:{name:"csv",description:"集計",instructions:"集計する",files:[]}});
 const version=(await defs.publish(owner,wid,item.definition.id,{key:randomUUID(),expected_revision:item.definition.revision!})).version!;
 const f1=await upload(Buffer.from("a")),f2=await upload(Buffer.from("b"));await pool.query("UPDATE ax_workbench_control SET python_enabled=true");
 await begin({skill_version_ids:[version.id],input_file_ids:[f1,f2]});const c=await start(),p=python(["input_2","input_1"]);
 assert.deepEqual(c.workbench.descriptor.definition_manifest.map((x:any)=>x.id),[version.id]);await proposal(c,p);await tool(c,p);await collect(c);await finish(c);
 const code=await start();assert.deepEqual(code.workbench.descriptor.inputs.map((x:any)=>x.alias),p.input_aliases);
});
test("question answers remain in history across code handoff",async()=>{
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");const accepted=await begin(),c=await start(),q={kind:"question",text:"対象列は？"};
 await proposal(c,q);await tool(c,q);await collect(c);await finish(c);const root=await repo.get(owner,wid,accepted.root_id);
 await repo.answer(owner,wid,root.id,{key:randomUUID(),question_id:root.question_id!,expected_revision:root.revision,text:"amount列を合計"},exp(),token);
 const answer=await start(),p=python();await proposal(answer,p);await tool(answer,p);await collect(answer);await finish(answer);const code=await start();
 assert.ok(code.workbench.descriptor.history.some((x:any)=>x.kind==="user_answer"&&x.text==="amount列を合計"));
 const view=await repo.get(owner,wid,root.id);assert.deepEqual(view.messages.map(x=>x.kind),["user_start","question","user_answer","python"]);assert.equal(view.messages[2].text,"amount列を合計");assert.ok(!JSON.stringify(view.messages).includes(p.source));
 const listed=(await repo.list(owner,wid)).roots[0];assert.deepEqual(listed.messages.map(x=>x.kind),["user_start"]);assert.deepEqual(listed.checkpoints,[]);
});
test("oversized history ends handoff while retaining known result",async()=>{
 const {accepted,next}=await pythonStart();const alias=next.workbench.descriptor.outputs[0].alias;
 await call("ax_workbench_output_begin",[next.run_id,next.generation,controller,alias,1,hash("a")]);await call("ax_workbench_output_chunk",[next.run_id,next.generation,controller,alias,0,Buffer.from("a")]);await call("ax_workbench_output_seal",[next.run_id,next.generation,controller,alias]);
 await collect(next,"\u0001".repeat(8192),null);await cleanup(next);const done=await finish(next);assert.equal(done.resolved,true);assert.equal(done.next_run_id,null);
 const root=await repo.get(owner,wid,accepted.root_id);assert.equal(root.state,"failed");assert.equal(root.checkpoints.at(-1)!.text.length,8192);
});
test("active-time and call limits apply before new send without erasing settled cost",async()=>{
 const accepted=await begin(),c=await start();await pool.query("UPDATE ax_agent_roots SET active_ms=300000 WHERE id=$1",[accepted.root_id]);
 await assert.rejects(reserve(c,1),error("agent_budget_exhausted"));await finish(c);assert.equal((await repo.get(owner,wid,accepted.root_id)).state,"failed");
 const x=await begin(),next=await start();await pool.query("UPDATE ax_agent_roots SET model_calls=6 WHERE id=$1",[x.root_id]);await assert.rejects(reserve(next,1),error("agent_budget_exhausted"));await finish(next);
});
test("root estimate reserves worst case and old cumulative spending is never reset",async()=>{
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");const x=await begin({mode:"model",allow_model:true}),c=await start();
 await proposal(c,{kind:"output",text:"費用確定"},{...usage,prompt_token_count:40000,candidates_token_count:0,total_token_count:40000});await finish(c);await call("ax_review_failure",[c.run_id,"Known test overage reviewed."]);
 assert.equal(Number(await call("ax_paid_total",[false])),.01);await assert.rejects(call("ax_guard",["agent_model","new"]),error("pilot_estimate_limit_reached"));
 const next=await begin({mode:"model",allow_model:true}),n=await start();assert.equal((await reserve(n,1)).value.send,true);assert.ok(Number(await call("ax_paid_total",[true]))>.01);
 assert.equal((await repo.get(owner,wid,x.root_id)).estimated_usd,.01);assert.notEqual(next.root_id,x.root_id);
});
test("creation gate failure cancels an unstarted code allocation and releases reservations",async()=>{
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");await begin();const c=await start(),p=python();await proposal(c,p);await tool(c,p);await collect(c);await finish(c);
 const code=await call("ax_claim",[controller,30]);await pool.query("UPDATE ax_workbench_control SET python_enabled=false");await assert.rejects(effect(code,"create"),error("python_disabled"));await call("ax_cancel_unstarted",[code.run_id,code.generation,controller]);
 assert.equal((await pool.query("SELECT bool_and(released) ok FROM ax_workbench_outputs WHERE run_id=$1",[code.run_id])).rows[0].ok,true);
});
test("restricted API/controller roles commit the v2 lifecycle and cannot call private predecessors",async()=>{
 const functions=(await pool.query("SELECT p.oid::regprocedure::text signature,p.proname FROM pg_proc p WHERE p.pronamespace=current_schema()::regnamespace")).rows;
 for(const [role,names] of [["ax_api",[...apiFunctions,...workbenchApiFunctions]],["ax_execution",[...executionFunctions,...workbenchExecutionFunctions]]] as const){await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);for(const f of functions.filter(x=>names.includes(x.proname)))await pool.query(`GRANT EXECUTE ON FUNCTION ${f.signature} TO ${role}`);}
 const transaction=(role:string,sql:string)=>execFileSync("docker",["exec","-i",process.env.POSTGRES_CONTAINER??"ax-local-postgres","psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","app_auth_test"],{input:`BEGIN; SET LOCAL search_path=${schema},pg_temp; SET LOCAL ROLE ${role}; ${sql} COMMIT;`,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:10000}).trim();
 const literal=(v:unknown):string=>v instanceof Uint8Array?`decode('${Buffer.from(v).toString("hex")}','hex')`:v===null?"NULL":typeof v==="number"?String(v):`'${(typeof v==="string"?v:JSON.stringify(v)).replaceAll("'","''")}'`;
 const restricted=(name:string,args:unknown[]=[],role="ax_execution")=>{const result=transaction(role,`SELECT ${name}(${args.map(literal).join(",")});`);return result?JSON.parse(result):null;};
 const denied=(e:any)=>e.status===3&&String(e.stderr).includes("permission denied");
 const input={key:randomUUID(),text:"restricted",mode:"preview",input_file_ids:[]};const accepted=restricted("ax_workbench_start",[owner,wid,input,`ax-run-${randomBytes(8).toString("hex")}`,exp(),token],"ax_api");
 assert.throws(()=>restricted("ax_claim",[controller,30],"ax_api"),denied);assert.throws(()=>transaction("ax_api","SELECT * FROM ax_workbench_control;"),denied);
 assert.throws(()=>restricted("ax_workbench_start",[owner,wid,input,`ax-run-${randomBytes(8).toString("hex")}`,exp(),token]),denied);
 assert.throws(()=>restricted("ax_agent_reserve_v7",[accepted.run_id,1,controller,1,Buffer.from("{}")]),denied);
 const c=restricted("ax_claim",[controller,30]);assert.equal(c.run_id,accepted.run_id);
 const fx=(operation:string)=>{const op=restricted("ax_intent",[c.run_id,c.generation,controller,operation]);restricted("ax_evidence",[c.run_id,c.generation,controller,op.operation_id,operation==="egress_deny"?{egress_denied:true,actor:c.run_id}:operation==="suspend"?{phase:"SUSPENDED",worker_assignment:null,actor:c.run_id}:{confirmed:true,actor:c.run_id}]);};
 for(const op of ["create","resume","stage","egress_prepare","start"])fx(op);
 const bytes=Buffer.from(JSON.stringify({version:2,run_id:c.run_id,sequence:1,kind:"model",body:{}}));assert.equal(restricted("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]).send,true);
 const p={kind:"output",text:"ok"},response={version:2,run_id:c.run_id,sequence:1,request_sha256:hash(bytes),status:"ok",body:{response:{candidates:[{content:{parts:[{text:JSON.stringify(p)}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:0,totalTokenCount:120}}}};
 restricted("ax_agent_settle",[c.run_id,c.generation,controller,1,response,usage,1,{}]);assert.equal(restricted("ax_agent_reserve",[c.run_id,c.generation,controller,1,bytes]).send,false);
 fx("egress_deny");fx("suspend");assert.equal(restricted("ax_finish",[c.run_id,c.generation,controller]).resolved,true);assert.equal((await repo.get(owner,wid,accepted.root_id)).state,"failed");
});

test("ownerless historical expense consumes trial allowance and blocks before generation",async()=>{
 const old=`ax-run-${randomBytes(8).toString("hex")}`;
 await pool.query("INSERT INTO ax_runs(run_id,legacy,request_data,request_bytes,request_hash,image,manifest,fingerprint,phase,resolved,start_attempted,result) VALUES($1,true,'{\"adapter\":\"antigravity\"}',decode('7b7d','hex'),'legacy',$2,'{}','old','finished',true,true,$3)",[old,image,{status:"succeeded",usage,estimated_usd:.048}]);
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");await begin({mode:"model",allow_model:true});const c=await start();await assert.rejects(reserve(c,1),error("pilot_estimate_limit_reached"));assert.equal(Number(await call("ax_paid_total",[true])),.048);await finish(c);
 await pool.query("UPDATE ax_runs SET result=jsonb_set(result,'{estimated_usd}','null') WHERE run_id=$1",[old]);await assert.rejects(begin(),error("unknown_paid_usage"));
});
test("reservation and final send permission are each single-use; count-phase logout settles no-send",async()=>{
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");await begin({mode:"model",allow_model:true});const c=await start();
 const attempts=await Promise.allSettled([reserve(c,1),reserve(c,1)]);assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);const r=(attempts.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<any>).value;
 await new AgentRepository(pool,image).revoke(owner,token);await assert.rejects(call("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,"e".repeat(64),100]),error("agent_grant_revoked"));
 const zero={prompt_token_count:0,candidates_token_count:0,thoughts_token_count:0,total_token_count:0,model_call_count:0};const reply={version:2,run_id:c.run_id,sequence:1,request_sha256:hash(r.bytes),status:"denied",body:{code:"revoked"}};const evidence={outcome:"no_send",code:"revoked",payload_sha256:null,counted_input_tokens:null,count_attempt:1,http_status:null,finish_reason:null,response_sha256:null};
 await call("ax_agent_settle",[c.run_id,c.generation,controller,1,reply,zero,1,evidence]);assert.equal((await finish(c)).resolved,true);assert.equal(Number(await call("ax_paid_total",[true])),0);
});
test("output reservation participates in regular upload quota without counting it twice",async()=>{
 for(let i=0;i<31;i++)await pool.query("INSERT INTO ax_files(id,owner_user_id,workspace_id,request_key,name,size_bytes,sha256,media_type,state,ready_at) VALUES($1,$2,$3,$4,'synthetic.csv',8388608,$5,'text/csv','ready',clock_timestamp())",[randomUUID(),owner,wid,randomUUID(),hash("quota fixture")]);
 const {next}=await pythonStart();await assert.rejects(new FileRepository(pool).begin(owner,wid,{key:randomUUID(),name:"extra.csv",size_bytes:1,sha256:hash("a")}),error("file_quota_exceeded"));
 const alias=next.workbench.descriptor.outputs[0].alias;await call("ax_workbench_output_begin",[next.run_id,next.generation,controller,alias,8388608,hash("reserved fixture")]);
 assert.equal(Number((await pool.query("SELECT sum(size_bytes) n FROM ax_files WHERE owner_user_id=$1",[owner])).rows[0].n),268435456);
 await cleanup(next);await finish(next);const x=await new FileRepository(pool).begin(owner,wid,{key:randomUUID(),name:"new.csv",size_bytes:1,sha256:hash("a")});assert.equal(x.file.size_bytes,1);
});
test("generation ACK loss holds without another send permission",async()=>{
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");await begin({mode:"model",allow_model:true});const c=await start();const r=await reserve(c,1);await call("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,"f".repeat(64),100]);
 await assert.rejects(call("ax_agent_authorize_generation",[c.run_id,c.generation,controller,1,"f".repeat(64),100]),error("agent_operation_unknown"));await assert.rejects(call("ax_agent_reserve",[c.run_id,c.generation,controller,1,r.bytes]),error("agent_operation_unknown"));assert.equal((await finish(c)).resolved,false);assert.ok(Number(await call("ax_paid_total",[true]))>0);
});

test("collect rejects malformed result types without losing settled model expense",async()=>{
 await pool.query("UPDATE ax_workbench_control SET trial_enabled=true");await begin({mode:"model",allow_model:true});const c=await start();await proposal(c);
 const value={schema_version:2,run_id:c.run_id,adapter:"interactive",status:"succeeded",exit_code:0,error_type:null,summary:"done",usage,estimated_usd:0};
 for(const change of [{usage:{}},{usage:{...usage,model_call_count:"1"}},{estimated_usd:"0"},{estimated_usd:-1},{error_type:"unexpected"}])await assert.rejects(call("ax_collect",[c.run_id,c.generation,controller,{...value,...change},null]),error("invalid_result"));
 assert.ok(Number((await pool.query("SELECT actual_usd FROM ax_agent_operations WHERE run_id=$1 AND sequence=1",[c.run_id])).rows[0].actual_usd)>0);await finish(c);assert.equal((await pool.query("SELECT resolved FROM ax_runs WHERE run_id=$1",[c.run_id])).rows[0].resolved,true);
});

test("Python proposal enforces source, selected files, output bytes and safe names",async()=>{
 const model=(p:any)=>({candidates:[{content:{parts:[{text:JSON.stringify(p)}]},finishReason:"STOP"}]});
 const p={...python(),source:"a".repeat(4096)};assert.ok(await call("ax_workbench_proposal",[model(p)]));
 for(const change of [{source:"a".repeat(4097)},{input_aliases:["input_1","input_1"]},{input_aliases:["a","b","c","d","e"]},{outputs:[{name:"_result.csv",size_limit_bytes:1}]},{outputs:[{name:"a.csv",size_limit_bytes:8388608},{name:"b.csv",size_limit_bytes:1}]}])assert.equal(await call("ax_workbench_proposal",[model({...p,...change})]),null);
 await pool.query("UPDATE ax_workbench_control SET python_enabled=true");const x=await begin(),c=await start();await proposal(c,python());await pool.query("UPDATE ax_agent_roots SET python_calls=3 WHERE id=$1",[x.root_id]);await assert.rejects(tool(c,python()),error("agent_budget_exhausted"));
});
