SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
CREATE TABLE ax_agent_profiles(
 id text PRIMARY KEY, model text, input_usd_per_million numeric NOT NULL CHECK(input_usd_per_million>=0), output_usd_per_million numeric NOT NULL CHECK(output_usd_per_million>=0)
);
INSERT INTO ax_agent_profiles VALUES('preview-v1',NULL,0,0),('gemini-3.1-flash-lite-standard-2026-10-07-v1','gemini-3.1-flash-lite',0.25,1.50);
ALTER TABLE ax_agent_roots ADD COLUMN mode text NOT NULL DEFAULT 'preview' CHECK(mode IN ('preview','model')),
 ADD COLUMN profile_id text NOT NULL DEFAULT 'preview-v1' REFERENCES ax_agent_profiles(id),
 ADD CONSTRAINT ax_agent_mode_profile CHECK((mode='preview' AND profile_id='preview-v1') OR (mode='model' AND profile_id='gemini-3.1-flash-lite-standard-2026-10-07-v1'));
ALTER TABLE ax_agent_segments ADD COLUMN execution_manifest jsonb NOT NULL DEFAULT '{"version":1,"mode":"preview","profile_id":"preview-v1"}',
 ADD COLUMN paid_fingerprint text;
ALTER TABLE ax_agent_operations ADD COLUMN input_limit integer,
 ADD COLUMN output_limit integer,
 ADD COLUMN reserved_usd numeric NOT NULL DEFAULT 0 CHECK(reserved_usd>=0),
 ADD COLUMN actual_usd numeric CHECK(actual_usd>=0),
 ADD COLUMN generation_started boolean NOT NULL DEFAULT false,
 ADD COLUMN payload_sha256 text,
 ADD COLUMN counted_input_tokens integer,
 ADD COLUMN settlement_outcome text CHECK(settlement_outcome IN ('ok','failed','no_send')),
 ADD COLUMN provider_evidence jsonb,
 ADD COLUMN submitted_response jsonb,
 ADD COLUMN budget_exceeded boolean NOT NULL DEFAULT false;
CREATE FUNCTION ax_agent_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ax_agent_roots' THEN
  IF ROW(NEW.mode,NEW.profile_id) IS DISTINCT FROM ROW(OLD.mode,OLD.profile_id) THEN PERFORM ax_error('immutable_agent_mode'); END IF;
 ELSE
  IF ROW(NEW.execution_manifest,NEW.paid_fingerprint) IS DISTINCT FROM ROW(OLD.execution_manifest,OLD.paid_fingerprint) THEN PERFORM ax_error('immutable_agent_manifest'); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_agent_policy_immutable BEFORE UPDATE ON ax_agent_roots FOR EACH ROW EXECUTE FUNCTION ax_agent_policy_immutable();
CREATE TRIGGER ax_agent_manifest_immutable BEFORE UPDATE ON ax_agent_segments FOR EACH ROW EXECUTE FUNCTION ax_agent_policy_immutable();
CREATE FUNCTION ax_agent_start_payload(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE mode text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& ARRAY['key','conversation_id','text'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('key','conversation_id','text','mode','allow_model')) THEN PERFORM ax_error('invalid_request'); END IF;
 mode:=coalesce(p->>'mode','preview');
 IF mode NOT IN ('preview','model') OR (p ? 'mode' AND jsonb_typeof(p->'mode')<>'string') OR (p ? 'allow_model' AND jsonb_typeof(p->'allow_model')<>'boolean') THEN PERFORM ax_error('invalid_request'); END IF;
 IF mode='model' AND p->'allow_model' IS DISTINCT FROM 'true'::jsonb THEN PERFORM ax_error('model_not_allowed'); END IF;
 RETURN (p-'mode'-'allow_model')||jsonb_build_object('mode',mode,'allow_model',mode='model');
END $$;
CREATE FUNCTION ax_agent_price(profile text,input_tokens bigint,output_tokens bigint) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE p ax_agent_profiles;
BEGIN
 SELECT * INTO p FROM ax_agent_profiles WHERE id=profile;
 IF NOT FOUND OR input_tokens IS NULL OR output_tokens IS NULL OR input_tokens<0 OR output_tokens<0 THEN PERFORM ax_error('invalid_paid_usage'); END IF;
 RETURN round((input_tokens*p.input_usd_per_million+output_tokens*p.output_usd_per_million)/1000000,9);
END $$;
CREATE FUNCTION ax_paid_total(include_reservations boolean DEFAULT false) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum((result->>'estimated_usd')::numeric) FROM ax_runs WHERE request_data->>'adapter'='antigravity' AND start_attempted AND jsonb_typeof(result->'estimated_usd')='number'),0)
 +coalesce((SELECT sum(CASE WHEN o.settled_at IS NOT NULL THEN o.actual_usd WHEN include_reservations THEN o.reserved_usd ELSE 0 END)
 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) JOIN ax_agent_roots a ON a.id=s.root_id WHERE a.mode='model' AND o.kind='model'),0)
$$;
CREATE OR REPLACE FUNCTION ax_guard(adapter text, signature text) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE r ax_runs; total numeric; paid boolean; attempted boolean; sig text;
BEGIN
 paid:=adapter IN ('antigravity','agent_model');
 FOR r IN SELECT * FROM ax_runs ORDER BY run_id LOOP
  IF r.invalid THEN PERFORM ax_error('invalid_run_ledger'); END IF;
  IF NOT r.resolved THEN PERFORM ax_error('unresolved_run'); END IF;
  attempted:=r.request_data->>'adapter'='antigravity' AND r.start_attempted;
  sig:=r.fingerprint;
  IF EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) JOIN ax_agent_roots a ON a.id=s.root_id WHERE o.run_id=r.run_id AND a.mode='model' AND o.kind='model' AND o.generation_started) THEN
   attempted:=true; SELECT paid_fingerprint INTO sig FROM ax_agent_segments WHERE run_id=r.run_id;
  END IF;
  IF attempted THEN
   IF r.result IS NULL OR r.result->'usage' IS NULL OR r.result->'usage'='null'::jsonb OR r.result->'estimated_usd' IS NULL OR r.result->'estimated_usd'='null'::jsonb THEN PERFORM ax_error('unknown_paid_usage'); END IF;
   IF jsonb_typeof(r.result->'estimated_usd')<>'number' OR (r.result->>'estimated_usd')::numeric<0 THEN PERFORM ax_error('invalid_paid_usage'); END IF;
   IF paid AND r.result->>'status'<>'succeeded' THEN
    IF sig=signature THEN PERFORM ax_error('failed_request_already_attempted'); END IF;
    IF r.failure_review IS NULL OR jsonb_typeof(r.failure_review->'note') IS DISTINCT FROM 'string' OR (r.failure_review->>'note') !~ '[^[:space:]]' OR octet_length(r.failure_review->>'note')>2048 THEN PERFORM ax_error('paid_failure_requires_review'); END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) JOIN ax_agent_roots a ON a.id=s.root_id WHERE a.mode='model' AND o.kind='model' AND (o.settled_at IS NULL OR o.actual_usd IS NULL)) THEN PERFORM ax_error('unknown_paid_usage'); END IF;
 total:=ax_paid_total(true);
 IF paid AND total>=0.01 THEN PERFORM ax_error('pilot_estimate_limit_reached'); END IF;
 RETURN total;
END $$;

CREATE OR REPLACE FUNCTION ax_agent_new_segment(a ax_agent_roots,text_input text,run text,image text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c ax_conversations; req jsonb; runtime jsonb; signature text; stamp text; total numeric; num integer; previous text; paid_signature text;
BEGIN
 IF text_input IS NULL OR octet_length(text_input) NOT BETWEEN 1 AND 2048 OR text_input !~ '[^[:space:]]' OR run !~ '^ax-run-[0-9a-f]{16}$' OR image !~ '^localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
 SELECT * INTO c FROM ax_conversations WHERE id=a.conversation_id FOR UPDATE;
 IF c.owner_user_id<>a.owner_user_id OR c.workspace_id<>a.workspace_id OR c.invalid OR c.turn_count>=2 THEN PERFORM ax_error('invalid_conversation_state'); END IF;
 num:=c.turn_count+1;
 runtime:=jsonb_build_object('version',1,'root_id',a.id,'phase',CASE WHEN num=1 THEN 'request' ELSE 'answer' END,'question_id',CASE WHEN num=2 THEN a.id END,'skill_id',a.skill_id,'remaining_ms',90000-a.active_ms);
 req:=jsonb_build_object('schema_version',1,'run_id',run,'adapter','interactive','instruction',text_input,'inputs',jsonb_build_object('conversation.json',convert_from(c.context_bytes,'UTF8'),'runtime.json',ax_json(runtime,true)),'output_name','reply.txt');
 PERFORM ax_validate_request(req);
 signature:=encode(sha256(convert_to(ax_json((req-'run_id')||jsonb_build_object('image',image)),'UTF8')),'hex');
 paid_signature:=encode(sha256(convert_to(ax_json(jsonb_build_object('instruction',text_input,'history',encode(c.context_bytes,'hex'),'phase',num,'profile',a.profile_id,'skill',a.skill_sha256,'image',image)),'UTF8')),'hex');
 total:=ax_guard(CASE WHEN a.mode='model' THEN 'agent_model' ELSE 'interactive' END,paid_signature);
 IF NOT (SELECT accepting FROM ax_control WHERE id) THEN PERFORM ax_error('admission_closed'); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 previous:=current_setting('ax.workspace_id',true); PERFORM set_config('ax.workspace_id',a.workspace_id::text,true);
 INSERT INTO ax_runs(run_id,owner_user_id,actor_id,conversation_id,sequence,parent_run_id,request_data,request_bytes,request_hash,image,manifest,fingerprint,accepted_at,phase,known_estimated_usd_before)
 VALUES(run,a.owner_user_id,'user:'||a.owner_user_id,a.conversation_id,num,c.head_run_id,req,convert_to(ax_json(req,true),'UTF8'),encode(sha256(convert_to(ax_json(req,true),'UTF8')),'hex'),image,jsonb_set(ax_manifest_v3(run,image),'{metadata,atespace}','"ax-runtime"'),signature,stamp,'accepted',total);
 PERFORM set_config('ax.workspace_id',coalesce(previous,''),true);
 INSERT INTO ax_agent_segments(run_id,root_id,sequence,execution_manifest,paid_fingerprint) VALUES(run,a.id,num,jsonb_build_object('version',1,'mode',a.mode,'profile_id',a.profile_id),paid_signature);
 INSERT INTO ax_jobs(run_id,kind,state) VALUES(run,'execute','ready');
 UPDATE ax_execution_slot SET run_id=run,hold_reason='unresolved_run' WHERE id;
 UPDATE ax_conversations SET head_run_id=run,turn_count=num WHERE id=a.conversation_id;
 UPDATE ax_agent_roots SET current_run_id=run,state='running' WHERE id=a.id;
END $$;
CREATE OR REPLACE FUNCTION ax_agent_start(owner uuid,wid uuid,payload jsonb,image text,run text,expires bigint,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; cid uuid; request_key uuid; previous text;
BEGIN
 payload:=ax_agent_start_payload(payload);
 PERFORM ax_agent_owner_lock(owner);
 PERFORM 1 FROM org_workspaces WHERE id=wid FOR SHARE; PERFORM org_authorize(owner,wid);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>5 OR NOT payload ?& ARRAY['key','conversation_id','text'] OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN cid:=(payload->>'conversation_id')::uuid; request_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 IF cid IS NULL OR request_key IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND key=request_key;
 IF FOUND THEN
  IF prior.kind<>'start' OR ax_agent_start_payload(prior.payload)<>payload OR (SELECT workspace_id FROM ax_agent_roots WHERE id=prior.root_id)<>wid THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',prior.root_id,'conversation_id',cid,'run_id',prior.run_id,'replayed',true);
 END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 IF expires IS NULL OR to_timestamp(expires)<=clock_timestamp() THEN PERFORM ax_error('agent_grant_expired'); END IF;
 IF EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid AND (owner_user_id IS DISTINCT FROM owner OR workspace_id IS DISTINCT FROM wid)) THEN PERFORM ax_error('conversation_not_found'); END IF;
 IF EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid) THEN PERFORM ax_error('conversation_conflict'); END IF;
 previous:=current_setting('ax.workspace_id',true); PERFORM set_config('ax.workspace_id',wid::text,true);
 INSERT INTO ax_conversations(id,owner_user_id) VALUES(cid,owner);
 PERFORM set_config('ax.workspace_id',coalesce(previous,''),true);
 INSERT INTO ax_agent_roots(id,owner_user_id,workspace_id,conversation_id,state,grant_expires_at,grant_token_hash,mode,profile_id) VALUES(gen_random_uuid(),owner,wid,cid,'running',to_timestamp(expires),token_hash,payload->>'mode',CASE WHEN payload->>'mode'='model' THEN 'gemini-3.1-flash-lite-standard-2026-10-07-v1' ELSE 'preview-v1' END) RETURNING * INTO a;
 PERFORM ax_agent_new_segment(a,payload->>'text',run,image);
 INSERT INTO ax_agent_requests VALUES(owner,request_key,'start',payload,a.id,run);
 RETURN jsonb_build_object('root_id',a.id,'conversation_id',cid,'run_id',run,'replayed',false);
END $$;
ALTER FUNCTION ax_agent_view(ax_agent_roots) RENAME TO ax_agent_view_v4;
CREATE FUNCTION ax_agent_view(a ax_agent_roots) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT ax_agent_view_v4(a)||jsonb_build_object('mode',a.mode,'preview',a.mode='preview','model',(SELECT model FROM ax_agent_profiles WHERE id=a.profile_id),
 'estimated_usd',CASE WHEN a.mode='preview' THEN 0 WHEN EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.kind='model' AND o.settled_at IS NULL) THEN NULL ELSE coalesce((SELECT sum(o.actual_usd) FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.kind='model'),0) END)
$$;
ALTER FUNCTION ax_claim(text,integer) RENAME TO ax_claim_v4;
CREATE FUNCTION ax_claim(controller_id text,lease_seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE v jsonb; m jsonb;
BEGIN
 v:=ax_claim_v4(controller_id,lease_seconds);
 IF v IS NULL THEN RETURN NULL; END IF;
 SELECT s.execution_manifest INTO m FROM ax_agent_segments s JOIN ax_agent_roots a ON a.id=s.root_id WHERE s.run_id=v->>'run_id' AND s.execution_manifest=jsonb_build_object('version',1,'mode',a.mode,'profile_id',a.profile_id);
 IF v->'request'->>'adapter'='interactive' THEN
  IF m IS NULL THEN PERFORM ax_error('agent_manifest_mismatch'); END IF;
  RETURN v||jsonb_build_object('agent',m-'version');
 END IF;
 RETURN v;
END $$;
ALTER FUNCTION ax_snapshot(ax_runs,boolean) RENAME TO ax_snapshot_v4;
CREATE FUNCTION ax_snapshot(r ax_runs,with_artifact boolean DEFAULT true) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT ax_snapshot_v4(r,with_artifact)||coalesce((SELECT jsonb_build_object('agent_mode',execution_manifest->>'mode') FROM ax_agent_segments WHERE run_id=r.run_id),'{}'::jsonb)
$$;
ALTER FUNCTION ax_agent_reserve(text,bigint,text,integer,bytea) RENAME TO ax_agent_reserve_v4;
CREATE FUNCTION ax_agent_reserve(run text,gen bigint,controller text,seq integer,request_bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; a ax_agent_roots; prior ax_agent_operations; raw json; request jsonb; digest text; input_cap integer; output_cap integer; reservation numeric;
BEGIN
 SELECT roots.* INTO a FROM ax_agent_roots roots JOIN ax_agent_segments s ON s.root_id=roots.id WHERE s.run_id=run;
 IF NOT FOUND OR a.mode='preview' OR seq=2 THEN RETURN ax_agent_reserve_v4(run,gen,controller,seq,request_bytes)||jsonb_build_object('profile_id',a.profile_id,'input_limit',0,'output_limit',0); END IF;
 PERFORM 1 FROM org_workspaces WHERE id=a.workspace_id FOR SHARE;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 r:=ax_check_claim(run,gen,controller);
 IF r.request_data->>'adapter'<>'interactive' OR NOT r.start_attempted OR seq IS DISTINCT FROM 1 OR request_bytes IS NULL OR octet_length(request_bytes)>65536 THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN raw:=convert_from(request_bytes,'UTF8')::json; request:=raw::jsonb; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF NOT ax_agent_json_unique(raw) OR jsonb_typeof(request) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(request))<>5 OR NOT request ?& ARRAY['version','run_id','sequence','kind','body'] OR request->'version' IS DISTINCT FROM '1'::jsonb OR request->>'run_id' IS DISTINCT FROM run OR request->'sequence' IS DISTINCT FROM '1'::jsonb OR request->>'kind' IS DISTINCT FROM 'model' OR jsonb_typeof(request->'body') IS DISTINCT FROM 'object' THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(request_bytes),'hex');
 SELECT * INTO prior FROM ax_agent_operations WHERE run_id=run AND sequence=1;
 IF FOUND THEN
  IF prior.request_hash<>digest OR prior.request_bytes<>request_bytes THEN PERFORM ax_error('agent_operation_conflict'); END IF;
  IF prior.settled_at IS NULL THEN PERFORM ax_error('agent_operation_unknown'); END IF;
  RETURN jsonb_build_object('send',false,'response',prior.response,'input_limit',prior.input_limit,'output_limit',prior.output_limit,'profile_id',a.profile_id);
 END IF;
 a:=ax_agent_live(run);
 input_cap:=6000-a.input_tokens; output_cap:=least(256,512-a.output_tokens);
 IF a.model_calls>=3 OR input_cap<=128 OR output_cap<=0 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 reservation:=ax_agent_price(a.profile_id,input_cap,output_cap);
 IF ax_paid_total(true)+reservation>0.01 THEN PERFORM ax_error('pilot_estimate_limit_reached'); END IF;
 INSERT INTO ax_agent_operations(run_id,sequence,generation,kind,request_bytes,request_hash,input_limit,output_limit,reserved_usd)
 VALUES(run,1,gen,'model',request_bytes,digest,input_cap,output_cap,reservation);
 RETURN jsonb_build_object('send',true,'response',NULL,'input_limit',input_cap,'output_limit',output_cap,'profile_id',a.profile_id);
END $$;
CREATE FUNCTION ax_agent_authorize_generation(run text,gen bigint,controller text,seq integer,payload_sha256 text,counted_input_tokens integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; o ax_agent_operations;
BEGIN
 SELECT roots.* INTO a FROM ax_agent_roots roots JOIN ax_agent_segments s ON s.root_id=roots.id WHERE s.run_id=run;
 PERFORM 1 FROM org_workspaces WHERE id=a.workspace_id FOR SHARE;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 PERFORM ax_check_claim(run,gen,controller);
 a:=ax_agent_live(run);
 SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq FOR UPDATE;
 IF NOT FOUND OR a.mode<>'model' OR seq IS DISTINCT FROM 1 OR o.generation<>gen OR o.generation_started OR o.settled_at IS NOT NULL THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF payload_sha256 IS NULL OR payload_sha256 !~ '^[0-9a-f]{64}$' OR counted_input_tokens IS NULL OR counted_input_tokens<0 THEN PERFORM ax_error('invalid_request'); END IF;
 IF counted_input_tokens>o.input_limit-128 OR a.model_calls>=3 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 UPDATE ax_agent_operations SET generation_started=true,payload_sha256=ax_agent_authorize_generation.payload_sha256,counted_input_tokens=ax_agent_authorize_generation.counted_input_tokens WHERE run_id=run AND sequence=seq;
 UPDATE ax_agent_roots SET model_calls=model_calls+1 WHERE id=a.id;
 RETURN '{"send":true}'::jsonb;
END $$;
CREATE FUNCTION ax_agent_proposal(model jsonb,segment integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE raw json; proposal jsonb;
BEGIN
 IF jsonb_typeof(model) IS DISTINCT FROM 'object' OR jsonb_array_length(model->'candidates') IS DISTINCT FROM 1 OR jsonb_array_length(model->'candidates'->0->'content'->'parts') IS DISTINCT FROM 1 OR model->'candidates'->0->>'finishReason' IS DISTINCT FROM 'STOP' THEN RETURN NULL; END IF;
 raw:=(model->'candidates'->0->'content'->'parts'->0->>'text')::json; proposal:=raw::jsonb;
 IF proposal IS NULL OR NOT ax_agent_json_unique(raw) OR jsonb_typeof(proposal)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(proposal))<>2 OR NOT proposal ?& ARRAY['kind','text'] OR coalesce(proposal->>'kind','') NOT IN ('question','output','unsupported') OR (segment=2 AND proposal->>'kind'='question') OR jsonb_typeof(proposal->'text') IS DISTINCT FROM 'string' OR octet_length(proposal->>'text') NOT BETWEEN 1 AND 2048 OR (proposal->>'text') !~ '[^[:space:]]' THEN RETURN NULL; END IF;
 RETURN proposal;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
ALTER FUNCTION ax_agent_settle(text,bigint,text,integer,jsonb,jsonb,integer) RENAME TO ax_agent_settle_v4;
CREATE FUNCTION ax_agent_settle(run text,gen bigint,controller text,seq integer,response jsonb,usage jsonb,elapsed_ms integer,evidence jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; o ax_agent_operations; s ax_agent_segments; cost numeric; proposed jsonb; output_count bigint; exceeded boolean; n text; amount jsonb; outcome text; saved jsonb; model jsonb;
BEGIN
 SELECT roots.* INTO a FROM ax_agent_roots roots JOIN ax_agent_segments seg ON seg.root_id=roots.id WHERE seg.run_id=run;
 IF NOT FOUND OR a.mode='preview' OR seq=2 THEN PERFORM ax_agent_settle_v4(run,gen,controller,seq,response,usage,elapsed_ms); RETURN; END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 PERFORM ax_check_claim(run,gen,controller);
 SELECT * INTO a FROM ax_agent_roots WHERE id=a.id FOR UPDATE;
 SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq FOR UPDATE;
 IF NOT FOUND OR seq IS DISTINCT FROM 1 OR o.generation<>gen THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF o.settled_at IS NOT NULL THEN
  IF o.usage IS DISTINCT FROM usage OR o.provider_evidence IS DISTINCT FROM evidence OR o.submitted_response IS DISTINCT FROM response THEN PERFORM ax_error('agent_operation_conflict'); END IF;
  RETURN;
 END IF;
 IF evidence IS NULL OR jsonb_typeof(evidence)<>'object' OR octet_length(evidence::text)>2048 OR (SELECT count(*) FROM jsonb_object_keys(evidence))<>8 OR NOT evidence ?& ARRAY['outcome','code','payload_sha256','counted_input_tokens','count_attempt','http_status','finish_reason','response_sha256'] OR coalesce(evidence->>'outcome','') NOT IN ('ok','failed','no_send') OR coalesce(evidence->>'code','') !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$' OR evidence->'count_attempt' NOT IN ('0'::jsonb,'1'::jsonb) THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 FOREACH n IN ARRAY ARRAY['payload_sha256','response_sha256'] LOOP
  IF evidence->n IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->n)<>'string' OR evidence->>n !~ '^[0-9a-f]{64}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 END LOOP;
 IF evidence->'counted_input_tokens' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'counted_input_tokens')<>'number' OR evidence->>'counted_input_tokens' !~ '^[0-9]{1,9}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 IF evidence->'http_status' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'http_status')<>'number' OR evidence->>'http_status' !~ '^[1-5][0-9]{2}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 IF evidence->'finish_reason' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'finish_reason')<>'string' OR evidence->>'finish_reason' !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 outcome:=evidence->>'outcome';
 IF jsonb_typeof(usage) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(usage))<>5 OR NOT usage ?& ARRAY['prompt_token_count','candidates_token_count','thoughts_token_count','total_token_count','model_call_count'] THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 FOR n,amount IN SELECT * FROM jsonb_each(usage) LOOP
  IF jsonb_typeof(amount)<>'number' OR amount::text !~ '^[0-9]+$' OR amount::text::numeric>1000000 THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 END LOOP;
 output_count:=(usage->>'candidates_token_count')::bigint+(usage->>'thoughts_token_count')::bigint;
 IF (usage->>'total_token_count')::bigint<>(usage->>'prompt_token_count')::bigint+output_count THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 IF outcome='no_send' THEN
  IF o.generation_started OR EXISTS(SELECT 1 FROM jsonb_each(usage) x WHERE x.value<>'0'::jsonb) THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 ELSE
  IF NOT o.generation_started OR (usage->>'model_call_count')::int<>1 OR (usage->>'prompt_token_count')::int<=0 OR evidence->'count_attempt'<>'1'::jsonb OR evidence->>'payload_sha256' IS DISTINCT FROM o.payload_sha256 OR (evidence->>'counted_input_tokens')::integer IS DISTINCT FROM o.counted_input_tokens OR evidence->'response_sha256'='null'::jsonb THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 END IF;
 IF response IS NULL OR jsonb_typeof(response)<>'object' OR octet_length(response::text)>65536 OR (SELECT count(*) FROM jsonb_object_keys(response))<>6 OR NOT response ?& ARRAY['version','run_id','sequence','request_sha256','status','body'] OR response->'version' IS DISTINCT FROM '1'::jsonb OR response->>'run_id' IS DISTINCT FROM run OR response->'sequence' IS DISTINCT FROM to_jsonb(seq) OR response->>'request_sha256' IS DISTINCT FROM o.request_hash OR elapsed_ms IS NULL OR elapsed_ms<0 THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 cost:=ax_agent_price(a.profile_id,(usage->>'prompt_token_count')::bigint,output_count);
 exceeded:=a.input_tokens+(usage->>'prompt_token_count')::bigint>6000 OR a.output_tokens+output_count>512 OR (usage->>'prompt_token_count')::bigint>o.input_limit OR output_count>o.output_limit OR cost>o.reserved_usd OR ax_paid_total(false)+cost>0.01;
 saved:=response;
 IF outcome='ok' THEN
  model:=response->'body'->'response';
  IF response->>'status' IS DISTINCT FROM 'ok' OR model->'usageMetadata' IS DISTINCT FROM jsonb_build_object('promptTokenCount',(usage->>'prompt_token_count')::int,'candidatesTokenCount',(usage->>'candidates_token_count')::int,'thoughtsTokenCount',(usage->>'thoughts_token_count')::int,'totalTokenCount',(usage->>'total_token_count')::int) OR response->'body'->'billing' IS DISTINCT FROM jsonb_build_object('profile_id',a.profile_id,'estimated_usd',cost) THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
  proposed:=ax_agent_proposal(model,s.sequence);
  IF proposed IS NULL OR exceeded OR evidence->>'finish_reason' IS DISTINCT FROM 'STOP' THEN
   outcome:='failed'; saved:=jsonb_set(jsonb_set(response,'{status}','"denied"'),'{body}',jsonb_build_object('code',CASE WHEN exceeded THEN 'agent_budget_exhausted' ELSE 'agent_proposal_mismatch' END));
  END IF;
 ELSE
  IF response->>'status' IS DISTINCT FROM 'denied' OR response->'body' IS DISTINCT FROM jsonb_build_object('code',evidence->>'code') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 END IF;
 UPDATE ax_agent_operations SET response=saved,usage=ax_agent_settle.usage,elapsed_ms=ax_agent_settle.elapsed_ms,settled_at=clock_timestamp(),actual_usd=cost,settlement_outcome=outcome,provider_evidence=evidence,submitted_response=ax_agent_settle.response,budget_exceeded=exceeded WHERE run_id=run AND sequence=seq;
 UPDATE ax_agent_roots SET input_tokens=input_tokens+(usage->>'prompt_token_count')::int,output_tokens=output_tokens+output_count::int WHERE id=a.id;
 IF outcome='ok' THEN UPDATE ax_agent_segments SET proposal=proposed WHERE run_id=run; END IF;
END $$;

ALTER FUNCTION ax_finish(text,bigint,text) RENAME TO ax_finish_v4;
CREATE FUNCTION ax_finish(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; a ax_agent_roots; s ax_agent_segments; model ax_agent_operations; tool ax_agent_operations; result jsonb; elapsed bigint; next_state text; cost numeric;
BEGIN
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 r:=ax_check_claim(run,gen,controller);
 IF NOT EXISTS(SELECT 1 FROM ax_agent_segments seg JOIN ax_agent_roots roots ON roots.id=seg.root_id WHERE seg.run_id=run AND roots.mode='model') THEN RETURN ax_finish_v4(run,gen,controller); END IF;
 SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 SELECT * INTO a FROM ax_agent_roots WHERE id=s.root_id FOR UPDATE;
 SELECT * INTO model FROM ax_agent_operations WHERE run_id=run AND sequence=1;
 SELECT * INTO tool FROM ax_agent_operations WHERE run_id=run AND sequence=2;
 IF EXISTS(SELECT 1 FROM ax_agent_operations WHERE run_id=run AND response IS NULL) THEN
  UPDATE ax_agent_roots SET state='blocked_unknown' WHERE id=a.id;
  UPDATE ax_execution_slot SET hold_reason='agent_operation_unknown' WHERE id;
  UPDATE ax_runs SET phase='needs_recovery',error_type='agent_operation_unknown' WHERE run_id=run;
  UPDATE ax_jobs SET state='held',lease_until=NULL WHERE run_id=run;
  RETURN '{"resolved":false,"outcome":"failed"}'::jsonb;
 END IF;
 cost:=coalesce(model.actual_usd,0);
 IF (r.result IS NULL OR r.result->'usage' IS DISTINCT FROM coalesce(model.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'::jsonb) OR model.settlement_outcome IN ('failed','no_send'))
 AND EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='egress_deny' AND evidence=jsonb_build_object('egress_denied',true,'actor',run))
 AND EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='suspend' AND evidence=jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run)) THEN
  INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','gateway_terminal','original_result',r.result,'reason','confirmed_interruption'));
  r.result:=coalesce(r.result,jsonb_build_object('schema_version',1,'run_id',run,'adapter','interactive','status','failed','exit_code',1,'stop_reason',NULL,'error_type','agent_interrupted','artifact',NULL)) ||
   jsonb_build_object('status','failed','exit_code',1,'error_type',coalesce(model.response->'body'->>'code','agent_interrupted'),'usage',coalesce(model.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'::jsonb),'estimated_usd',cost);
  UPDATE ax_runs SET result=r.result WHERE run_id=run;
 END IF;
 IF r.result IS NOT NULL THEN
  IF r.result->'estimated_usd' IS DISTINCT FROM to_jsonb(cost) THEN INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','gateway_billing','original_result',r.result)); END IF;
  r.result:=r.result||jsonb_build_object('estimated_usd',cost); UPDATE ax_runs SET result=r.result WHERE run_id=run;
 END IF;
 IF r.result IS NOT NULL AND r.result->'usage' IS DISTINCT FROM coalesce(model.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'::jsonb) THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 IF r.result->>'status'='succeeded' THEN
  IF model.settlement_outcome IS DISTINCT FROM 'ok' OR model.response IS NULL OR tool.response IS NULL OR s.proposal IS NULL OR NOT EXISTS(SELECT 1 FROM ax_artifacts WHERE run_id=run AND content=convert_to(s.proposal->>'text','UTF8')) THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
 END IF;
 result:=ax_finish_v3(run,gen,controller);
 IF result->'resolved'='true'::jsonb THEN
  SELECT greatest(0,ceil(extract(epoch FROM coalesce((SELECT min(o.observed_at) FROM ax_observations o JOIN ax_effects e ON e.operation_id=o.operation_id WHERE o.run_id=run AND e.operation='suspend' AND o.evidence=jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run)),clock_timestamp())-intent_at)*1000))::bigint INTO elapsed FROM ax_effects WHERE run_id=run AND operation='start';
  elapsed:=coalesce(elapsed,0);
  next_state:=CASE WHEN a.stop_requested THEN 'stopped' WHEN result->>'outcome'<>'succeeded' OR a.active_ms+elapsed>90000 THEN 'failed' WHEN s.proposal->>'kind'='question' THEN 'waiting_input' ELSE 'succeeded' END;
  UPDATE ax_agent_roots SET state=next_state,revision=revision+1,active_ms=active_ms+elapsed,question=CASE WHEN next_state='waiting_input' THEN s.proposal->>'text' ELSE question END,wait_expires_at=CASE WHEN next_state='waiting_input' THEN clock_timestamp()+interval '24 hours' END WHERE id=a.id;
  UPDATE ax_agent_segments SET finished_at=clock_timestamp() WHERE run_id=run;
 ELSE UPDATE ax_agent_roots SET state='blocked_unknown' WHERE id=a.id; END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION ax_review_failure(run text, note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; body bytea;
BEGIN
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  SELECT * INTO r FROM ax_runs WHERE run_id=run FOR UPDATE;
  IF NOT FOUND THEN PERFORM ax_error('run_not_found'); END IF;
  IF note IS NULL OR note !~ '[^[:space:]]' OR octet_length(note)>2048 THEN PERFORM ax_error('invalid_review_note'); END IF;
  IF NOT r.resolved OR r.cleanup<>'{"egress_denied":true,"suspended":true}'::jsonb OR r.cleanup_errors<>'[]'::jsonb OR r.result IS NULL OR r.result->'usage'='null'::jsonb OR r.result->'estimated_usd'='null'::jsonb THEN PERFORM ax_error('failure_review_unresolved'); END IF;
  IF (r.request_data->>'adapter'<>'antigravity' AND NOT EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) JOIN ax_agent_roots a ON a.id=s.root_id WHERE o.run_id=run AND a.mode='model' AND o.generation_started)) OR NOT r.start_attempted OR r.result->>'status'='succeeded' THEN PERFORM ax_error('not_failed_paid_run'); END IF;
  SELECT content INTO body FROM ax_artifacts WHERE run_id=run;
  PERFORM ax_validate_result(r.result,run,r.request_data->>'adapter',r.request_data->>'output_name',body);
  IF r.failure_review IS NOT NULL THEN
    IF r.failure_review->>'note' IS DISTINCT FROM note THEN PERFORM ax_error('failure_already_reviewed'); END IF;
    RETURN;
  END IF;
  UPDATE ax_runs SET failure_review=jsonb_build_object('note',note,'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE run_id=run;
END $$;
ALTER FUNCTION ax_validate_result(jsonb,text,text,text,bytea) RENAME TO ax_validate_result_v4;
CREATE FUNCTION ax_validate_result(value jsonb,run text,adapter text,output text,artifact bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF adapter='interactive' AND EXISTS(SELECT 1 FROM ax_agent_segments s JOIN ax_agent_roots a ON a.id=s.root_id WHERE s.run_id=run AND a.mode='model') THEN
  PERFORM ax_validate_result_v3(value,run,adapter,output,artifact);
 ELSE PERFORM ax_validate_result_v4(value,run,adapter,output,artifact); END IF;
END $$;
DO $$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('ax_claim_v4(text,integer)'::regprocedure);
 EXECUTE replace(source,'ax_claim.controller_id','ax_claim_v4.controller_id');
 source:=pg_get_functiondef('ax_agent_settle_v4(text,bigint,text,integer,jsonb,jsonb,integer)'::regprocedure);
 EXECUTE replace(source,'ax_agent_settle.','ax_agent_settle_v4.');
END $$;
DO $$
DECLARE f record; role_name text;
BEGIN
 FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  IF f.proname ~ '_v[1-4]$' THEN
   FOREACH role_name IN ARRAY ARRAY['ax_api','ax_execution'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name); END IF;
   END LOOP;
  END IF;
 END LOOP;
END $$;
