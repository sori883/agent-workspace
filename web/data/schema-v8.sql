SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
CREATE TABLE ax_workbench_control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), trial_enabled boolean NOT NULL DEFAULT false, python_enabled boolean NOT NULL DEFAULT false,
 runtime_image text, code_image text, code_profile text CHECK(code_profile IS NULL OR code_profile='host-quota-8m-v1'),
 CHECK(runtime_image IS NULL OR runtime_image ~ '^localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$'),
 CHECK(code_image IS NULL OR code_image ~ '^localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$')
);
INSERT INTO ax_workbench_control(id) VALUES(true);
ALTER TABLE ax_agent_roots ADD COLUMN runtime_version integer NOT NULL DEFAULT 1 CHECK(runtime_version IN (1,2)),
 ADD COLUMN execution_policy text NOT NULL DEFAULT 'legacy-v1', ADD COLUMN definition_version_id uuid REFERENCES ax_definition_versions(id),
 ADD COLUMN definition_manifest jsonb NOT NULL DEFAULT '[]', ADD COLUMN initial_text text, ADD COLUMN python_calls integer NOT NULL DEFAULT 0 CHECK(python_calls BETWEEN 0 AND 3),
 ADD COLUMN question_id uuid, ADD COLUMN runtime_image text, ADD COLUMN code_image text, ADD COLUMN code_profile text;
ALTER TABLE ax_agent_roots ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE ax_agent_roots DROP CONSTRAINT ax_agent_roots_model_calls_check, DROP CONSTRAINT ax_agent_roots_tool_calls_check;
ALTER TABLE ax_agent_roots ADD CONSTRAINT ax_workbench_root_limits CHECK (
 (runtime_version=1 AND conversation_id IS NOT NULL AND execution_policy='legacy-v1' AND model_calls BETWEEN 0 AND 3 AND tool_calls BETWEEN 0 AND 2 AND python_calls=0)
 OR (runtime_version=2 AND conversation_id IS NULL AND execution_policy='workbench-trial-2026-10-07-v1' AND model_calls BETWEEN 0 AND 6 AND tool_calls BETWEEN 0 AND 8));
ALTER TABLE ax_agent_segments DROP CONSTRAINT ax_agent_segments_sequence_check;
ALTER TABLE ax_agent_segments ADD CONSTRAINT ax_agent_segments_sequence_check CHECK(sequence BETWEEN 1 AND 9),
 ADD COLUMN attempt_kind text NOT NULL DEFAULT 'runtime' CHECK(attempt_kind IN ('runtime','python')), ADD COLUMN predecessor_run_id text UNIQUE REFERENCES ax_runs(run_id),
 ADD COLUMN descriptor jsonb NOT NULL DEFAULT '{}', ADD COLUMN checkpoint_revision integer NOT NULL DEFAULT 0,
 ADD COLUMN host_cleanup jsonb, ADD COLUMN finish_generation bigint, ADD COLUMN finish_controller text, ADD COLUMN finish_response jsonb;
ALTER TABLE ax_files ADD CONSTRAINT ax_files_scope_unique UNIQUE(id,owner_user_id,workspace_id);
ALTER TABLE ax_agent_roots ADD CONSTRAINT ax_workbench_root_scope UNIQUE(id,owner_user_id,workspace_id);
CREATE TABLE ax_workbench_files (
 root_id uuid NOT NULL, owner_user_id uuid NOT NULL, workspace_id uuid NOT NULL, alias text NOT NULL CHECK(alias ~ '^[a-z][a-z0-9_]{0,63}$'),
 file_id uuid NOT NULL, source_run_id text REFERENCES ax_runs(run_id), PRIMARY KEY(root_id,alias), UNIQUE(root_id,file_id),
 FOREIGN KEY(root_id,owner_user_id,workspace_id) REFERENCES ax_agent_roots(id,owner_user_id,workspace_id),
 FOREIGN KEY(file_id,owner_user_id,workspace_id) REFERENCES ax_files(id,owner_user_id,workspace_id)
);
CREATE TABLE ax_workbench_checkpoints(root_id uuid NOT NULL REFERENCES ax_agent_roots(id),revision integer NOT NULL,run_id text NOT NULL UNIQUE REFERENCES ax_runs(run_id),kind text NOT NULL,text text NOT NULL CHECK(octet_length(text)<=8192),PRIMARY KEY(root_id,revision));
CREATE TABLE ax_workbench_outputs(run_id text NOT NULL REFERENCES ax_runs(run_id),alias text NOT NULL,name text NOT NULL,limit_bytes integer NOT NULL CHECK(limit_bytes BETWEEN 1 AND 8388608),file_id uuid UNIQUE REFERENCES ax_files(id),released boolean NOT NULL DEFAULT false,PRIMARY KEY(run_id,alias));
CREATE FUNCTION ax_workbench_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ax_agent_roots' THEN
  IF ROW(NEW.runtime_version,NEW.execution_policy,NEW.definition_version_id,NEW.definition_manifest,NEW.initial_text,NEW.runtime_image,NEW.code_image,NEW.code_profile) IS DISTINCT FROM ROW(OLD.runtime_version,OLD.execution_policy,OLD.definition_version_id,OLD.definition_manifest,OLD.initial_text,OLD.runtime_image,OLD.code_image,OLD.code_profile) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSIF TG_TABLE_NAME='ax_agent_segments' THEN
  IF ROW(NEW.attempt_kind,NEW.predecessor_run_id,NEW.descriptor,NEW.checkpoint_revision) IS DISTINCT FROM ROW(OLD.attempt_kind,OLD.predecessor_run_id,OLD.descriptor,OLD.checkpoint_revision) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSE PERFORM ax_error('immutable_workbench'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_workbench_root_immutable BEFORE UPDATE ON ax_agent_roots FOR EACH ROW EXECUTE FUNCTION ax_workbench_immutable();
CREATE TRIGGER ax_workbench_segment_immutable BEFORE UPDATE ON ax_agent_segments FOR EACH ROW EXECUTE FUNCTION ax_workbench_immutable();
CREATE TRIGGER ax_workbench_file_immutable BEFORE UPDATE OR DELETE ON ax_workbench_files FOR EACH ROW EXECUTE FUNCTION ax_workbench_immutable();
CREATE TRIGGER ax_workbench_checkpoint_immutable BEFORE UPDATE OR DELETE ON ax_workbench_checkpoints FOR EACH ROW EXECUTE FUNCTION ax_workbench_immutable();
CREATE FUNCTION ax_workbench_is_run(run text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM ax_agent_segments s JOIN ax_agent_roots a ON a.id=s.root_id WHERE s.run_id=run AND a.runtime_version=2) $$;
CREATE FUNCTION ax_workbench_root(run text) RETURNS ax_agent_roots LANGUAGE sql STABLE AS $$ SELECT a.* FROM ax_agent_roots a JOIN ax_agent_segments s ON s.root_id=a.id WHERE s.run_id=run AND a.runtime_version=2 $$;
CREATE FUNCTION ax_workbench_file_view(binding ax_workbench_files) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('alias',binding.alias,'file_id',f.id,'name',f.name,'size_bytes',f.size_bytes,'sha256',f.sha256) FROM ax_files f WHERE f.id=binding.file_id $$;
CREATE FUNCTION ax_workbench_cost(root uuid,reservations boolean DEFAULT true) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(CASE WHEN o.settled_at IS NOT NULL THEN o.actual_usd WHEN reservations THEN o.reserved_usd ELSE 0 END),0) FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=root AND o.kind='model' $$;
CREATE FUNCTION ax_workbench_definitions(a ax_agent_roots) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pinned jsonb; v jsonb;
BEGIN
 FOR pinned IN SELECT * FROM jsonb_array_elements(a.definition_manifest) LOOP
  v:=ax_definition_version(a.owner_user_id,a.workspace_id,(pinned->>'id')::uuid,true);
  IF v->>'sha256' IS DISTINCT FROM pinned->>'sha256' THEN PERFORM ax_error('definition_dependency_unavailable'); END IF;
 END LOOP;
END $$;
CREATE FUNCTION ax_workbench_live(a ax_agent_roots) RETURNS ax_agent_roots LANGUAGE plpgsql AS $$
DECLARE began timestamptz; control ax_workbench_control;
BEGIN
 PERFORM ax_agent_check_token(a.owner_user_id,a.grant_token_hash);
 IF a.runtime_version<>2 OR a.stop_requested OR a.state NOT IN ('running','stopping','waiting_input') THEN PERFORM ax_error('agent_stopped'); END IF;
 IF a.grant_expires_at<=clock_timestamp() THEN PERFORM ax_error('agent_grant_expired'); END IF;
 PERFORM org_authorize(a.owner_user_id,a.workspace_id);
 PERFORM ax_workbench_definitions(a);
 SELECT * INTO control FROM ax_workbench_control WHERE id;
 IF a.mode='model' AND NOT control.trial_enabled THEN PERFORM ax_error('workbench_disabled'); END IF;
 SELECT intent_at INTO began FROM ax_effects WHERE run_id=a.current_run_id AND operation='create' AND NOT EXISTS(SELECT 1 FROM ax_runs WHERE run_id=a.current_run_id AND resolved);
 IF a.active_ms+coalesce(ceil(extract(epoch FROM clock_timestamp()-began)*1000),0)>=300000 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 RETURN a;
END $$;

CREATE OR REPLACE FUNCTION ax_guard_integrity(adapter text, signature text, ceiling numeric) RETURNS numeric LANGUAGE plpgsql AS $$
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
 IF paid AND total>=ceiling THEN PERFORM ax_error('pilot_estimate_limit_reached'); END IF;
 RETURN total;
END $$;
CREATE OR REPLACE FUNCTION ax_guard(adapter text, signature text) RETURNS numeric LANGUAGE sql AS $$ SELECT ax_guard_integrity(adapter,signature,0.01) $$;
CREATE FUNCTION ax_workbench_view(a ax_agent_roots) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',a.id,'protocol_version',2,'state',CASE WHEN a.state IN ('running','stopping') AND EXISTS(SELECT 1 FROM ax_jobs WHERE run_id=a.current_run_id AND state='claimed' AND lease_until<=clock_timestamp()) THEN 'blocked_unknown' ELSE a.state END,
 'revision',a.revision,'current_run_id',a.current_run_id,'stage',(SELECT attempt_kind FROM ax_agent_segments WHERE run_id=a.current_run_id),'mode',a.mode,'question_id',a.question_id,'question',a.question,
 'can_answer',a.state='waiting_input' AND NOT a.stop_requested AND a.wait_expires_at>clock_timestamp(),'stop_requested',a.stop_requested,'model_calls',a.model_calls,'tool_calls',a.tool_calls,'python_calls',a.python_calls,'active_ms',a.active_ms,
 'estimated_usd',CASE WHEN EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.settled_at IS NULL) THEN NULL ELSE ax_workbench_cost(a.id,false) END,
 'reserved_usd',coalesce((SELECT sum(o.reserved_usd) FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.settled_at IS NULL),0),
 'input_files',coalesce((SELECT jsonb_agg(ax_workbench_file_view(f) ORDER BY f.alias) FROM ax_workbench_files f WHERE f.root_id=a.id AND source_run_id IS NULL),'[]'),
 'output_files',coalesce((SELECT jsonb_agg(ax_workbench_file_view(f) ORDER BY f.alias) FROM ax_workbench_files f WHERE f.root_id=a.id AND source_run_id IS NOT NULL),'[]'),
 'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('run_id',h.run_id,'kind',h.kind,'text',h.text) ORDER BY h.sequence,h.position) FROM (SELECT s.sequence,0 AS position,r.run_id,'user_'||r.kind AS kind,r.payload->>'text' AS text FROM ax_agent_requests r JOIN ax_agent_segments s ON s.run_id=r.run_id WHERE r.root_id=a.id UNION ALL SELECT s.sequence,1,c.run_id,c.kind,c.text FROM ax_workbench_checkpoints c JOIN ax_agent_segments s ON s.run_id=c.run_id WHERE c.root_id=a.id) h),'[]'),
 'checkpoints',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',c.revision,'run_id',c.run_id,'kind',c.kind,'text',c.text) ORDER BY c.revision) FROM ax_workbench_checkpoints c WHERE root_id=a.id),'[]'))
$$;
CREATE FUNCTION ax_workbench_owned(owner uuid,wid uuid,root uuid) RETURNS ax_agent_roots LANGUAGE plpgsql AS $$
DECLARE a ax_agent_roots;
BEGIN
 SELECT * INTO a FROM ax_agent_roots WHERE id=root AND owner_user_id=owner AND workspace_id=wid AND runtime_version=2;
 IF NOT FOUND THEN PERFORM ax_error('workbench_not_found'); END IF;
 PERFORM ax_file_authorize(owner,wid); RETURN a;
END $$;
CREATE FUNCTION ax_workbench_get(owner uuid,wid uuid,root uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_workbench_view(ax_workbench_owned(owner,wid,root)) $$;
CREATE FUNCTION ax_workbench_list(owner uuid,wid uuid,before_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE result jsonb; boundary ax_agent_roots; cursor uuid;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 IF before_id IS NOT NULL THEN boundary:=ax_workbench_owned(owner,wid,before_id); END IF;
 SELECT coalesce(jsonb_agg((ax_workbench_view(a)||jsonb_build_object('checkpoints','[]'::jsonb,'messages',coalesce((SELECT jsonb_build_array(jsonb_build_object('run_id',r.run_id,'kind','user_start','text',r.payload->>'text')) FROM ax_agent_requests r WHERE r.root_id=a.id AND r.kind='start'),'[]'::jsonb))) ORDER BY a.created_at DESC,a.id DESC),'[]') INTO result FROM (SELECT * FROM ax_agent_roots WHERE owner_user_id=owner AND workspace_id=wid AND runtime_version=2 AND (before_id IS NULL OR (created_at,id)<(boundary.created_at,boundary.id)) ORDER BY created_at DESC,id DESC LIMIT 50) a;
 IF jsonb_array_length(result)=50 THEN cursor:=(result->49->>'id')::uuid; END IF;
 RETURN jsonb_build_object('roots',result,'next_cursor',cursor);
END $$;
CREATE FUNCTION ax_workbench_manifest(run text,image text,kind text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('apiVersion','ax.io/v1alpha1','kind','Task','metadata',jsonb_build_object('name',run,'atespace',CASE WHEN kind='python' THEN 'ax-code' ELSE 'ax-runtime' END),'spec',jsonb_build_object('image',image,'command',jsonb_build_array('python3',CASE WHEN kind='python' THEN '/opt/ax-code/runner.py' ELSE '/opt/ax-task/runner.py' END,'wait'),'debug',true)) $$;
CREATE FUNCTION ax_workbench_next(a ax_agent_roots,kind text,input_text text,run text,previous text DEFAULT NULL,code jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE descriptor jsonb; req jsonb; image text; num integer; sig text; total numeric; d_hash text; output jsonb; idx integer:=0; control ax_workbench_control;
BEGIN
 IF run IS NULL OR run !~ '^ax-run-[0-9a-f]{16}$' OR kind NOT IN ('runtime','python') THEN PERFORM ax_error('invalid_request'); END IF;
 a:=ax_workbench_live(a);
 IF NOT (SELECT accepting FROM ax_control WHERE id) THEN PERFORM ax_error('admission_closed'); END IF;
 SELECT * INTO control FROM ax_workbench_control WHERE id;
 IF kind='python' AND (NOT control.python_enabled OR a.code_profile IS DISTINCT FROM 'host-quota-8m-v1' OR a.code_image IS NULL) THEN PERFORM ax_error('python_disabled'); END IF;
 IF kind='runtime' AND a.model_calls>=6 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 SELECT count(*)+1 INTO num FROM ax_agent_segments WHERE root_id=a.id;
 IF num>9 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 image:=CASE WHEN kind='runtime' THEN a.runtime_image ELSE a.code_image END;
 IF image IS NULL THEN PERFORM ax_error('workbench_disabled'); END IF;
 descriptor:=jsonb_build_object('version',2,'root_id',a.id,'instruction',input_text,'definition_manifest',a.definition_manifest,'code_profile',CASE WHEN kind='python' THEN a.code_profile END,
 'inputs',coalesce((SELECT jsonb_agg(ax_workbench_file_view(f) ORDER BY CASE WHEN kind='python' THEN array_position(ARRAY(SELECT jsonb_array_elements_text(code->'input_aliases')),f.alias) END,f.alias) FROM ax_workbench_files f WHERE f.root_id=a.id AND (kind='runtime' OR code->'input_aliases' ? f.alias)),'[]'),
 'outputs',CASE WHEN kind='python' THEN (SELECT jsonb_agg(x.value||jsonb_build_object('alias','output_'||num||'_'||x.ordinality) ORDER BY x.ordinality) FROM jsonb_array_elements(code->'outputs') WITH ORDINALITY x) ELSE '[]'::jsonb END,
 'history',coalesce((SELECT jsonb_agg(jsonb_build_object('kind',h.kind,'text',h.text) ORDER BY h.sequence,h.position) FROM (SELECT s.sequence,0 AS position,'user_'||r.kind AS kind,r.payload->>'text' AS text FROM ax_agent_requests r JOIN ax_agent_segments s ON s.run_id=r.run_id WHERE r.root_id=a.id UNION ALL SELECT s.sequence,1,c.kind,c.text FROM ax_workbench_checkpoints c JOIN ax_agent_segments s ON s.run_id=c.run_id WHERE c.root_id=a.id) h),'[]'),'code',code);
 IF octet_length(ax_json(descriptor->'history',true))>16384 OR octet_length(ax_json(descriptor,true))>40960 THEN PERFORM ax_error('invalid_request'); END IF;
 d_hash:=encode(sha256(convert_to(ax_json(descriptor,true),'UTF8')),'hex');
 req:=jsonb_build_object('schema_version',2,'run_id',run,'root_id',a.id,'adapter',CASE WHEN kind='runtime' THEN 'interactive' ELSE 'python' END,'checkpoint_revision',a.revision,'descriptor_sha256',d_hash);
 sig:=encode(sha256(convert_to(ax_json((req-'run_id')||jsonb_build_object('image',image)),'UTF8')),'hex');
 total:=ax_guard_integrity(CASE WHEN a.mode='model' THEN 'agent_model' ELSE 'interactive' END,sig,0.05);
 IF a.mode='model' AND ax_workbench_cost(a.id,true)>=0.01 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 PERFORM set_config('ax.workspace_id',a.workspace_id::text,true);
 INSERT INTO ax_runs(run_id,owner_user_id,actor_id,workspace_id,request_data,request_bytes,request_hash,image,manifest,fingerprint,accepted_at,phase,known_estimated_usd_before)
 VALUES(run,a.owner_user_id,'user:'||a.owner_user_id,a.workspace_id,req,convert_to(ax_json(req,true),'UTF8'),encode(sha256(convert_to(ax_json(req,true),'UTF8')),'hex'),image,ax_workbench_manifest(run,image,kind),sig,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'accepted',total);
 INSERT INTO ax_agent_segments(run_id,root_id,sequence,execution_manifest,paid_fingerprint,attempt_kind,predecessor_run_id,descriptor,checkpoint_revision)
 VALUES(run,a.id,num,jsonb_build_object('version',2,'mode',a.mode,'profile_id',a.profile_id,'execution_policy',a.execution_policy),sig,kind,previous,descriptor,a.revision);
 INSERT INTO ax_jobs(run_id,kind,state) VALUES(run,'execute','ready');
 IF kind='python' THEN
  PERFORM pg_advisory_xact_lock(926018,1);
  FOR output IN SELECT * FROM jsonb_array_elements(code->'outputs') LOOP
   idx:=idx+1; INSERT INTO ax_workbench_outputs(run_id,alias,name,limit_bytes) VALUES(run,'output_'||num||'_'||idx,output->>'name',(output->>'size_limit_bytes')::integer);
  END LOOP;
  PERFORM ax_workbench_quota(a.owner_user_id);
 END IF;
 UPDATE ax_agent_roots SET current_run_id=run,state='running' WHERE id=a.id;
 UPDATE ax_execution_slot SET run_id=run,hold_reason='unresolved_run' WHERE id;
END $$;
CREATE FUNCTION ax_workbench_start(owner uuid,wid uuid,payload jsonb,proposed_run text,expires double precision,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; request_key uuid; mode text; vid uuid; v jsonb; dep uuid; deps jsonb:='[]'; f ax_files; fid uuid; count_files integer:=0; size_files bigint:=0; control ax_workbench_control;
BEGIN
 PERFORM ax_agent_owner_lock(owner); PERFORM ax_file_authorize(owner,wid);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['key','text','mode','input_file_ids'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(payload) k WHERE k NOT IN ('key','text','mode','allow_model','agent_version_id','skill_version_ids','input_file_ids')) OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR octet_length(payload->>'text') NOT BETWEEN 1 AND 2048 OR payload->>'text' !~ '[^[:space:]]' OR jsonb_typeof(payload->'input_file_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'input_file_ids')>4 THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN request_key:=(payload->>'key')::uuid; vid:=(payload->>'agent_version_id')::uuid; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF payload ? 'skill_version_ids' AND (jsonb_typeof(payload->'skill_version_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'skill_version_ids')>8 OR (vid IS NOT NULL AND jsonb_array_length(payload->'skill_version_ids')>0)) THEN PERFORM ax_error('invalid_request'); END IF;
 mode:=payload->>'mode'; IF request_key IS NULL OR mode IS NULL OR mode NOT IN ('preview','model') OR (payload ? 'allow_model' AND jsonb_typeof(payload->'allow_model')<>'boolean') THEN PERFORM ax_error('invalid_request'); END IF;
 IF mode='model' AND payload->'allow_model' IS DISTINCT FROM 'true'::jsonb THEN PERFORM ax_error('model_not_allowed'); END IF;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND ax_agent_requests.key=request_key;
 IF FOUND THEN
  IF prior.kind<>'start' OR prior.payload<>payload OR NOT EXISTS(SELECT 1 FROM ax_agent_roots WHERE id=prior.root_id AND workspace_id=wid AND runtime_version=2) THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',prior.root_id,'run_id',prior.run_id,'replayed',true,'protocol_version',2);
 END IF;
 IF expires IS NULL OR NOT isfinite(to_timestamp(expires)) OR expires<=extract(epoch FROM clock_timestamp()) OR expires>extract(epoch FROM clock_timestamp())+86400 THEN PERFORM ax_error('agent_grant_expired'); END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 SELECT * INTO control FROM ax_workbench_control WHERE id;
 IF control.runtime_image IS NULL OR (mode='model' AND NOT control.trial_enabled) THEN PERFORM ax_error('workbench_disabled'); END IF;
 IF vid IS NOT NULL THEN
  v:=ax_definition_version(owner,wid,vid,true); IF v->>'kind'<>'agent' THEN PERFORM ax_error('invalid_request'); END IF;
  deps:=jsonb_build_array(jsonb_build_object('id',vid,'sha256',v->>'sha256','kind',v->>'kind','size_bytes',(SELECT content_bytes FROM ax_definition_versions WHERE id=vid)));
  FOR dep IN SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(v->'content'->'skill_version_ids') x LOOP
   v:=ax_definition_version(owner,wid,dep,true); deps:=deps||jsonb_build_array(jsonb_build_object('id',dep,'sha256',v->>'sha256','kind',v->>'kind','size_bytes',(SELECT content_bytes FROM ax_definition_versions WHERE id=dep)));
  END LOOP;
 ELSE
  FOR dep IN SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(coalesce(payload->'skill_version_ids','[]'::jsonb)) x LOOP
   v:=ax_definition_version(owner,wid,dep,true); IF v->>'kind'<>'skill' OR EXISTS(SELECT 1 FROM jsonb_array_elements(deps) d WHERE d->>'id'=dep::text) THEN PERFORM ax_error('invalid_request'); END IF;
   deps:=deps||jsonb_build_array(jsonb_build_object('id',dep,'sha256',v->>'sha256','kind',v->>'kind','size_bytes',(SELECT content_bytes FROM ax_definition_versions WHERE id=dep)));
  END LOOP;
 END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 INSERT INTO ax_agent_roots(id,owner_user_id,workspace_id,state,grant_expires_at,grant_token_hash,mode,profile_id,runtime_version,execution_policy,definition_version_id,definition_manifest,initial_text,runtime_image,code_image,code_profile)
 VALUES(gen_random_uuid(),owner,wid,'running',to_timestamp(expires),token_hash,mode,CASE WHEN mode='model' THEN 'gemini-3.1-flash-lite-standard-2026-10-07-v1' ELSE 'preview-v1' END,2,'workbench-trial-2026-10-07-v1',vid,deps,payload->>'text',control.runtime_image,control.code_image,control.code_profile) RETURNING * INTO a;
 FOR fid IN SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(payload->'input_file_ids') x LOOP
  f:=ax_file_owned(owner,wid,fid); IF f.state<>'ready' THEN PERFORM ax_error('file_not_ready'); END IF;
  IF EXISTS(SELECT 1 FROM ax_workbench_files WHERE root_id=a.id AND file_id=fid) THEN PERFORM ax_error('invalid_request'); END IF;
  count_files:=count_files+1; size_files:=size_files+f.size_bytes; IF size_files>8388608 THEN PERFORM ax_error('invalid_request'); END IF;
  INSERT INTO ax_workbench_files VALUES(a.id,owner,wid,'input_'||count_files,fid,NULL);
 END LOOP;
 PERFORM ax_workbench_next(a,'runtime',payload->>'text',proposed_run);
 INSERT INTO ax_agent_requests VALUES(owner,request_key,'start',payload,a.id,proposed_run);
 RETURN jsonb_build_object('root_id',a.id,'run_id',proposed_run,'replayed',false,'protocol_version',2);
END $$;
CREATE FUNCTION ax_workbench_answer(owner uuid,wid uuid,root uuid,payload jsonb,proposed_run text,expires double precision,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; request_key uuid; question uuid;
BEGIN
 PERFORM ax_agent_owner_lock(owner); a:=ax_workbench_owned(owner,wid,root);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['key','question_id','expected_revision','text'] OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR octet_length(payload->>'text') NOT BETWEEN 1 AND 2048 OR payload->>'text' !~ '[^[:space:]]' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN request_key:=(payload->>'key')::uuid; question:=(payload->>'question_id')::uuid; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF request_key IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND ax_agent_requests.key=request_key;
 IF FOUND THEN
  IF prior.kind<>'answer' OR prior.root_id<>root OR prior.payload<>payload THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',root,'run_id',prior.run_id,'replayed',true,'protocol_version',2);
 END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 IF expires IS NULL OR NOT isfinite(to_timestamp(expires)) OR expires<=extract(epoch FROM clock_timestamp()) OR expires>extract(epoch FROM clock_timestamp())+86400 THEN PERFORM ax_error('agent_grant_expired'); END IF;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 SELECT * INTO a FROM ax_agent_roots WHERE id=root FOR UPDATE;
 IF a.state<>'waiting_input' OR a.stop_requested OR a.wait_expires_at<=clock_timestamp() OR question IS DISTINCT FROM a.question_id OR payload->'expected_revision' IS DISTINCT FROM to_jsonb(a.revision) THEN PERFORM ax_error('agent_answer_conflict'); END IF;
 UPDATE ax_agent_roots SET grant_token_hash=token_hash,grant_expires_at=to_timestamp(expires),revision=revision+1 WHERE id=root RETURNING * INTO a;
 PERFORM ax_workbench_next(a,'runtime',payload->>'text',proposed_run,a.current_run_id);
 INSERT INTO ax_agent_requests VALUES(owner,request_key,'answer',payload,root,proposed_run);
 RETURN jsonb_build_object('root_id',root,'run_id',proposed_run,'replayed',false,'protocol_version',2);
END $$;
ALTER FUNCTION ax_claim(text,integer) RENAME TO ax_claim_v7;
CREATE FUNCTION ax_claim(controller_id text,lease_seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE j ax_jobs; r ax_runs; a ax_agent_roots; s ax_agent_segments; effects jsonb;
BEGIN
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM ax_jobs WHERE state='claimed') THEN RETURN NULL; END IF;
 SELECT * INTO j FROM ax_jobs WHERE state='ready' ORDER BY run_id LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT ax_workbench_is_run(j.run_id) THEN RETURN ax_claim_v7(controller_id,lease_seconds); END IF;
 IF controller_id IS NULL OR controller_id !~ '^[A-Za-z0-9_.:-]{1,128}$' OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300 THEN PERFORM ax_error('invalid_controller'); END IF;
 SELECT * INTO r FROM ax_runs WHERE run_id=j.run_id FOR UPDATE;
 SELECT * INTO s FROM ax_agent_segments WHERE run_id=r.run_id;
 SELECT * INTO a FROM ax_agent_roots WHERE id=s.root_id;
 IF r.resolved OR r.invalid OR (j.kind='execute' AND (r.phase<>'accepted' OR r.apply_attempted OR r.start_attempted OR EXISTS(SELECT 1 FROM ax_effects WHERE run_id=r.run_id))) THEN PERFORM ax_error('execution_already_claimed'); END IF;
 IF r.owner_user_id IS DISTINCT FROM a.owner_user_id OR r.workspace_id IS DISTINCT FROM a.workspace_id OR r.request_data<>jsonb_build_object('schema_version',2,'run_id',r.run_id,'root_id',a.id,'adapter',CASE WHEN s.attempt_kind='runtime' THEN 'interactive' ELSE 'python' END,'checkpoint_revision',s.checkpoint_revision,'descriptor_sha256',encode(sha256(convert_to(ax_json(s.descriptor,true),'UTF8')),'hex')) OR r.request_hash<>encode(sha256(r.request_bytes),'hex') OR convert_from(r.request_bytes,'UTF8')::jsonb<>r.request_data OR r.image IS DISTINCT FROM (CASE WHEN s.attempt_kind='runtime' THEN a.runtime_image ELSE a.code_image END) OR r.manifest<>ax_workbench_manifest(r.run_id,r.image,s.attempt_kind) OR r.fingerprint<>encode(sha256(convert_to(ax_json((r.request_data-'run_id')||jsonb_build_object('image',r.image)),'UTF8')),'hex') THEN PERFORM ax_error('request_receipt_mismatch'); END IF;
 UPDATE ax_jobs SET state='claimed',controller_id=ax_claim.controller_id,generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>lease_seconds) WHERE run_id=r.run_id RETURNING * INTO j;
 UPDATE ax_runs SET phase=CASE WHEN j.kind='recovery' THEN 'recovering' ELSE 'claimed' END WHERE run_id=r.run_id;
 UPDATE ax_execution_slot SET run_id=r.run_id,hold_reason='unresolved_run' WHERE id;
 SELECT coalesce(jsonb_object_agg(operation,jsonb_build_object('operation_id',operation_id,'evidence',evidence)),'{}') INTO effects FROM ax_effects WHERE run_id=r.run_id;
 RETURN jsonb_build_object('run_id',r.run_id,'generation',j.generation,'kind',j.kind,'request',r.request_data,'image',r.image,'manifest',r.manifest,'result',r.result,'effects',effects,'lease_until',j.lease_until,
 'workbench',jsonb_build_object('version',2,'attempt_kind',s.attempt_kind,'execution_policy',a.execution_policy,'mode',a.mode,'profile_id',a.profile_id,'remaining_ms',greatest(0,300000-a.active_ms),'descriptor',s.descriptor));
END $$;
CREATE FUNCTION ax_workbench_claim(run text,gen bigint,controller text,live boolean DEFAULT true) RETURNS ax_agent_roots LANGUAGE plpgsql AS $$
DECLARE a ax_agent_roots;
BEGIN
 a:=ax_workbench_root(run); IF a.id IS NULL THEN PERFORM ax_error('workbench_not_found'); END IF;
 PERFORM 1 FROM org_workspaces WHERE id=a.workspace_id FOR SHARE;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 PERFORM ax_check_claim(run,gen,controller);
 SELECT * INTO a FROM ax_agent_roots WHERE id=a.id FOR UPDATE;
 IF a.current_run_id<>run THEN PERFORM ax_error('stale_claim'); END IF;
 IF live THEN a:=ax_workbench_live(a); END IF;
 RETURN a;
END $$;
ALTER FUNCTION ax_intent(text,bigint,text,text) RENAME TO ax_intent_v7;
CREATE FUNCTION ax_intent(run text,gen bigint,controller text,operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; op uuid; prior text; kind text;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN RETURN ax_intent_v7(run,gen,controller,operation); END IF;
 a:=ax_workbench_claim(run,gen,controller,operation NOT IN ('egress_deny','suspend'));
 SELECT attempt_kind INTO kind FROM ax_agent_segments WHERE run_id=run;
 IF operation IS NULL OR operation NOT IN ('create','resume','stage','egress_prepare','start','egress_deny','suspend') THEN PERFORM ax_error('invalid_operation'); END IF;
 IF EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND ax_effects.operation=ax_intent.operation) THEN PERFORM ax_error('execution_already_claimed'); END IF;
 IF operation NOT IN ('egress_deny','suspend') THEN
  IF kind='python' AND NOT (SELECT python_enabled FROM ax_workbench_control WHERE id) THEN PERFORM ax_error('python_disabled'); END IF;
  IF (SELECT j1.kind FROM ax_jobs j1 WHERE j1.run_id=run)<>'execute' OR EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND ax_effects.operation IN ('egress_deny','suspend')) OR EXISTS(SELECT 1 FROM ax_runs WHERE run_id=run AND error_type IS NOT NULL) THEN PERFORM ax_error('restart_forbidden'); END IF;
  prior:=CASE operation WHEN 'resume' THEN 'create' WHEN 'stage' THEN 'resume' WHEN 'egress_prepare' THEN 'stage' WHEN 'start' THEN 'egress_prepare' ELSE NULL END;
  IF prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND ax_effects.operation=prior AND evidence->'confirmed'='true') THEN PERFORM ax_error('preceding_effect_unconfirmed'); END IF;
 END IF;
 INSERT INTO ax_effects(run_id,operation,generation) VALUES(run,operation,gen) RETURNING operation_id INTO op;
 UPDATE ax_runs SET apply_attempted=apply_attempted OR operation='create',start_attempted=start_attempted OR operation='start',phase=operation||'_attempted' WHERE run_id=run;
 RETURN jsonb_build_object('operation_id',op);
END $$;
ALTER FUNCTION ax_collect(text,bigint,text,jsonb,bytea) RENAME TO ax_collect_v7;
CREATE FUNCTION ax_collect(run text,gen bigint,controller text,value jsonb,artifact bytea) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; a ax_agent_roots; amount jsonb;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN PERFORM ax_collect_v7(run,gen,controller,value,artifact); RETURN; END IF;
 a:=ax_workbench_claim(run,gen,controller,false); SELECT * INTO r FROM ax_runs WHERE run_id=run;
 IF octet_length(value::text)>65536 OR NOT r.start_attempted OR artifact IS NOT NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>9 OR NOT value ?& ARRAY['schema_version','run_id','adapter','status','exit_code','error_type','summary','usage','estimated_usd'] OR value->'schema_version' IS DISTINCT FROM '2'::jsonb OR value->>'run_id' IS DISTINCT FROM run OR value->>'adapter' IS DISTINCT FROM r.request_data->>'adapter' OR coalesce(value->>'status','') NOT IN ('succeeded','failed','timed_out') OR jsonb_typeof(value->'exit_code') IS DISTINCT FROM 'number' OR value->>'exit_code' !~ '^[0-9]{1,3}$' OR jsonb_typeof(value->'summary') IS DISTINCT FROM 'string' OR octet_length(value->>'summary')>8192 OR (value->>'status'='succeeded') IS DISTINCT FROM (value->'exit_code'='0'::jsonb) THEN PERFORM ax_error('invalid_result'); END IF;
 IF value->'error_type' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'error_type')<>'string' OR value->>'error_type' !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$') THEN PERFORM ax_error('invalid_result'); END IF;
 IF value->>'status'='succeeded' AND value->'error_type' IS DISTINCT FROM 'null'::jsonb THEN PERFORM ax_error('invalid_result'); END IF;
 IF value->'estimated_usd' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'estimated_usd')<>'number' OR (value->>'estimated_usd')::numeric<0) THEN PERFORM ax_error('invalid_result'); END IF;
 IF value->'usage' IS DISTINCT FROM 'null'::jsonb THEN
  IF jsonb_typeof(value->'usage') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value->'usage'))<>5 OR NOT (value->'usage') ?& ARRAY['prompt_token_count','candidates_token_count','thoughts_token_count','total_token_count','model_call_count'] THEN PERFORM ax_error('invalid_result'); END IF;
  FOR amount IN SELECT x.value FROM jsonb_each(value->'usage') x LOOP IF jsonb_typeof(amount)<>'number' OR amount::text !~ '^[0-9]+$' OR amount::text::numeric>1000000 THEN PERFORM ax_error('invalid_result'); END IF; END LOOP;
 END IF;
 IF r.result IS NOT NULL AND r.result<>value THEN PERFORM ax_error('result_conflict'); END IF;
 UPDATE ax_runs SET result=value,phase='collected' WHERE run_id=run;
END $$;
CREATE FUNCTION ax_workbench_cleanup(run text,gen bigint,controller text,value jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments;
BEGIN
 a:=ax_workbench_claim(run,gen,controller,false); SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 IF s.attempt_kind<>'python' OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>7 OR NOT value ?& ARRAY['actor','actor_uid','worker_uid','generation','image','profile','cleaned'] OR value->>'actor' IS DISTINCT FROM run OR value->>'image' IS DISTINCT FROM a.code_image OR value->>'profile' IS DISTINCT FROM a.code_profile OR value->'cleaned' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(value->'actor_uid') IS DISTINCT FROM 'string' OR value->>'actor_uid' !~ '^[A-Za-z0-9_-]{1,128}$' OR jsonb_typeof(value->'worker_uid') IS DISTINCT FROM 'string' OR value->>'worker_uid' !~ '^[A-Za-z0-9_-]{1,128}$' OR jsonb_typeof(value->'generation') IS DISTINCT FROM 'string' OR value->>'generation' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN PERFORM ax_error('invalid_evidence'); END IF;
 IF s.host_cleanup IS NOT NULL AND s.host_cleanup<>value THEN PERFORM ax_error('result_conflict'); END IF;
 UPDATE ax_agent_segments SET host_cleanup=value WHERE run_id=run;
 INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,value);
END $$;
CREATE FUNCTION ax_workbench_proposal(model jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE raw json; p jsonb; x jsonb; total bigint:=0;
BEGIN
 IF jsonb_array_length(model->'candidates') IS DISTINCT FROM 1 OR jsonb_array_length(model->'candidates'->0->'content'->'parts') IS DISTINCT FROM 1 OR model->'candidates'->0->>'finishReason' IS DISTINCT FROM 'STOP' THEN RETURN NULL; END IF;
 raw:=(model->'candidates'->0->'content'->'parts'->0->>'text')::json; p:=raw::jsonb;
 IF NOT ax_agent_json_unique(raw) OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF p->>'kind' IN ('question','output','unsupported') THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR jsonb_typeof(p->'text') IS DISTINCT FROM 'string' OR octet_length(p->>'text') NOT BETWEEN 1 AND 2048 OR p->>'text' !~ '[^[:space:]]' THEN RETURN NULL; END IF;
 ELSIF p->>'kind'='python' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>5 OR NOT p ?& ARRAY['kind','source','input_aliases','outputs','purpose'] OR jsonb_typeof(p->'source') IS DISTINCT FROM 'string' OR octet_length(p->>'source') NOT BETWEEN 1 AND 4096 OR p->>'source' !~ '[^[:space:]]' OR jsonb_typeof(p->'purpose') IS DISTINCT FROM 'string' OR octet_length(p->>'purpose') NOT BETWEEN 1 AND 2048 OR jsonb_typeof(p->'input_aliases') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'input_aliases')>4 OR jsonb_typeof(p->'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'outputs') NOT BETWEEN 1 AND 4 THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'input_aliases') a WHERE jsonb_typeof(a)<>'string' OR (a#>>'{}') !~ '^[a-z][a-z0-9_]{0,63}$') OR (SELECT count(DISTINCT a) FROM jsonb_array_elements(p->'input_aliases') a)<>jsonb_array_length(p->'input_aliases') THEN RETURN NULL; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p->'outputs') LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(x))<>2 OR jsonb_typeof(x->'name') IS DISTINCT FROM 'string' OR x->>'name' !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,58}\.(csv|xlsx)$' OR jsonb_typeof(x->'size_limit_bytes') IS DISTINCT FROM 'number' OR x->>'size_limit_bytes' !~ '^[0-9]{1,7}$' OR (x->>'size_limit_bytes')::integer NOT BETWEEN 1 AND 8388608 THEN RETURN NULL; END IF;
   total:=total+(x->>'size_limit_bytes')::integer;
  END LOOP;
  IF total>8388608 OR (SELECT count(DISTINCT declared.output->>'name') FROM jsonb_array_elements(p->'outputs') AS declared(output))<>jsonb_array_length(p->'outputs') THEN RETURN NULL; END IF;
 ELSE RETURN NULL; END IF;
 RETURN p;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
ALTER FUNCTION ax_agent_reserve(text,bigint,text,integer,bytea) RENAME TO ax_agent_reserve_v7;
CREATE FUNCTION ax_agent_reserve(run text,gen bigint,controller text,seq integer,request_bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments; o ax_agent_operations; raw json; req jsonb; digest text; cost numeric:=0; input_alias text; v jsonb;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN RETURN ax_agent_reserve_v7(run,gen,controller,seq,request_bytes); END IF;
 a:=ax_workbench_claim(run,gen,controller,false); SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 IF s.attempt_kind<>'runtime' OR NOT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='start' AND evidence->'confirmed'='true') OR seq IS NULL OR seq NOT IN (1,2) OR request_bytes IS NULL OR octet_length(request_bytes)>65536 THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN raw:=convert_from(request_bytes,'UTF8')::json; req:=raw::jsonb; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF NOT ax_agent_json_unique(raw) OR jsonb_typeof(req) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(req))<>5 OR NOT req ?& ARRAY['version','run_id','sequence','kind','body'] OR req->'version' IS DISTINCT FROM '2'::jsonb OR req->>'run_id' IS DISTINCT FROM run OR req->'sequence' IS DISTINCT FROM to_jsonb(seq) OR req->>'kind' IS DISTINCT FROM (CASE WHEN seq=1 THEN 'model' ELSE 'tool' END) OR jsonb_typeof(req->'body') IS DISTINCT FROM 'object' THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(request_bytes),'hex'); SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq;
 IF FOUND THEN
  IF o.request_hash<>digest OR o.request_bytes<>request_bytes THEN PERFORM ax_error('agent_operation_conflict'); END IF;
  IF o.settled_at IS NULL THEN PERFORM ax_error('agent_operation_unknown'); END IF;
  RETURN jsonb_build_object('send',false,'response',o.response,'input_limit',o.input_limit,'output_limit',o.output_limit,'profile_id',a.profile_id);
 END IF;
 a:=ax_workbench_live(a);
 IF seq=1 THEN
  IF a.model_calls>=6 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
  cost:=ax_agent_price(a.profile_id,6000,512);
  IF a.mode='model' AND (ax_workbench_cost(a.id,true)+cost>0.01 OR ax_paid_total(true)+cost>0.05) THEN PERFORM ax_error('pilot_estimate_limit_reached'); END IF;
  IF a.mode='preview' THEN UPDATE ax_agent_roots SET model_calls=model_calls+1 WHERE id=a.id; END IF;
 ELSE
  IF s.proposal IS NULL OR s.proposal<>req->'body' OR NOT EXISTS(SELECT 1 FROM ax_agent_operations WHERE run_id=run AND sequence=1 AND settlement_outcome='ok') THEN PERFORM ax_error('agent_proposal_mismatch'); END IF;
  IF a.tool_calls>=8 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
  IF s.proposal->>'kind'='python' THEN
   IF NOT (SELECT python_enabled FROM ax_workbench_control WHERE id) OR a.code_image IS NULL OR a.code_profile IS DISTINCT FROM 'host-quota-8m-v1' THEN PERFORM ax_error('python_disabled'); END IF;
   IF a.python_calls>=3 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
   IF a.definition_version_id IS NOT NULL THEN v:=ax_definition_version(a.owner_user_id,a.workspace_id,a.definition_version_id,true); IF NOT (v->'content'->'allowed_tools' ? 'python') THEN PERFORM ax_error('model_not_allowed'); END IF; END IF;
   FOR input_alias IN SELECT x#>>'{}' FROM jsonb_array_elements(s.proposal->'input_aliases') x LOOP
    IF NOT EXISTS(SELECT 1 FROM ax_workbench_files WHERE root_id=a.id AND ax_workbench_files.alias=input_alias) THEN PERFORM ax_error('file_not_found'); END IF;
   END LOOP;
   IF (SELECT coalesce(sum(f.size_bytes),0) FROM ax_workbench_files b JOIN ax_files f ON f.id=b.file_id WHERE b.root_id=a.id AND s.proposal->'input_aliases' ? b.alias)>8388608 THEN PERFORM ax_error('invalid_request'); END IF;
   UPDATE ax_agent_roots SET python_calls=python_calls+1 WHERE id=a.id;
  END IF;
  UPDATE ax_agent_roots SET tool_calls=tool_calls+1 WHERE id=a.id;
 END IF;
 INSERT INTO ax_agent_operations(run_id,sequence,generation,kind,request_bytes,request_hash,input_limit,output_limit,reserved_usd) VALUES(run,seq,gen,CASE WHEN seq=1 THEN 'model' ELSE 'tool' END,request_bytes,digest,CASE WHEN seq=1 THEN 6000 ELSE 0 END,CASE WHEN seq=1 THEN 512 ELSE 0 END,cost);
 RETURN jsonb_build_object('send',true,'response',NULL,'input_limit',CASE WHEN seq=1 THEN 6000 ELSE 0 END,'output_limit',CASE WHEN seq=1 THEN 512 ELSE 0 END,'profile_id',a.profile_id);
END $$;
ALTER FUNCTION ax_agent_authorize_generation(text,bigint,text,integer,text,integer) RENAME TO ax_agent_authorize_generation_v7;
CREATE FUNCTION ax_agent_authorize_generation(run text,gen bigint,controller text,seq integer,payload_sha256 text,counted_input_tokens integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; o ax_agent_operations;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN RETURN ax_agent_authorize_generation_v7(run,gen,controller,seq,payload_sha256,counted_input_tokens); END IF;
 a:=ax_workbench_claim(run,gen,controller); SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq FOR UPDATE;
 IF NOT FOUND OR a.mode<>'model' OR seq IS DISTINCT FROM 1 OR o.generation<>gen OR o.generation_started OR o.settled_at IS NOT NULL THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF payload_sha256 IS NULL OR payload_sha256 !~ '^[0-9a-f]{64}$' OR counted_input_tokens IS NULL OR counted_input_tokens<0 THEN PERFORM ax_error('invalid_request'); END IF;
 IF counted_input_tokens>5872 OR a.model_calls>=6 OR ax_workbench_cost(a.id,true)>0.01 OR ax_paid_total(true)>0.05 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 UPDATE ax_agent_operations SET generation_started=true,payload_sha256=ax_agent_authorize_generation.payload_sha256,counted_input_tokens=ax_agent_authorize_generation.counted_input_tokens WHERE run_id=run AND sequence=seq;
 UPDATE ax_agent_roots SET model_calls=model_calls+1 WHERE id=a.id; RETURN '{"send":true}';
END $$;
ALTER FUNCTION ax_agent_settle(text,bigint,text,integer,jsonb,jsonb,integer,jsonb) RENAME TO ax_agent_settle_v7;
CREATE FUNCTION ax_agent_settle(run text,gen bigint,controller text,seq integer,response jsonb,usage jsonb,elapsed_ms integer,evidence jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; o ax_agent_operations; proposed jsonb; cost numeric:=0; output_count bigint; n text; amount jsonb; outcome text; saved jsonb; model jsonb; exceeded boolean:=false;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN PERFORM ax_agent_settle_v7(run,gen,controller,seq,response,usage,elapsed_ms,evidence); RETURN; END IF;
 a:=ax_workbench_claim(run,gen,controller,false); SELECT * INTO o FROM ax_agent_operations WHERE run_id=run AND sequence=seq FOR UPDATE;
 IF NOT FOUND OR o.generation<>gen THEN PERFORM ax_error('agent_operation_unknown'); END IF;
 IF o.settled_at IS NOT NULL THEN
  IF o.usage IS DISTINCT FROM usage OR o.provider_evidence IS DISTINCT FROM evidence OR o.submitted_response IS DISTINCT FROM response THEN PERFORM ax_error('agent_operation_conflict'); END IF; RETURN;
 END IF;
 IF response IS NULL OR jsonb_typeof(response)<>'object' OR octet_length(response::text)>65536 OR (SELECT count(*) FROM jsonb_object_keys(response))<>6 OR NOT response ?& ARRAY['version','run_id','sequence','request_sha256','status','body'] OR response->'version' IS DISTINCT FROM '2'::jsonb OR response->>'run_id' IS DISTINCT FROM run OR response->'sequence' IS DISTINCT FROM to_jsonb(seq) OR response->>'request_sha256' IS DISTINCT FROM o.request_hash OR elapsed_ms IS NULL OR elapsed_ms<0 THEN PERFORM ax_error('agent_response_mismatch'); END IF;
 saved:=response;
 IF seq=2 THEN
  IF usage IS DISTINCT FROM '{}'::jsonb OR evidence IS DISTINCT FROM '{}'::jsonb OR response->>'status' IS DISTINCT FROM 'ok' OR response->'body' IS DISTINCT FROM '{"accepted":true}'::jsonb THEN PERFORM ax_error('agent_response_mismatch'); END IF;
  outcome:='ok';
 ELSE
  IF jsonb_typeof(usage) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(usage))<>5 OR NOT usage ?& ARRAY['prompt_token_count','candidates_token_count','thoughts_token_count','total_token_count','model_call_count'] THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
  FOR n,amount IN SELECT * FROM jsonb_each(usage) LOOP IF jsonb_typeof(amount)<>'number' OR amount::text !~ '^[0-9]+$' OR amount::text::numeric>1000000 THEN PERFORM ax_error('agent_usage_mismatch'); END IF; END LOOP;
  output_count:=(usage->>'candidates_token_count')::bigint+(usage->>'thoughts_token_count')::bigint;
  IF (usage->>'total_token_count')::bigint<>(usage->>'prompt_token_count')::bigint+output_count THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
  IF a.mode='model' THEN
   IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>2048 OR (SELECT count(*) FROM jsonb_object_keys(evidence))<>8 OR NOT evidence ?& ARRAY['outcome','code','payload_sha256','counted_input_tokens','count_attempt','http_status','finish_reason','response_sha256'] OR coalesce(evidence->>'outcome','') NOT IN ('ok','failed','no_send') OR coalesce(evidence->>'code','') !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$' OR evidence->'count_attempt' NOT IN ('0'::jsonb,'1'::jsonb) THEN PERFORM ax_error('agent_response_mismatch'); END IF;
   FOREACH n IN ARRAY ARRAY['payload_sha256','response_sha256'] LOOP IF evidence->n IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->n)<>'string' OR evidence->>n !~ '^[0-9a-f]{64}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF; END LOOP;
   IF evidence->'counted_input_tokens' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'counted_input_tokens')<>'number' OR evidence->>'counted_input_tokens' !~ '^[0-9]{1,9}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
   IF evidence->'http_status' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'http_status')<>'number' OR evidence->>'http_status' !~ '^[1-5][0-9]{2}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
   IF evidence->'finish_reason' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(evidence->'finish_reason')<>'string' OR evidence->>'finish_reason' !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
   outcome:=evidence->>'outcome';
   IF outcome='no_send' THEN
    IF o.generation_started OR EXISTS(SELECT 1 FROM jsonb_each(usage) x WHERE x.value<>'0'::jsonb) THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
   ELSIF NOT o.generation_started OR (usage->>'model_call_count')::int<>1 OR (usage->>'prompt_token_count')::int<=0 OR evidence->'count_attempt'<>'1'::jsonb OR evidence->>'payload_sha256' IS DISTINCT FROM o.payload_sha256 OR evidence->'counted_input_tokens' IS DISTINCT FROM to_jsonb(o.counted_input_tokens) OR evidence->'response_sha256'='null'::jsonb THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
  ELSE
   IF usage IS DISTINCT FROM '{"prompt_token_count":100,"candidates_token_count":20,"thoughts_token_count":0,"total_token_count":120,"model_call_count":1}'::jsonb OR evidence IS DISTINCT FROM '{}'::jsonb THEN PERFORM ax_error('agent_usage_mismatch'); END IF;
   outcome:='ok';
  END IF;
  cost:=ax_agent_price(a.profile_id,(usage->>'prompt_token_count')::bigint,output_count);
  exceeded:=(usage->>'prompt_token_count')::bigint>6000 OR output_count>512 OR cost>o.reserved_usd OR ax_workbench_cost(a.id,false)+cost>0.01 OR (a.mode='model' AND ax_paid_total(false)+cost>0.05);
  IF outcome='ok' THEN
   model:=response->'body'->'response'; proposed:=ax_workbench_proposal(model);
   IF proposed IS NULL OR exceeded OR response->>'status' IS DISTINCT FROM 'ok' OR model->'usageMetadata' IS DISTINCT FROM jsonb_build_object('promptTokenCount',(usage->>'prompt_token_count')::int,'candidatesTokenCount',(usage->>'candidates_token_count')::int,'thoughtsTokenCount',(usage->>'thoughts_token_count')::int,'totalTokenCount',(usage->>'total_token_count')::int) OR (a.mode='model' AND (evidence->>'finish_reason' IS DISTINCT FROM 'STOP' OR response->'body'->'billing' IS DISTINCT FROM jsonb_build_object('profile_id',a.profile_id,'estimated_usd',cost))) THEN
    outcome:='failed'; saved:=jsonb_set(jsonb_set(response,'{status}','"denied"'),'{body}',jsonb_build_object('code',CASE WHEN exceeded THEN 'agent_budget_exhausted' ELSE 'agent_proposal_mismatch' END));
   END IF;
  ELSIF response->>'status' IS DISTINCT FROM 'denied' OR response->'body' IS DISTINCT FROM jsonb_build_object('code',evidence->>'code') THEN PERFORM ax_error('agent_response_mismatch'); END IF;
  UPDATE ax_agent_roots SET input_tokens=input_tokens+(usage->>'prompt_token_count')::int,output_tokens=output_tokens+output_count::int WHERE id=a.id;
  IF outcome='ok' THEN UPDATE ax_agent_segments SET proposal=proposed WHERE run_id=run; END IF;
 END IF;
 UPDATE ax_agent_operations SET response=saved,usage=ax_agent_settle.usage,elapsed_ms=ax_agent_settle.elapsed_ms,settled_at=clock_timestamp(),actual_usd=cost,settlement_outcome=outcome,provider_evidence=evidence,submitted_response=ax_agent_settle.response,budget_exceeded=exceeded WHERE run_id=run AND sequence=seq;
END $$;
CREATE FUNCTION ax_workbench_quota(owner uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE held bigint; all_held bigint;
BEGIN
 SELECT coalesce(sum(o.limit_bytes-coalesce(f.size_bytes,0)),0),coalesce(sum(o.limit_bytes-coalesce(f.size_bytes,0)) FILTER(WHERE r.owner_user_id=owner),0) INTO all_held,held FROM ax_workbench_outputs o JOIN ax_runs r ON r.run_id=o.run_id LEFT JOIN ax_files f ON f.id=o.file_id WHERE NOT o.released;
 IF coalesce((SELECT sum(size_bytes) FROM ax_files WHERE owner_user_id=owner AND state<>'cancelled'),0)+held>268435456 OR coalesce((SELECT sum(size_bytes) FROM ax_files WHERE state<>'cancelled'),0)+all_held>1073741824 THEN PERFORM ax_error('file_quota_exceeded'); END IF;
END $$;
ALTER FUNCTION ax_file_begin(uuid,uuid,jsonb,uuid) RENAME TO ax_file_begin_v6;
CREATE FUNCTION ax_file_begin(owner uuid,wid uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE result jsonb;
BEGIN result:=ax_file_begin_v6(owner,wid,payload,proposed); PERFORM ax_workbench_quota(owner); RETURN result; END $$;
CREATE FUNCTION ax_workbench_input_manifest(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments;
BEGIN a:=ax_workbench_claim(run,gen,controller); SELECT * INTO s FROM ax_agent_segments WHERE run_id=run; RETURN s.descriptor->'inputs'; END $$;
CREATE FUNCTION ax_workbench_read_chunk(run text,gen bigint,controller text,fid uuid,part integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments;
BEGIN
 a:=ax_workbench_claim(run,gen,controller); SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 IF s.attempt_kind<>'python' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.descriptor->'inputs') f WHERE f->>'file_id'=fid::text) THEN PERFORM ax_error('file_not_found'); END IF;
 RETURN ax_file_read_chunk(a.owner_user_id,a.workspace_id,fid,part);
END $$;
CREATE FUNCTION ax_workbench_definition_chunk(run text,gen bigint,controller text,vid uuid,part integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; v ax_definition_versions; bytes bytea;
BEGIN
 a:=ax_workbench_claim(run,gen,controller);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.definition_manifest) d WHERE d->>'id'=vid::text) OR NOT EXISTS(SELECT 1 FROM ax_agent_segments WHERE run_id=run AND attempt_kind='runtime') THEN PERFORM ax_error('definition_version_not_found'); END IF;
 SELECT * INTO v FROM ax_definition_versions WHERE id=vid; bytes:=convert_to(ax_definition_canonical(v.content),'UTF8');
 IF part IS NULL OR part<0 OR part>=(octet_length(bytes)+32767)/32768 THEN PERFORM ax_error('invalid_file_chunk'); END IF;
 RETURN jsonb_build_object('version_id',vid,'kind',(SELECT kind FROM ax_definitions WHERE id=v.definition_id),'sha256',v.sha256,'size_bytes',octet_length(bytes),'chunk_count',(octet_length(bytes)+32767)/32768,'index',part,'content_base64',replace(encode(substring(bytes FROM part*32768+1 FOR 32768),'base64'),E'\n',''));
END $$;
CREATE FUNCTION ax_workbench_output_begin(run text,gen bigint,controller text,output_alias text,size_bytes integer,digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; o ax_workbench_outputs; f ax_files;
BEGIN
 a:=ax_workbench_claim(run,gen,controller,false); PERFORM pg_advisory_xact_lock(926018,1);
 SELECT * INTO o FROM ax_workbench_outputs WHERE run_id=run AND alias=output_alias FOR UPDATE;
 IF NOT FOUND OR o.released OR NOT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='start' AND evidence->'confirmed'='true') OR size_bytes IS NULL OR size_bytes NOT BETWEEN 1 AND o.limit_bytes OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
 IF o.file_id IS NOT NULL THEN
  SELECT * INTO f FROM ax_files WHERE id=o.file_id;
  IF f.size_bytes<>size_bytes OR f.sha256<>digest THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('file_id',f.id,'replayed',true);
 END IF;
 INSERT INTO ax_files(id,owner_user_id,workspace_id,request_key,name,size_bytes,sha256,media_type) VALUES(gen_random_uuid(),a.owner_user_id,a.workspace_id,gen_random_uuid(),o.name,size_bytes,digest,CASE WHEN o.name ~ '\.csv$' THEN 'text/csv' ELSE 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' END) RETURNING * INTO f;
 UPDATE ax_workbench_outputs SET file_id=f.id WHERE run_id=run AND alias=output_alias;
 PERFORM ax_workbench_quota(a.owner_user_id);
 RETURN jsonb_build_object('file_id',f.id,'replayed',false);
END $$;
CREATE FUNCTION ax_workbench_output_chunk(run text,gen bigint,controller text,output_alias text,part integer,bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; f ax_files; prior bytea;
BEGIN
 a:=ax_workbench_claim(run,gen,controller,false);
 SELECT f1.* INTO f FROM ax_workbench_outputs o JOIN ax_files f1 ON f1.id=o.file_id WHERE o.run_id=run AND o.alias=output_alias AND NOT o.released FOR UPDATE OF f1;
 IF NOT FOUND OR part IS NULL OR part<0 OR part>=(f.size_bytes+32767)/32768 OR bytes IS NULL OR octet_length(bytes)<>least(32768,f.size_bytes-part*32768) THEN PERFORM ax_error('invalid_file_chunk'); END IF;
 SELECT content INTO prior FROM ax_file_chunks WHERE file_id=f.id AND chunk_index=part;
 IF FOUND THEN IF prior<>bytes THEN PERFORM ax_error('file_chunk_conflict'); END IF; RETURN '{"ok":true,"replayed":true}'; END IF;
 IF f.state<>'uploading' THEN PERFORM ax_error('file_already_ready'); END IF;
 INSERT INTO ax_file_chunks VALUES(f.id,part,bytes); RETURN '{"ok":true,"replayed":false}';
END $$;
CREATE FUNCTION ax_workbench_output_seal(run text,gen bigint,controller text,output_alias text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; f ax_files; body bytea; parts integer;
BEGIN
 a:=ax_workbench_claim(run,gen,controller,false);
 SELECT f1.* INTO f FROM ax_workbench_outputs o JOIN ax_files f1 ON f1.id=o.file_id WHERE o.run_id=run AND o.alias=output_alias AND NOT o.released FOR UPDATE OF f1;
 IF NOT FOUND THEN PERFORM ax_error('file_not_found'); END IF;
 IF f.state='ready' THEN RETURN jsonb_build_object('file_id',f.id,'replayed',true); END IF;
 SELECT count(*),string_agg(content,''::bytea ORDER BY chunk_index) INTO parts,body FROM ax_file_chunks WHERE file_id=f.id;
 IF parts<>(f.size_bytes+32767)/32768 OR octet_length(body) IS DISTINCT FROM f.size_bytes THEN PERFORM ax_error('file_incomplete'); END IF;
 IF encode(sha256(body),'hex')<>f.sha256 THEN PERFORM ax_error('file_hash_mismatch'); END IF;
 UPDATE ax_files SET state='ready',ready_at=clock_timestamp() WHERE id=f.id;
 INSERT INTO ax_workbench_files VALUES(a.id,a.owner_user_id,a.workspace_id,output_alias,f.id,run);
 RETURN jsonb_build_object('file_id',f.id,'replayed',false);
END $$;
ALTER FUNCTION ax_finish(text,bigint,text) RENAME TO ax_finish_v7;
CREATE FUNCTION ax_finish(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments; r ax_runs; j ax_jobs; m ax_agent_operations; t ax_agent_operations; known boolean; stopped boolean; success boolean; elapsed bigint; next_run text; out_result jsonb; terminal text; reason text; f uuid; summary text;
BEGIN
 IF NOT ax_workbench_is_run(run) THEN RETURN ax_finish_v7(run,gen,controller); END IF;
 SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 IF s.finish_response IS NOT NULL AND s.finish_generation=gen AND s.finish_controller=controller THEN RETURN s.finish_response; END IF;
 a:=ax_workbench_claim(run,gen,controller,false); SELECT * INTO r FROM ax_runs WHERE run_id=run; SELECT * INTO j FROM ax_jobs WHERE run_id=run;
 SELECT * INTO m FROM ax_agent_operations WHERE run_id=run AND sequence=1; SELECT * INTO t FROM ax_agent_operations WHERE run_id=run AND sequence=2;
 known:=NOT EXISTS(SELECT 1 FROM ax_agent_operations WHERE run_id=run AND (settled_at IS NULL OR actual_usd IS NULL));
 stopped:=EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='egress_deny' AND evidence=jsonb_build_object('egress_denied',true,'actor',run)) AND EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='suspend' AND evidence=jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run)) AND (s.attempt_kind<>'python' OR s.host_cleanup IS NOT NULL);
 IF NOT known OR NOT stopped THEN
  reason:=CASE WHEN NOT known THEN 'agent_operation_unknown' ELSE 'cleanup_unconfirmed' END;
  UPDATE ax_runs SET phase='needs_recovery',error_type=reason WHERE run_id=run; UPDATE ax_jobs SET state='held',lease_until=NULL WHERE run_id=run;
  UPDATE ax_agent_roots SET state='blocked_unknown' WHERE id=a.id; UPDATE ax_execution_slot SET hold_reason=reason WHERE id;
  RETURN '{"resolved":false,"outcome":"failed"}';
 END IF;
 success:=coalesce(r.result->>'status'='succeeded',false);
 IF s.attempt_kind='runtime' THEN success:=success AND m.settlement_outcome='ok' AND t.settlement_outcome='ok' AND s.proposal IS NOT NULL AND r.result->'usage'=m.usage;
 ELSE success:=success AND EXISTS(SELECT 1 FROM ax_workbench_outputs WHERE run_id=run) AND NOT EXISTS(SELECT 1 FROM ax_workbench_outputs o LEFT JOIN ax_files f1 ON f1.id=o.file_id WHERE o.run_id=run AND f1.state IS DISTINCT FROM 'ready'); END IF;
 success:=coalesce(success,false);
 summary:=CASE WHEN s.attempt_kind='runtime' THEN coalesce(s.proposal->>'text',s.proposal->>'purpose','実行を停止しました') ELSE coalesce(r.result->>'summary','コード実行を停止しました') END;
 out_result:=jsonb_build_object('schema_version',2,'run_id',run,'adapter',r.request_data->>'adapter','status',CASE WHEN success THEN 'succeeded' ELSE 'failed' END,'exit_code',CASE WHEN success THEN 0 ELSE 1 END,'error_type',CASE WHEN NOT success THEN 'workbench_interrupted' END,'summary',summary,'usage',coalesce(m.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'),'estimated_usd',coalesce(m.actual_usd,0));
 INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','workbench_terminal','original_result',r.result));
 UPDATE ax_runs SET result=out_result,resolved=true,outcome=CASE WHEN success THEN 'succeeded' ELSE 'failed' END,phase='finished',cleanup=jsonb_build_object('egress_denied',true,'suspended',true),cleanup_errors='[]' WHERE run_id=run;
 UPDATE ax_jobs SET state='done',lease_until=NULL WHERE run_id=run;
 SELECT coalesce(greatest(0,ceil(extract(epoch FROM clock_timestamp()-min(intent_at))*1000)),0)::bigint INTO elapsed FROM ax_effects WHERE run_id=run AND operation='create';
 UPDATE ax_agent_segments SET finished_at=clock_timestamp() WHERE run_id=run;
 terminal:=CASE WHEN a.stop_requested OR j.kind='recovery' THEN 'stopped' WHEN NOT success OR a.active_ms+elapsed>=300000 THEN 'failed' WHEN s.attempt_kind='runtime' AND s.proposal->>'kind'='question' THEN 'waiting_input' WHEN s.attempt_kind='runtime' AND s.proposal->>'kind'='unsupported' THEN 'failed' ELSE 'succeeded' END;
 UPDATE ax_agent_roots SET active_ms=active_ms+elapsed,revision=revision+1,state=terminal,question=CASE WHEN terminal='waiting_input' THEN s.proposal->>'text' ELSE question END,question_id=CASE WHEN terminal='waiting_input' THEN gen_random_uuid() ELSE question_id END,wait_expires_at=CASE WHEN terminal='waiting_input' THEN clock_timestamp()+interval '24 hours' END WHERE id=a.id RETURNING * INTO a;
 INSERT INTO ax_workbench_checkpoints VALUES(a.id,a.revision,run,CASE WHEN success THEN CASE WHEN s.attempt_kind='runtime' THEN s.proposal->>'kind' ELSE 'python_result' END ELSE 'failed' END,summary);
 UPDATE ax_execution_slot SET run_id=NULL,hold_reason=NULL WHERE id;
 PERFORM pg_advisory_xact_lock(926018,1);
 FOR f IN SELECT file_id FROM ax_workbench_outputs WHERE run_id=run AND file_id IS NOT NULL LOOP
  IF EXISTS(SELECT 1 FROM ax_files WHERE id=f AND state='uploading') THEN UPDATE ax_files SET state='cancelled' WHERE id=f; DELETE FROM ax_file_chunks WHERE file_id=f; END IF;
 END LOOP;
 UPDATE ax_workbench_outputs SET released=true WHERE run_id=run;
 IF success AND NOT a.stop_requested AND j.kind='execute' AND a.active_ms<300000 AND (s.attempt_kind='python' OR s.proposal->>'kind'='python') THEN
  BEGIN
   UPDATE ax_agent_roots SET state='running' WHERE id=a.id RETURNING * INTO a;
   next_run:='ax-run-'||substr(replace(gen_random_uuid()::text,'-',''),1,16);
   PERFORM ax_workbench_next(a,CASE WHEN s.attempt_kind='python' THEN 'runtime' ELSE 'python' END,a.initial_text,next_run,run,CASE WHEN s.attempt_kind='runtime' THEN s.proposal END);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
   GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT; next_run:=NULL;
   UPDATE ax_agent_roots SET state=CASE WHEN reason IN ('agent_stopped','agent_grant_expired','agent_grant_revoked','workspace_not_found','definition_archived','definition_dependency_unavailable','workbench_disabled','python_disabled') THEN 'stopped' ELSE 'failed' END WHERE id=a.id;
   INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','handoff_denied','reason',reason));
  END;
 END IF;
 out_result:=jsonb_build_object('resolved',true,'outcome',CASE WHEN success THEN 'succeeded' ELSE 'failed' END,'next_run_id',next_run);
 UPDATE ax_agent_segments SET finish_generation=gen,finish_controller=controller,finish_response=out_result WHERE run_id=run;
 RETURN out_result;
END $$;
CREATE FUNCTION ax_workbench_request_recovery(owner uuid,wid uuid,root uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots;
BEGIN
 a:=ax_workbench_owned(owner,wid,root); PERFORM ax_request_recovery(owner,a.current_run_id);
 IF EXISTS(SELECT 1 FROM ax_runs WHERE run_id=a.current_run_id AND resolved AND NOT apply_attempted AND NOT start_attempted) THEN PERFORM pg_advisory_xact_lock(926018,1); UPDATE ax_workbench_outputs SET released=true WHERE run_id=a.current_run_id; END IF;
 RETURN '{"ok":true}';
END $$;
ALTER FUNCTION ax_cancel_unstarted(text,bigint,text) RENAME TO ax_cancel_unstarted_v7;
CREATE FUNCTION ax_cancel_unstarted(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE result jsonb;
BEGIN result:=ax_cancel_unstarted_v7(run,gen,controller); IF ax_workbench_is_run(run) THEN PERFORM pg_advisory_xact_lock(926018,1); UPDATE ax_workbench_outputs SET released=true WHERE run_id=run; END IF; RETURN result; END $$;
CREATE OR REPLACE FUNCTION ax_workbench_stop(owner uuid,wid uuid,root uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots;
BEGIN
 PERFORM ax_agent_owner_lock(owner); a:=ax_workbench_owned(owner,wid,root);
 UPDATE ax_agent_roots SET stop_requested=true,revision=revision+1,state=CASE WHEN state='waiting_input' THEN 'stopped' WHEN state='running' THEN 'stopping' ELSE state END WHERE id=root AND NOT stop_requested AND state IN ('running','stopping','waiting_input','blocked_unknown');
 RETURN '{"ok":true}';
END $$;
CREATE OR REPLACE FUNCTION ax_agent_authorize(owner uuid,wid uuid,root uuid) RETURNS ax_agent_roots LANGUAGE plpgsql STABLE AS $$
DECLARE a ax_agent_roots;
BEGIN SELECT * INTO a FROM ax_agent_roots WHERE id=root AND owner_user_id=owner AND workspace_id=wid AND runtime_version=1;
 IF NOT FOUND THEN PERFORM ax_error('agent_not_found'); END IF; PERFORM org_authorize(owner,wid); RETURN a;
END $$;
CREATE OR REPLACE FUNCTION ax_agent_list(owner uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN PERFORM org_authorize(owner,wid); RETURN jsonb_build_object('roots',coalesce((SELECT jsonb_agg(ax_agent_view(a) ORDER BY a.created_at DESC) FROM (SELECT * FROM ax_agent_roots WHERE owner_user_id=owner AND workspace_id=wid AND runtime_version=1 ORDER BY created_at DESC LIMIT 50) a),'[]')); END $$;
CREATE OR REPLACE FUNCTION ax_ws_authorize(owner uuid,run text,wid uuid) RETURNS ax_runs LANGUAGE plpgsql STABLE AS $$
DECLARE r ax_runs;
BEGIN r:=ax_authorize(owner,run); IF r.workspace_id IS DISTINCT FROM wid OR ax_workbench_is_run(run) THEN PERFORM ax_error('run_not_found'); END IF; IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF; RETURN r; END $$;
CREATE OR REPLACE FUNCTION ax_ws_list_runs(owner uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; rows jsonb:='[]';
BEGIN PERFORM org_active(owner); IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF;
 FOR r IN SELECT * FROM ax_runs WHERE owner_user_id=owner AND workspace_id IS NOT DISTINCT FROM wid AND NOT ax_workbench_is_run(run_id) ORDER BY sort_at DESC,run_id DESC LIMIT 50 LOOP rows:=rows||jsonb_build_array(ax_snapshot(r,false)); END LOOP; RETURN rows;
END $$;
ALTER FUNCTION ax_file_owned(uuid,uuid,uuid) RENAME TO ax_file_owned_v6;
CREATE FUNCTION ax_file_owned(owner uuid,wid uuid,fid uuid) RETURNS ax_files LANGUAGE plpgsql AS $$
DECLARE f ax_files;
BEGIN f:=ax_file_owned_v6(owner,wid,fid); IF f.state='uploading' AND EXISTS(SELECT 1 FROM ax_workbench_outputs WHERE file_id=fid) THEN PERFORM ax_error('file_not_found'); END IF; RETURN f; END $$;
DO $$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('ax_file_list(uuid,uuid,uuid,integer)'::regprocedure);
 EXECUTE replace(source,'AND state<>''cancelled''','AND state<>''cancelled'' AND NOT (state=''uploading'' AND EXISTS(SELECT 1 FROM ax_workbench_outputs o WHERE o.file_id=ax_files.id))');
 source:=pg_get_functiondef('ax_file_cancel_unavailable(uuid,uuid)'::regprocedure);
 EXECUTE replace(source,'AND f.state=''uploading'' AND NOT EXISTS','AND f.state=''uploading'' AND NOT EXISTS(SELECT 1 FROM ax_workbench_outputs o WHERE o.file_id=f.id) AND NOT EXISTS');
 source:=pg_get_functiondef('ax_agent_settle_v7(text,bigint,text,integer,jsonb,jsonb,integer,jsonb)'::regprocedure);
 EXECUTE replace(source,'ax_agent_settle.','ax_agent_settle_v7.');
 source:=pg_get_functiondef('ax_agent_authorize_generation_v7(text,bigint,text,integer,text,integer)'::regprocedure);
 EXECUTE replace(source,'ax_agent_authorize_generation.','ax_agent_authorize_generation_v7.');
END $$;
ALTER FUNCTION ax_validate_result(jsonb,text,text,text,bytea) RENAME TO ax_validate_result_v7;
CREATE FUNCTION ax_validate_result(value jsonb,run text,adapter text,output text,artifact bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT ax_workbench_is_run(run) THEN PERFORM ax_validate_result_v7(value,run,adapter,output,artifact); RETURN; END IF;
 IF artifact IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ax_runs WHERE run_id=run AND resolved AND result=value AND value->'schema_version'='2'::jsonb AND value->>'run_id'=run) THEN PERFORM ax_error('invalid_result'); END IF;
END $$;
DO $$
DECLARE f record; role_name text;
BEGIN
 FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  IF f.proname ~ '_v[1-7]$' OR f.proname='ax_guard_integrity' THEN
   FOREACH role_name IN ARRAY ARRAY['ax_api','ax_execution'] LOOP IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name); END IF; END LOOP;
  END IF;
 END LOOP;
END $$;
