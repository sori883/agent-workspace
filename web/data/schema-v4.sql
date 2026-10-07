SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
CREATE TABLE ax_agent_roots(
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid NOT NULL REFERENCES org_workspaces(id),
 conversation_id uuid NOT NULL UNIQUE REFERENCES ax_conversations(id), current_run_id text REFERENCES ax_runs(run_id),
 state text NOT NULL CHECK(state IN ('running','stopping','waiting_input','succeeded','failed','blocked_unknown','stopped')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), stop_requested boolean NOT NULL DEFAULT false,
 grant_expires_at timestamptz NOT NULL, grant_token_hash text NOT NULL CHECK(grant_token_hash ~ '^[0-9a-f]{64}$'), wait_expires_at timestamptz, question text,
 model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 3), tool_calls integer NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 2),
 input_tokens integer NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens integer NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 active_ms bigint NOT NULL DEFAULT 0 CHECK(active_ms>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 skill_id text NOT NULL DEFAULT 'brief-v1' CHECK(skill_id='brief-v1'),
 skill_sha256 text NOT NULL DEFAULT 'd394bcd09724ff69fd758a42247caa323626525316f59c989346ddc3ee8f64fe'
);
CREATE TABLE ax_agent_segments(
 run_id text PRIMARY KEY REFERENCES ax_runs(run_id), root_id uuid NOT NULL REFERENCES ax_agent_roots(id),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2), started_at timestamptz, finished_at timestamptz,
 proposal jsonb, UNIQUE(root_id,sequence)
);
CREATE TABLE ax_agent_operations(
 run_id text NOT NULL REFERENCES ax_agent_segments(run_id), sequence integer NOT NULL CHECK(sequence IN (1,2)),
 generation bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('model','tool')), request_bytes bytea NOT NULL CHECK(octet_length(request_bytes)<=65536),
 request_hash text NOT NULL CHECK(request_hash=encode(sha256(request_bytes),'hex')),
 response jsonb, usage jsonb, elapsed_ms integer, reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
 PRIMARY KEY(run_id,sequence), CHECK((sequence=1 AND kind='model') OR (sequence=2 AND kind='tool'))
);
CREATE TABLE ax_agent_requests(
 owner_user_id uuid NOT NULL REFERENCES users(id), key uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('start','answer')),
 payload jsonb NOT NULL, root_id uuid NOT NULL REFERENCES ax_agent_roots(id), run_id text NOT NULL REFERENCES ax_runs(run_id),
 PRIMARY KEY(owner_user_id,key)
);

CREATE TABLE ax_agent_revocations(owner_user_id uuid NOT NULL REFERENCES users(id),token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_user_id,token_hash));
CREATE FUNCTION ax_agent_owner_lock(owner uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF owner IS NULL THEN PERFORM ax_error('invalid_owner_user_id'); END IF;
 PERFORM pg_advisory_xact_lock(926017,hashtext(owner::text));
END $$;
CREATE FUNCTION ax_agent_check_token(owner uuid,token_hash text) RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
 IF EXISTS(SELECT 1 FROM ax_agent_revocations r WHERE r.owner_user_id=owner AND r.token_hash=ax_agent_check_token.token_hash) THEN PERFORM ax_error('agent_grant_revoked'); END IF;
END $$;

DO $$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('ax_validate_request(jsonb)'::regprocedure);
 source:=replace(source,'''offline'',''antigravity''','''offline'',''antigravity'',''interactive''');
 EXECUTE source;
 source:=pg_get_functiondef('ax_intent_v1(text,bigint,text,text)'::regprocedure);
 source:=replace(source,$old$r.request_data->>'adapter'='offline'$old$,$new$r.request_data->>'adapter' IN ('offline','interactive')$new$);
 source:=replace(source,$old$r.request_data->>'adapter'<>'offline'$old$,$new$r.request_data->>'adapter' NOT IN ('offline','interactive')$new$);
 EXECUTE source;
END $$;
ALTER FUNCTION ax_validate_result(jsonb,text,text,text,bytea) RENAME TO ax_validate_result_v3;
CREATE FUNCTION ax_validate_result(value jsonb,run text,adapter text,output text,artifact bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF adapter='interactive' THEN
  IF value->>'adapter'<>'interactive' OR (value->'estimated_usd' IS DISTINCT FROM '0'::jsonb AND NOT (value->>'status'<>'succeeded' AND value->'estimated_usd'='null'::jsonb)) THEN PERFORM ax_error('invalid_paid_usage'); END IF;
  PERFORM ax_validate_result_v3(value,run,adapter,output,artifact);
 ELSE PERFORM ax_validate_result_v3(value,run,adapter,output,artifact); END IF;
END $$;
ALTER FUNCTION ax_manifest(text,text) RENAME TO ax_manifest_v3;
CREATE FUNCTION ax_manifest(run text,image text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ax_runs WHERE run_id=run AND request_data->>'adapter'='interactive')
 THEN jsonb_set(ax_manifest_v3(run,image),'{metadata,atespace}','"ax-runtime"') ELSE ax_manifest_v3(run,image) END
$$;
CREATE FUNCTION ax_agent_view(a ax_agent_roots) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',a.id,'conversation_id',a.conversation_id,'state',CASE WHEN a.state IN ('running','stopping') AND EXISTS(SELECT 1 FROM ax_jobs WHERE run_id=a.current_run_id AND state='claimed' AND lease_until<=clock_timestamp()) THEN 'blocked_unknown' ELSE a.state END,'revision',a.revision,
 'question_id',CASE WHEN a.question IS NOT NULL THEN a.id END,'question',a.question,
 'can_answer',a.state='waiting_input' AND NOT a.stop_requested AND a.wait_expires_at>clock_timestamp(),
 'stop_requested',a.stop_requested,'model_calls',a.model_calls,'tool_calls',a.tool_calls,'active_ms',a.active_ms,
 'grant_expires_at',to_char(a.grant_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'wait_expires_at',CASE WHEN a.wait_expires_at IS NOT NULL THEN to_char(a.wait_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,'preview',true)
$$;
CREATE FUNCTION ax_agent_authorize(owner uuid,wid uuid,root uuid) RETURNS ax_agent_roots LANGUAGE plpgsql STABLE AS $$
DECLARE a ax_agent_roots;
BEGIN
 SELECT * INTO a FROM ax_agent_roots WHERE id=root AND owner_user_id=owner AND workspace_id=wid;
 IF NOT FOUND THEN PERFORM ax_error('agent_not_found'); END IF;
 PERFORM org_authorize(owner,wid); RETURN a;
END $$;
CREATE FUNCTION ax_agent_get(owner uuid,wid uuid,root uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN RETURN ax_agent_view(ax_agent_authorize(owner,wid,root)); END $$;
CREATE FUNCTION ax_agent_list(owner uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM org_authorize(owner,wid);
 RETURN jsonb_build_object('roots',coalesce((SELECT jsonb_agg(ax_agent_view(a) ORDER BY a.created_at DESC) FROM (SELECT * FROM ax_agent_roots WHERE owner_user_id=owner AND workspace_id=wid ORDER BY created_at DESC LIMIT 50) a),'[]'::jsonb));
END $$;
CREATE FUNCTION ax_agent_read_conversation(owner uuid,cid uuid,wid uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE root uuid;
BEGIN
 PERFORM org_authorize(owner,wid);
 SELECT id INTO root FROM ax_agent_roots WHERE owner_user_id=owner AND workspace_id=wid AND conversation_id=cid;
 RETURN root;
END $$;
CREATE FUNCTION ax_agent_new_segment(a ax_agent_roots,text_input text,run text,image text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c ax_conversations; req jsonb; runtime jsonb; signature text; stamp text; total numeric; num integer; previous text;
BEGIN
 IF text_input IS NULL OR octet_length(text_input) NOT BETWEEN 1 AND 2048 OR text_input !~ '[^[:space:]]' OR run !~ '^ax-run-[0-9a-f]{16}$' OR image !~ '^localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
 SELECT * INTO c FROM ax_conversations WHERE id=a.conversation_id FOR UPDATE;
 IF c.owner_user_id<>a.owner_user_id OR c.workspace_id<>a.workspace_id OR c.invalid OR c.turn_count>=2 THEN PERFORM ax_error('invalid_conversation_state'); END IF;
 num:=c.turn_count+1;
 runtime:=jsonb_build_object('version',1,'root_id',a.id,'phase',CASE WHEN num=1 THEN 'request' ELSE 'answer' END,'question_id',CASE WHEN num=2 THEN a.id END,'skill_id',a.skill_id,'remaining_ms',90000-a.active_ms);
 req:=jsonb_build_object('schema_version',1,'run_id',run,'adapter','interactive','instruction',text_input,'inputs',jsonb_build_object('conversation.json',convert_from(c.context_bytes,'UTF8'),'runtime.json',ax_json(runtime,true)),'output_name','reply.txt');
 PERFORM ax_validate_request(req);
 signature:=encode(sha256(convert_to(ax_json((req-'run_id')||jsonb_build_object('image',image)),'UTF8')),'hex');
 total:=ax_guard('interactive',signature);
 IF NOT (SELECT accepting FROM ax_control WHERE id) THEN PERFORM ax_error('admission_closed'); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 previous:=current_setting('ax.workspace_id',true); PERFORM set_config('ax.workspace_id',a.workspace_id::text,true);
 INSERT INTO ax_runs(run_id,owner_user_id,actor_id,conversation_id,sequence,parent_run_id,request_data,request_bytes,request_hash,image,manifest,fingerprint,accepted_at,phase,known_estimated_usd_before)
 VALUES(run,a.owner_user_id,'user:'||a.owner_user_id,a.conversation_id,num,c.head_run_id,req,convert_to(ax_json(req,true),'UTF8'),encode(sha256(convert_to(ax_json(req,true),'UTF8')),'hex'),image,jsonb_set(ax_manifest_v3(run,image),'{metadata,atespace}','"ax-runtime"'),signature,stamp,'accepted',total);
 PERFORM set_config('ax.workspace_id',coalesce(previous,''),true);
 INSERT INTO ax_agent_segments(run_id,root_id,sequence) VALUES(run,a.id,num);
 INSERT INTO ax_jobs(run_id,kind,state) VALUES(run,'execute','ready');
 UPDATE ax_execution_slot SET run_id=run,hold_reason='unresolved_run' WHERE id;
 UPDATE ax_conversations SET head_run_id=run,turn_count=num WHERE id=a.conversation_id;
 UPDATE ax_agent_roots SET current_run_id=run,state='running' WHERE id=a.id;
END $$;
CREATE FUNCTION ax_agent_start(owner uuid,wid uuid,payload jsonb,image text,run text,expires bigint,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; cid uuid; request_key uuid; previous text;
BEGIN
 PERFORM ax_agent_owner_lock(owner);
 PERFORM 1 FROM org_workspaces WHERE id=wid FOR SHARE; PERFORM org_authorize(owner,wid);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>3 OR NOT payload ?& ARRAY['key','conversation_id','text'] OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN cid:=(payload->>'conversation_id')::uuid; request_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 IF cid IS NULL OR request_key IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND key=request_key;
 IF FOUND THEN
  IF prior.kind<>'start' OR prior.payload<>payload OR (SELECT workspace_id FROM ax_agent_roots WHERE id=prior.root_id)<>wid THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',prior.root_id,'conversation_id',cid,'run_id',prior.run_id,'replayed',true);
 END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 IF expires IS NULL OR to_timestamp(expires)<=clock_timestamp() THEN PERFORM ax_error('agent_grant_expired'); END IF;
 IF EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid AND (owner_user_id IS DISTINCT FROM owner OR workspace_id IS DISTINCT FROM wid)) THEN PERFORM ax_error('conversation_not_found'); END IF;
 IF EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid) THEN PERFORM ax_error('conversation_conflict'); END IF;
 previous:=current_setting('ax.workspace_id',true); PERFORM set_config('ax.workspace_id',wid::text,true);
 INSERT INTO ax_conversations(id,owner_user_id) VALUES(cid,owner);
 PERFORM set_config('ax.workspace_id',coalesce(previous,''),true);
 INSERT INTO ax_agent_roots(id,owner_user_id,workspace_id,conversation_id,state,grant_expires_at,grant_token_hash) VALUES(gen_random_uuid(),owner,wid,cid,'running',to_timestamp(expires),token_hash) RETURNING * INTO a;
 PERFORM ax_agent_new_segment(a,payload->>'text',run,image);
 INSERT INTO ax_agent_requests VALUES(owner,request_key,'start',payload,a.id,run);
 RETURN jsonb_build_object('root_id',a.id,'conversation_id',cid,'run_id',run,'replayed',false);
END $$;
CREATE FUNCTION ax_agent_answer(owner uuid,wid uuid,root uuid,payload jsonb,image text,run text,expires bigint,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; request_key uuid; question uuid; revision integer;
BEGIN
 PERFORM ax_agent_owner_lock(owner);
 PERFORM 1 FROM org_workspaces WHERE id=wid FOR SHARE; a:=ax_agent_authorize(owner,wid,root);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['key','question_id','expected_revision','text'] OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN request_key:=(payload->>'key')::uuid; question:=(payload->>'question_id')::uuid; revision:=(payload->>'expected_revision')::integer; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN PERFORM ax_error('invalid_request'); END;
 IF request_key IS NULL OR question IS NULL OR revision IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND key=request_key;
 IF FOUND THEN
  IF prior.kind<>'answer' OR prior.root_id<>root OR prior.payload<>payload THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',root,'conversation_id',a.conversation_id,'run_id',prior.run_id,'replayed',true);
 END IF;
 SELECT * INTO a FROM ax_agent_roots WHERE id=root FOR UPDATE;
 IF a.state<>'waiting_input' OR a.stop_requested OR a.id<>question OR a.revision<>revision OR a.wait_expires_at<=clock_timestamp() THEN PERFORM ax_error('agent_answer_conflict'); END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 IF expires IS NULL OR to_timestamp(expires)<=clock_timestamp() THEN PERFORM ax_error('agent_grant_expired'); END IF;
 IF a.active_ms>=90000 OR a.model_calls>=3 OR a.tool_calls>=2 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 UPDATE ax_agent_roots SET grant_expires_at=to_timestamp(expires),grant_token_hash=token_hash,revision=a.revision+1,wait_expires_at=NULL WHERE id=root RETURNING * INTO a;
 PERFORM ax_agent_new_segment(a,payload->>'text',run,image);
 INSERT INTO ax_agent_requests VALUES(owner,request_key,'answer',payload,root,run);
 RETURN jsonb_build_object('root_id',root,'conversation_id',a.conversation_id,'run_id',run,'replayed',false);
END $$;
ALTER FUNCTION ax_ws_accept(uuid,text,uuid,jsonb,text,text,uuid) RENAME TO ax_ws_accept_v3;
CREATE FUNCTION ax_ws_accept(owner uuid,kind text,cid uuid,payload jsonb,image text,proposed_run text,wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 IF wid IS NULL THEN PERFORM ax_error('workspace_required'); END IF;
 PERFORM org_authorize(owner,wid);
 IF EXISTS(SELECT 1 FROM ax_agent_roots WHERE conversation_id=cid AND (owner_user_id<>owner OR workspace_id<>wid)) THEN PERFORM ax_error('conversation_not_found'); END IF;
 IF EXISTS(SELECT 1 FROM ax_agent_roots WHERE conversation_id=cid) THEN PERFORM ax_error('agent_managed_conversation'); END IF;
 RETURN ax_ws_accept_v3(owner,kind,cid,payload,image,proposed_run,wid);
END $$;
CREATE FUNCTION ax_agent_stop(owner uuid,wid uuid,root uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots;
BEGIN
 a:=ax_agent_authorize(owner,wid,root);
 UPDATE ax_agent_roots SET stop_requested=true,revision=revision+1,state=CASE WHEN state='waiting_input' THEN 'stopped' WHEN state='running' THEN 'stopping' ELSE state END WHERE id=root AND NOT stop_requested AND state NOT IN ('succeeded','failed','stopped');
 RETURN '{"ok":true}'::jsonb;
END $$;
CREATE FUNCTION ax_agent_revoke(owner uuid,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM ax_agent_owner_lock(owner); PERFORM org_active(owner);
 IF token_hash IS NULL OR token_hash !~ '^[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
 INSERT INTO ax_agent_revocations(owner_user_id,token_hash) VALUES(owner,token_hash) ON CONFLICT DO NOTHING;
 UPDATE ax_agent_roots SET stop_requested=true,revision=revision+1,state=CASE WHEN state='waiting_input' THEN 'stopped' WHEN state='running' THEN 'stopping' ELSE state END WHERE owner_user_id=owner AND NOT stop_requested AND state NOT IN ('succeeded','failed','stopped');
 RETURN '{"ok":true}'::jsonb;
END $$;
CREATE FUNCTION ax_agent_json_unique(value json) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE child json;
BEGIN
 IF json_typeof(value)='object' THEN
  IF (SELECT count(*)<>count(DISTINCT key) FROM json_each(value)) THEN RETURN false; END IF;
  FOR child IN SELECT e.value FROM json_each(value) e LOOP IF NOT ax_agent_json_unique(child) THEN RETURN false; END IF; END LOOP;
 ELSIF json_typeof(value)='array' THEN
  FOR child IN SELECT e.value FROM json_array_elements(value) e LOOP IF NOT ax_agent_json_unique(child) THEN RETURN false; END IF; END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION ax_agent_live(run text) RETURNS ax_agent_roots LANGUAGE plpgsql AS $$
DECLARE a ax_agent_roots; began timestamptz;
BEGIN
 SELECT r.* INTO a FROM ax_agent_roots r JOIN ax_agent_segments s ON s.root_id=r.id WHERE s.run_id=run FOR UPDATE OF r;
 IF NOT FOUND THEN PERFORM ax_error('agent_not_found'); END IF;
 IF EXISTS(SELECT 1 FROM ax_agent_revocations WHERE owner_user_id=a.owner_user_id AND token_hash=a.grant_token_hash) THEN PERFORM ax_error('agent_stopped'); END IF;
 IF a.stop_requested OR a.state NOT IN ('running','stopping') THEN PERFORM ax_error('agent_stopped'); END IF;
 IF a.grant_expires_at<=clock_timestamp() THEN PERFORM ax_error('agent_grant_expired'); END IF;
 IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=a.workspace_id AND m.user_id=a.owner_user_id AND u.status='active') THEN PERFORM ax_error('workspace_access_revoked'); END IF;
 SELECT intent_at INTO began FROM ax_effects WHERE run_id=run AND operation='start';
 IF a.active_ms+coalesce(extract(epoch FROM clock_timestamp()-began)*1000,0)>=90000 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 RETURN a;
END $$;
ALTER FUNCTION ax_intent(text,bigint,text,text) RENAME TO ax_intent_v3;
CREATE FUNCTION ax_intent(run text,gen bigint,controller text,operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs;
BEGIN
 r:=ax_check_claim(run,gen,controller);
 IF r.request_data->>'adapter'='interactive' AND operation NOT IN ('egress_deny','suspend') THEN
  PERFORM 1 FROM org_workspaces WHERE id=r.workspace_id FOR SHARE;
  PERFORM ax_agent_live(run);
 END IF;
 RETURN ax_intent_v3(run,gen,controller,operation);
END $$;
CREATE FUNCTION ax_agent_reserve(run text,gen bigint,controller text,seq integer,request_bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; a ax_agent_roots; prior ax_agent_operations; raw json; request jsonb; digest text; proposed jsonb;
BEGIN
 r:=ax_check_claim(run,gen,controller);
 IF r.request_data->>'adapter'<>'interactive' OR NOT r.start_attempted OR seq IS NULL OR seq NOT IN (1,2) OR request_bytes IS NULL OR octet_length(request_bytes)>65536 THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN raw:=convert_from(request_bytes,'UTF8')::json; request:=raw::jsonb; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF NOT ax_agent_json_unique(raw) OR jsonb_typeof(request) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(request))<>5 OR NOT request ?& ARRAY['version','run_id','sequence','kind','body'] OR
 request->'version' IS DISTINCT FROM '1'::jsonb OR request->>'run_id' IS DISTINCT FROM run OR request->'sequence' IS DISTINCT FROM to_jsonb(seq) OR request->>'kind' IS DISTINCT FROM (CASE WHEN seq=1 THEN 'model' ELSE 'tool' END) OR jsonb_typeof(request->'body') IS DISTINCT FROM 'object' THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(request_bytes),'hex');
 SELECT * INTO prior FROM ax_agent_operations WHERE run_id=run AND sequence=seq;
 IF FOUND THEN
  IF prior.request_hash<>digest OR prior.request_bytes<>request_bytes THEN PERFORM ax_error('agent_operation_conflict'); END IF;
  IF prior.response IS NULL THEN PERFORM ax_error('agent_operation_unknown'); END IF;
  RETURN jsonb_build_object('send',false,'response',prior.response);
 END IF;
 a:=ax_agent_live(run);
 SELECT * INTO prior FROM ax_agent_operations WHERE run_id=run AND sequence=seq;
 IF FOUND THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF seq=1 THEN
  IF a.model_calls>=3 OR a.input_tokens+100>6000 OR a.output_tokens+20>512 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
  UPDATE ax_agent_roots SET model_calls=model_calls+1 WHERE id=a.id;
 ELSE
  SELECT proposal INTO proposed FROM ax_agent_segments WHERE run_id=run;
  IF proposed IS NULL OR proposed<>request->'body' OR NOT EXISTS(SELECT 1 FROM ax_agent_operations WHERE run_id=run AND sequence=1 AND response IS NOT NULL) THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
  IF a.tool_calls>=2 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
  UPDATE ax_agent_roots SET tool_calls=tool_calls+1 WHERE id=a.id;
 END IF;
 INSERT INTO ax_agent_operations(run_id,sequence,generation,kind,request_bytes,request_hash) VALUES(run,seq,gen,request->>'kind',request_bytes,digest);
 RETURN '{"send":true,"response":null}'::jsonb;
END $$;
CREATE FUNCTION ax_agent_settle(run text,gen bigint,controller text,seq integer,response jsonb,usage jsonb,elapsed_ms integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE o ax_agent_operations; a ax_agent_roots; proposal jsonb; model jsonb; raw json; expected_usage jsonb; n integer;
BEGIN
 PERFORM ax_check_claim(run,gen,controller);
 SELECT r.* INTO a FROM ax_agent_roots r JOIN ax_agent_segments s ON s.root_id=r.id WHERE s.run_id=run FOR UPDATE OF r;
 SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq FOR UPDATE;
 IF NOT FOUND OR o.generation<>gen THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF o.response IS NOT NULL THEN
  IF o.response<>response OR o.usage<>usage THEN PERFORM ax_error('agent_operation_conflict'); END IF;
  RETURN;
 END IF;
 IF response IS NULL OR jsonb_typeof(response)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(response))<>6 OR NOT response ?& ARRAY['version','run_id','sequence','request_sha256','status','body'] OR
 response->'version' IS DISTINCT FROM '1'::jsonb OR response->>'run_id' IS DISTINCT FROM run OR response->'sequence' IS DISTINCT FROM to_jsonb(seq) OR response->>'request_sha256' IS DISTINCT FROM o.request_hash OR response->>'status' IS DISTINCT FROM 'ok' OR elapsed_ms IS NULL OR elapsed_ms<0 THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 IF seq=1 THEN
  model:=response->'body'->'response';
  IF jsonb_typeof(model) IS DISTINCT FROM 'object' OR jsonb_array_length(model->'candidates') IS DISTINCT FROM 1 OR jsonb_array_length(model->'candidates'->0->'content'->'parts') IS DISTINCT FROM 1 THEN PERFORM ax_error('agent_response_mismatch'); END IF;
  BEGIN raw:=(model->'candidates'->0->'content'->'parts'->0->>'text')::json; proposal:=raw::jsonb; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('agent_proposal_mismatch'); END;
  IF proposal IS NULL OR NOT ax_agent_json_unique(raw) OR jsonb_typeof(proposal)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(proposal))<>2 OR NOT proposal ?& ARRAY['kind','text'] OR proposal->>'kind' NOT IN ('question','output','unsupported') OR jsonb_typeof(proposal->'text') IS DISTINCT FROM 'string' OR octet_length(proposal->>'text') NOT BETWEEN 1 AND 2048 OR (proposal->>'text') !~ '[^[:space:]]' THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
  SELECT sequence INTO n FROM ax_agent_segments WHERE run_id=run;
  IF n=2 AND proposal->>'kind'='question' THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
  expected_usage:=jsonb_build_object('prompt_token_count',100,'candidates_token_count',20,'thoughts_token_count',0,'total_token_count',120,'model_call_count',1);
  IF usage IS DISTINCT FROM expected_usage OR model->'usageMetadata' IS DISTINCT FROM '{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":0,"totalTokenCount":120}'::jsonb THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
  IF a.input_tokens+100>6000 OR a.output_tokens+20>512 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
  UPDATE ax_agent_roots SET input_tokens=input_tokens+100,output_tokens=output_tokens+20 WHERE id=a.id;
  UPDATE ax_agent_segments SET proposal=(raw::jsonb) WHERE run_id=run;
 ELSE
  IF response->'body' IS DISTINCT FROM '{"accepted":true}'::jsonb OR usage IS DISTINCT FROM '{}'::jsonb THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 END IF;
 UPDATE ax_agent_operations SET response=ax_agent_settle.response,usage=ax_agent_settle.usage,elapsed_ms=ax_agent_settle.elapsed_ms,settled_at=clock_timestamp() WHERE run_id=run AND sequence=seq;
END $$;
ALTER FUNCTION ax_finish(text,bigint,text) RENAME TO ax_finish_v3;
CREATE FUNCTION ax_finish(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; a ax_agent_roots; s ax_agent_segments; model ax_agent_operations; tool ax_agent_operations; result jsonb; elapsed bigint; next_state text;
BEGIN
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 r:=ax_check_claim(run,gen,controller);
 IF r.request_data->>'adapter'<>'interactive' THEN RETURN ax_finish_v3(run,gen,controller); END IF;
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
 IF (r.result IS NULL OR (r.result->>'status'<>'succeeded' AND r.result->'usage'='null'::jsonb))
 AND EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='egress_deny' AND evidence=jsonb_build_object('egress_denied',true,'actor',run))
 AND EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='suspend' AND evidence=jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run)) THEN
  INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','gateway_terminal','original_result',r.result,'reason','confirmed_interruption'));
  r.result:=coalesce(r.result,jsonb_build_object('schema_version',1,'run_id',run,'adapter','interactive','status','failed','exit_code',1,'stop_reason',NULL,'error_type','agent_interrupted','artifact',NULL)) ||
   jsonb_build_object('usage',coalesce(model.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'::jsonb),'estimated_usd',0);
  UPDATE ax_runs SET result=r.result WHERE run_id=run;
 END IF;
 IF r.result IS NOT NULL AND r.result->'usage' IS DISTINCT FROM coalesce(model.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'::jsonb) THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
 IF r.result->>'status'='succeeded' THEN
  IF model.response IS NULL OR tool.response IS NULL OR s.proposal IS NULL OR NOT EXISTS(SELECT 1 FROM ax_artifacts WHERE run_id=run AND content=convert_to(s.proposal->>'text','UTF8')) THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
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
ALTER FUNCTION ax_cancel_unstarted(text,bigint,text) RENAME TO ax_cancel_unstarted_v3;
CREATE FUNCTION ax_cancel_unstarted(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE result jsonb;
BEGIN
 result:=ax_cancel_unstarted_v3(run,gen,controller);
 UPDATE ax_agent_roots SET state=CASE WHEN stop_requested THEN 'stopped' ELSE 'failed' END,revision=revision+1 WHERE current_run_id=run;
 RETURN result;
END $$;
ALTER FUNCTION ax_request_recovery(uuid,text) RENAME TO ax_request_recovery_v3;
CREATE FUNCTION ax_request_recovery(owner uuid,run text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE result jsonb;
BEGIN
 result:=ax_request_recovery_v3(owner,run);
 IF EXISTS(SELECT 1 FROM ax_runs WHERE run_id=run AND resolved AND outcome='not_started') THEN
  UPDATE ax_agent_roots SET state=CASE WHEN stop_requested THEN 'stopped' ELSE 'failed' END,revision=revision+1 WHERE current_run_id=run AND state IN ('running','stopping','blocked_unknown');
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION ax_fail(text,bigint,text,text) RENAME TO ax_fail_v3;
CREATE FUNCTION ax_fail(run text,gen bigint,controller text,code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM ax_fail_v3(run,gen,controller,code);
 UPDATE ax_agent_roots SET state='blocked_unknown' WHERE current_run_id=run;
END $$;
CREATE FUNCTION ax_agent_membership_revoked() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 PERFORM 1 FROM org_workspaces WHERE id=OLD.workspace_id FOR UPDATE;
 UPDATE ax_agent_roots SET stop_requested=true,revision=revision+1,state=CASE WHEN state='waiting_input' THEN 'stopped' WHEN state='running' THEN 'stopping' ELSE state END
 WHERE owner_user_id=OLD.user_id AND workspace_id=OLD.workspace_id AND NOT stop_requested AND state NOT IN ('succeeded','failed','stopped');
 RETURN OLD;
END $$;
CREATE TRIGGER ax_agent_membership_revoked AFTER DELETE ON org_memberships FOR EACH ROW EXECUTE FUNCTION ax_agent_membership_revoked();
CREATE FUNCTION ax_agent_user_disabled() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
 IF OLD.status='active' AND NEW.status<>'active' THEN
  PERFORM ax_agent_owner_lock(OLD.id);
  UPDATE ax_agent_roots SET stop_requested=true,revision=revision+1,state=CASE WHEN state='waiting_input' THEN 'stopped' WHEN state='running' THEN 'stopping' ELSE state END
  WHERE owner_user_id=OLD.id AND NOT stop_requested AND state NOT IN ('succeeded','failed','stopped');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_agent_user_disabled BEFORE UPDATE OF status ON users FOR EACH ROW EXECUTE FUNCTION ax_agent_user_disabled();
DO $$
DECLARE f record; role_name text;
BEGIN
 FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  IF f.proname IN ('ax_ws_accept_v3','ax_intent_v3','ax_finish_v3','ax_validate_result_v3','ax_manifest_v3','ax_request_recovery_v3','ax_cancel_unstarted_v3','ax_fail_v3') THEN
   FOREACH role_name IN ARRAY ARRAY['ax_api','ax_execution'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name); END IF;
   END LOOP;
  END IF;
 END LOOP;
END $$;
