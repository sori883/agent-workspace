SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
ALTER TABLE ax_agent_roots ADD COLUMN skill_discovery boolean NOT NULL DEFAULT false,
 ADD COLUMN skill_catalog jsonb, ADD COLUMN skill_catalog_omitted integer NOT NULL DEFAULT 0 CHECK(skill_catalog_omitted>=0),
 ADD COLUMN failure_reason text;
ALTER TABLE ax_agent_roots ADD CONSTRAINT ax_workbench_skill_catalog_check CHECK(
 (NOT skill_discovery AND skill_catalog IS NULL AND skill_catalog_omitted=0)
 OR (skill_discovery AND runtime_version=2 AND definition_version_id IS NULL AND definition_manifest='[]'::jsonb
 AND skill_catalog IS NOT NULL AND jsonb_typeof(skill_catalog)='array' AND jsonb_array_length(skill_catalog)<=32 AND octet_length(ax_json(skill_catalog,true))<=8192));
CREATE TABLE ax_workbench_skill_loads(
 root_id uuid NOT NULL REFERENCES ax_agent_roots(id), skill_id text NOT NULL,
 path text NOT NULL, source_run_id text NOT NULL REFERENCES ax_runs(run_id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(root_id,skill_id,path),
 CHECK(skill_id IN ('general-v1','tabular-v1') OR skill_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 CHECK(path='SKILL.md' OR (skill_id NOT IN ('general-v1','tabular-v1') AND char_length(path)<=255 AND path ~ '^(references|scripts|assets)/([A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$'))
);
CREATE TRIGGER ax_workbench_skill_load_immutable BEFORE UPDATE OR DELETE ON ax_workbench_skill_loads FOR EACH ROW EXECUTE FUNCTION ax_workbench_immutable();

CREATE OR REPLACE FUNCTION ax_workbench_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ax_agent_roots' THEN
  IF ROW(NEW.runtime_version,NEW.execution_policy,NEW.definition_version_id,NEW.definition_manifest,NEW.initial_text,NEW.runtime_image,NEW.code_image,NEW.code_profile,NEW.skill_discovery,NEW.skill_catalog,NEW.skill_catalog_omitted) IS DISTINCT FROM ROW(OLD.runtime_version,OLD.execution_policy,OLD.definition_version_id,OLD.definition_manifest,OLD.initial_text,OLD.runtime_image,OLD.code_image,OLD.code_profile,OLD.skill_discovery,OLD.skill_catalog,OLD.skill_catalog_omitted) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSIF TG_TABLE_NAME='ax_agent_segments' THEN
  IF ROW(NEW.attempt_kind,NEW.predecessor_run_id,NEW.descriptor,NEW.checkpoint_revision) IS DISTINCT FROM ROW(OLD.attempt_kind,OLD.predecessor_run_id,OLD.descriptor,OLD.checkpoint_revision) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSE PERFORM ax_error('immutable_workbench'); END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ax_workbench_definitions(a ax_agent_roots) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pinned jsonb; v jsonb; vid uuid;
BEGIN
 IF a.skill_discovery THEN
  FOR vid IN SELECT (entry->>'id')::uuid FROM jsonb_array_elements(a.skill_catalog) entry
   UNION SELECT skill_id::uuid FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id NOT IN ('general-v1','tabular-v1') LOOP
   v:=ax_definition_version(a.owner_user_id,a.workspace_id,vid,true);
   IF v->>'kind'<>'skill' THEN PERFORM ax_error('definition_dependency_unavailable'); END IF;
  END LOOP;
 ELSE
  FOR pinned IN SELECT * FROM jsonb_array_elements(a.definition_manifest) LOOP
   v:=ax_definition_version(a.owner_user_id,a.workspace_id,(pinned->>'id')::uuid,true);
   IF v->>'sha256' IS DISTINCT FROM pinned->>'sha256' THEN PERFORM ax_error('definition_dependency_unavailable'); END IF;
  END LOOP;
 END IF;
END $$;
CREATE FUNCTION ax_workbench_skill_context(a ax_agent_roots) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE loaded jsonb; files jsonb; builtin jsonb;
BEGIN
 PERFORM ax_workbench_definitions(a);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.content->>'name','description',v.content->>'description','instructions',v.content->>'instructions',
  'files',coalesce((SELECT jsonb_agg(jsonb_build_object('path',f->>'path','size_bytes',octet_length(f->>'content'),'sha256',encode(sha256(convert_to(f->>'content','UTF8')),'hex')) ORDER BY f->>'path') FROM jsonb_array_elements(v.content->'files') f),'[]'::jsonb)) ORDER BY v.content->>'name',v.id),'[]'::jsonb)
 INTO loaded FROM ax_workbench_skill_loads l JOIN ax_definition_versions v ON v.id::text=l.skill_id WHERE l.root_id=a.id AND l.path='SKILL.md';
 SELECT coalesce(jsonb_agg(jsonb_build_object('skill_id',l.skill_id,'path',l.path,'content',f->>'content','size_bytes',octet_length(f->>'content'),'sha256',encode(sha256(convert_to(f->>'content','UTF8')),'hex')) ORDER BY l.skill_id,l.path),'[]'::jsonb)
 INTO files FROM ax_workbench_skill_loads l JOIN ax_definition_versions v ON v.id::text=l.skill_id CROSS JOIN LATERAL jsonb_array_elements(v.content->'files') f WHERE l.root_id=a.id AND l.path<>'SKILL.md' AND f->>'path'=l.path;
 SELECT coalesce(jsonb_agg(skill_id ORDER BY skill_id),'[]'::jsonb) INTO builtin FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id IN ('general-v1','tabular-v1');
 RETURN jsonb_build_object('version',1,'catalog',a.skill_catalog,'omitted_count',a.skill_catalog_omitted,'loaded_skills',loaded,'loaded_files',files,'builtin_skill_ids',builtin);
END $$;
CREATE FUNCTION ax_workbench_skill_read(a ax_agent_roots,p jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sid text; n integer; v jsonb;
BEGIN
 IF NOT a.skill_discovery THEN PERFORM ax_error('skill_selection_unavailable'); END IF;
 PERFORM ax_workbench_definitions(a);
 IF a.model_calls>=6 OR (SELECT count(*) FROM ax_agent_segments WHERE root_id=a.id)>=9 THEN PERFORM ax_error('agent_budget_exhausted'); END IF;
 IF p->>'kind'='read_skills' THEN
  SELECT count(*) INTO n FROM ax_workbench_skill_loads WHERE root_id=a.id AND path='SKILL.md' AND skill_id<>'general-v1';
  IF n+jsonb_array_length(p->'skill_ids')>8 THEN PERFORM ax_error('skill_load_limit'); END IF;
  FOR sid IN SELECT jsonb_array_elements_text(p->'skill_ids') LOOP
   IF sid='general-v1' OR EXISTS(SELECT 1 FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id=sid AND path='SKILL.md') THEN PERFORM ax_error('skill_already_loaded'); END IF;
   IF sid<>'tabular-v1' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.skill_catalog) e WHERE e->>'id'=sid) THEN PERFORM ax_error('skill_not_available'); END IF;
  END LOOP;
 ELSIF p->>'kind'='read_skill_file' THEN
  sid:=p->>'skill_id';
  IF NOT EXISTS(SELECT 1 FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id=sid AND path='SKILL.md') THEN PERFORM ax_error('skill_not_loaded'); END IF;
  IF EXISTS(SELECT 1 FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id=sid AND path=p->>'path') THEN PERFORM ax_error('skill_already_loaded'); END IF;
  v:=ax_definition_version(a.owner_user_id,a.workspace_id,sid::uuid,true);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'content'->'files') f WHERE f->>'path'=p->>'path') THEN PERFORM ax_error('skill_file_not_found'); END IF;
 ELSE PERFORM ax_error('invalid_request'); END IF;
END $$;
CREATE FUNCTION ax_workbench_skill_load(a ax_agent_roots,p jsonb,run text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM ax_workbench_skill_read(a,p);
 IF p->>'kind'='read_skills' THEN
  INSERT INTO ax_workbench_skill_loads SELECT a.id,sid,'SKILL.md',run FROM jsonb_array_elements_text(p->'skill_ids') sid;
 ELSE INSERT INTO ax_workbench_skill_loads VALUES(a.id,p->>'skill_id',p->>'path',run); END IF;
END $$;

CREATE OR REPLACE FUNCTION ax_workbench_view(a ax_agent_roots) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',a.id,'protocol_version',2,'state',CASE WHEN a.state IN ('running','stopping') AND EXISTS(SELECT 1 FROM ax_jobs WHERE run_id=a.current_run_id AND state='claimed' AND lease_until<=clock_timestamp()) THEN 'blocked_unknown' ELSE a.state END,
 'skill_catalog_omitted',a.skill_catalog_omitted,'failure_reason',a.failure_reason,'revision',a.revision,'current_run_id',a.current_run_id,'stage',(SELECT attempt_kind FROM ax_agent_segments WHERE run_id=a.current_run_id),'mode',a.mode,'question_id',a.question_id,'question',a.question,
 'can_answer',a.state='waiting_input' AND NOT a.stop_requested AND a.wait_expires_at>clock_timestamp(),'stop_requested',a.stop_requested,'model_calls',a.model_calls,'tool_calls',a.tool_calls,'python_calls',a.python_calls,'active_ms',a.active_ms,
 'estimated_usd',CASE WHEN EXISTS(SELECT 1 FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.settled_at IS NULL) THEN NULL ELSE ax_workbench_cost(a.id,false) END,
 'reserved_usd',coalesce((SELECT sum(o.reserved_usd) FROM ax_agent_operations o JOIN ax_agent_segments s USING(run_id) WHERE s.root_id=a.id AND o.settled_at IS NULL),0),
 'input_files',coalesce((SELECT jsonb_agg(ax_workbench_file_view(f) ORDER BY f.alias) FROM ax_workbench_files f WHERE f.root_id=a.id AND source_run_id IS NULL),'[]'),
 'output_files',coalesce((SELECT jsonb_agg(ax_workbench_file_view(f) ORDER BY f.alias) FROM ax_workbench_files f WHERE f.root_id=a.id AND source_run_id IS NOT NULL),'[]'),
 'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('run_id',h.run_id,'kind',h.kind,'text',h.text) ORDER BY h.sequence,h.position) FROM (SELECT s.sequence,0 AS position,r.run_id,'user_'||r.kind AS kind,r.payload->>'text' AS text FROM ax_agent_requests r JOIN ax_agent_segments s ON s.run_id=r.run_id WHERE r.root_id=a.id UNION ALL SELECT s.sequence,1,c.run_id,c.kind,c.text FROM ax_workbench_checkpoints c JOIN ax_agent_segments s ON s.run_id=c.run_id WHERE c.root_id=a.id) h),'[]'),
 'checkpoints',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',c.revision,'run_id',c.run_id,'kind',c.kind,'text',c.text) ORDER BY c.revision) FROM ax_workbench_checkpoints c WHERE root_id=a.id),'[]'))
$$;

CREATE OR REPLACE FUNCTION ax_workbench_next(a ax_agent_roots,kind text,input_text text,run text,previous text DEFAULT NULL,code jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
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
 IF a.skill_discovery AND kind='runtime' THEN descriptor:=descriptor||jsonb_build_object('skill_context',ax_workbench_skill_context(a)); END IF;
 IF a.skill_discovery AND octet_length(ax_json(descriptor,true))>40960 THEN PERFORM ax_error('skill_context_too_large'); END IF;
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

CREATE OR REPLACE FUNCTION ax_workbench_start(owner uuid,wid uuid,payload jsonb,proposed_run text,expires double precision,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; prior ax_agent_requests; request_key uuid; mode text; vid uuid; v jsonb; dep uuid; deps jsonb:='[]'; catalog jsonb:='[]'; entry jsonb; omitted integer:=0; builtin text; explicit_definitions uuid[]:=ARRAY[]::uuid[]; f ax_files; fid uuid; count_files integer:=0; size_files bigint:=0; control ax_workbench_control;
BEGIN
 PERFORM ax_agent_owner_lock(owner); PERFORM ax_file_authorize(owner,wid);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['key','text','mode','input_file_ids'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(payload) k WHERE k NOT IN ('key','text','mode','allow_model','agent_version_id','skill_version_ids','builtin_skill_ids','input_file_ids')) OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR octet_length(payload->>'text') NOT BETWEEN 1 AND 2048 OR payload->>'text' !~ '[^[:space:]]' OR jsonb_typeof(payload->'input_file_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'input_file_ids')>4 THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN request_key:=(payload->>'key')::uuid; vid:=(payload->>'agent_version_id')::uuid; EXCEPTION WHEN OTHERS THEN PERFORM ax_error('invalid_request'); END;
 IF payload ? 'skill_version_ids' AND (jsonb_typeof(payload->'skill_version_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'skill_version_ids')>8 OR (vid IS NOT NULL AND jsonb_array_length(payload->'skill_version_ids')>0)) THEN PERFORM ax_error('invalid_request'); END IF;
 mode:=payload->>'mode'; IF request_key IS NULL OR mode IS NULL OR mode NOT IN ('preview','model') OR (payload ? 'allow_model' AND jsonb_typeof(payload->'allow_model')<>'boolean') THEN PERFORM ax_error('invalid_request'); END IF;
 IF mode='model' AND payload->'allow_model' IS DISTINCT FROM 'true'::jsonb THEN PERFORM ax_error('model_not_allowed'); END IF;
 SELECT * INTO prior FROM ax_agent_requests WHERE owner_user_id=owner AND ax_agent_requests.key=request_key;
 IF FOUND THEN
  IF prior.kind<>'start' OR prior.payload<>payload OR NOT EXISTS(SELECT 1 FROM ax_agent_roots WHERE id=prior.root_id AND workspace_id=wid AND runtime_version=2) THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('root_id',prior.root_id,'run_id',prior.run_id,'replayed',true,'protocol_version',2);
 END IF;
 IF vid IS NOT NULL THEN PERFORM ax_error('agent_selection_disabled'); END IF;
 IF payload ? 'builtin_skill_ids' AND (jsonb_typeof(payload->'builtin_skill_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'builtin_skill_ids')>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'builtin_skill_ids') x WHERE x NOT IN ('"general-v1"'::jsonb,'"tabular-v1"'::jsonb)) OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(payload->'builtin_skill_ids') x)<>jsonb_array_length(payload->'builtin_skill_ids')) THEN PERFORM ax_error('invalid_request'); END IF;
 IF jsonb_array_length(coalesce(payload->'skill_version_ids','[]'::jsonb))+jsonb_array_length(coalesce(payload->'builtin_skill_ids','[]'::jsonb))>8 THEN PERFORM ax_error('invalid_request'); END IF;
 IF expires IS NULL OR NOT isfinite(to_timestamp(expires)) OR expires<=extract(epoch FROM clock_timestamp()) OR expires>extract(epoch FROM clock_timestamp())+86400 THEN PERFORM ax_error('agent_grant_expired'); END IF;
 PERFORM ax_agent_check_token(owner,token_hash);
 SELECT * INTO control FROM ax_workbench_control WHERE id;
 IF control.runtime_image IS NULL OR (mode='model' AND NOT control.trial_enabled) THEN PERFORM ax_error('workbench_disabled'); END IF;
 FOR dep IN SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(coalesce(payload->'skill_version_ids','[]'::jsonb)) x LOOP
  v:=ax_definition_version(owner,wid,dep,true);
  IF v->>'kind'<>'skill' OR EXISTS(SELECT 1 FROM jsonb_array_elements(deps) d WHERE d#>>'{}'=dep::text) OR (v->>'definition_id')::uuid=ANY(explicit_definitions) THEN PERFORM ax_error('invalid_request'); END IF;
  deps:=deps||to_jsonb(dep); explicit_definitions:=array_append(explicit_definitions,(v->>'definition_id')::uuid);
 END LOOP;
 FOR entry IN SELECT jsonb_build_object('id',v.id,'name',v.content->>'name','description',v.content->>'description')
  FROM ax_definitions d CROSS JOIN LATERAL (SELECT * FROM ax_definition_versions WHERE definition_id=d.id ORDER BY version DESC LIMIT 1) v
  WHERE d.workspace_id=wid AND d.kind='skill' AND d.archived_at IS NULL AND (d.visibility='workspace' OR d.created_by_user_id=owner) AND NOT d.id=ANY(explicit_definitions)
  ORDER BY v.content->>'name',v.id LOOP
  IF jsonb_array_length(catalog)<32 AND octet_length(ax_json(catalog||jsonb_build_array(entry),true))<=8192 THEN catalog:=catalog||jsonb_build_array(entry); ELSE omitted:=omitted+1; END IF;
 END LOOP;
 PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
 INSERT INTO ax_agent_roots(id,owner_user_id,workspace_id,state,grant_expires_at,grant_token_hash,mode,profile_id,runtime_version,execution_policy,definition_version_id,definition_manifest,initial_text,runtime_image,code_image,code_profile,skill_discovery,skill_catalog,skill_catalog_omitted)
 VALUES(gen_random_uuid(),owner,wid,'running',to_timestamp(expires),token_hash,mode,CASE WHEN mode='model' THEN 'gemini-3.1-flash-lite-standard-2026-10-07-v1' ELSE 'preview-v1' END,2,'workbench-trial-2026-10-07-v1',NULL,'[]'::jsonb,payload->>'text',control.runtime_image,control.code_image,control.code_profile,true,catalog,omitted) RETURNING * INTO a;
 FOR dep IN SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(deps) x LOOP INSERT INTO ax_workbench_skill_loads VALUES(a.id,dep::text,'SKILL.md',proposed_run); END LOOP;
 FOR builtin IN SELECT jsonb_array_elements_text(coalesce(payload->'builtin_skill_ids','[]'::jsonb)) LOOP INSERT INTO ax_workbench_skill_loads VALUES(a.id,builtin,'SKILL.md',proposed_run); END LOOP;
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

CREATE OR REPLACE FUNCTION ax_workbench_proposal(model jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE raw json; p jsonb; x jsonb; total bigint:=0;
BEGIN
 IF jsonb_array_length(model->'candidates') IS DISTINCT FROM 1 OR jsonb_array_length(model->'candidates'->0->'content'->'parts') IS DISTINCT FROM 1 OR model->'candidates'->0->>'finishReason' IS DISTINCT FROM 'STOP' THEN RETURN NULL; END IF;
 raw:=(model->'candidates'->0->'content'->'parts'->0->>'text')::json; p:=raw::jsonb;
 IF NOT ax_agent_json_unique(raw) OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF p->>'kind' IN ('question','output','unsupported') THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR jsonb_typeof(p->'text') IS DISTINCT FROM 'string' OR octet_length(p->>'text') NOT BETWEEN 1 AND 2048 OR p->>'text' !~ '[^[:space:]]' THEN RETURN NULL; END IF;
 ELSIF p->>'kind'='read_skills' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR NOT p ?& ARRAY['kind','skill_ids'] OR jsonb_typeof(p->'skill_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'skill_ids') NOT BETWEEN 1 AND 8 THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'skill_ids') entry WHERE jsonb_typeof(entry)<>'string' OR (entry#>>'{}' NOT IN ('general-v1','tabular-v1') AND entry#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) OR (SELECT count(DISTINCT entry) FROM jsonb_array_elements(p->'skill_ids') entry)<>jsonb_array_length(p->'skill_ids') THEN RETURN NULL; END IF;
 ELSIF p->>'kind'='read_skill_file' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR NOT p ?& ARRAY['kind','skill_id','path'] OR jsonb_typeof(p->'skill_id') IS DISTINCT FROM 'string' OR p->>'skill_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(p->'path') IS DISTINCT FROM 'string' OR char_length(p->>'path')>255 OR p->>'path' !~ '^(references|scripts|assets)/([A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$' THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION ax_agent_reserve(run text,gen bigint,controller text,seq integer,request_bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
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
  IF s.proposal->>'kind' IN ('read_skills','read_skill_file') THEN PERFORM ax_workbench_skill_read(a,s.proposal); END IF;
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

CREATE OR REPLACE FUNCTION ax_finish(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
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
 summary:=CASE WHEN s.attempt_kind='runtime' THEN CASE s.proposal->>'kind' WHEN 'read_skills' THEN 'スキルを読み込みます。' WHEN 'read_skill_file' THEN 'スキルの補助資料を読み込みます。' ELSE coalesce(s.proposal->>'text',s.proposal->>'purpose','実行を停止しました') END ELSE coalesce(r.result->>'summary','コード実行を停止しました') END;
 out_result:=jsonb_build_object('schema_version',2,'run_id',run,'adapter',r.request_data->>'adapter','status',CASE WHEN success THEN 'succeeded' ELSE 'failed' END,'exit_code',CASE WHEN success THEN 0 ELSE 1 END,'error_type',CASE WHEN NOT success THEN 'workbench_interrupted' END,'summary',summary,'usage',coalesce(m.usage,'{"prompt_token_count":0,"candidates_token_count":0,"thoughts_token_count":0,"total_token_count":0,"model_call_count":0}'),'estimated_usd',coalesce(m.actual_usd,0));
 INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','workbench_terminal','original_result',r.result));
 UPDATE ax_runs SET result=out_result,resolved=true,outcome=CASE WHEN success THEN 'succeeded' ELSE 'failed' END,phase='finished',cleanup=jsonb_build_object('egress_denied',true,'suspended',true),cleanup_errors='[]' WHERE run_id=run;
 UPDATE ax_jobs SET state='done',lease_until=NULL WHERE run_id=run;
 SELECT coalesce(greatest(0,ceil(extract(epoch FROM clock_timestamp()-min(intent_at))*1000)),0)::bigint INTO elapsed FROM ax_effects WHERE run_id=run AND operation='create';
 UPDATE ax_agent_segments SET finished_at=clock_timestamp() WHERE run_id=run;
 terminal:=CASE WHEN a.stop_requested OR j.kind='recovery' THEN 'stopped' WHEN NOT success OR a.active_ms+elapsed>=300000 THEN 'failed' WHEN s.attempt_kind='runtime' AND s.proposal->>'kind'='question' THEN 'waiting_input' WHEN s.attempt_kind='runtime' AND s.proposal->>'kind'='unsupported' THEN 'failed' ELSE 'succeeded' END;
 UPDATE ax_agent_roots SET active_ms=active_ms+elapsed,revision=revision+1,state=terminal,failure_reason=CASE WHEN terminal='failed' THEN coalesce(m.response->'body'->>'code',t.response->'body'->>'code',r.error_type,r.result->>'error_type','workbench_interrupted') ELSE NULL END,question=CASE WHEN terminal='waiting_input' THEN s.proposal->>'text' ELSE question END,question_id=CASE WHEN terminal='waiting_input' THEN gen_random_uuid() ELSE question_id END,wait_expires_at=CASE WHEN terminal='waiting_input' THEN clock_timestamp()+interval '24 hours' END WHERE id=a.id RETURNING * INTO a;
 INSERT INTO ax_workbench_checkpoints VALUES(a.id,a.revision,run,CASE WHEN success THEN CASE WHEN s.attempt_kind='runtime' THEN s.proposal->>'kind' ELSE 'python_result' END ELSE 'failed' END,summary);
 UPDATE ax_execution_slot SET run_id=NULL,hold_reason=NULL WHERE id;
 PERFORM pg_advisory_xact_lock(926018,1);
 FOR f IN SELECT file_id FROM ax_workbench_outputs WHERE run_id=run AND file_id IS NOT NULL LOOP
  IF EXISTS(SELECT 1 FROM ax_files WHERE id=f AND state='uploading') THEN UPDATE ax_files SET state='cancelled' WHERE id=f; DELETE FROM ax_file_chunks WHERE file_id=f; END IF;
 END LOOP;
 UPDATE ax_workbench_outputs SET released=true WHERE run_id=run;
 IF success AND NOT a.stop_requested AND j.kind='execute' AND a.active_ms<300000 AND (s.attempt_kind='python' OR s.proposal->>'kind' IN ('python','read_skills','read_skill_file')) THEN
  BEGIN
   UPDATE ax_agent_roots SET state='running' WHERE id=a.id RETURNING * INTO a;
   next_run:='ax-run-'||substr(replace(gen_random_uuid()::text,'-',''),1,16);
   IF s.proposal->>'kind' IN ('read_skills','read_skill_file') THEN PERFORM ax_workbench_skill_load(a,s.proposal,run); END IF;
   PERFORM ax_workbench_next(a,CASE WHEN s.attempt_kind='python' OR s.proposal->>'kind' IN ('read_skills','read_skill_file') THEN 'runtime' ELSE 'python' END,a.initial_text,next_run,run,CASE WHEN s.attempt_kind='runtime' AND s.proposal->>'kind'='python' THEN s.proposal END);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
   GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT; next_run:=NULL;
   UPDATE ax_agent_roots SET state=CASE WHEN reason IN ('agent_stopped','agent_grant_expired','agent_grant_revoked','workspace_not_found','definition_archived','definition_dependency_unavailable','workbench_disabled','python_disabled') THEN 'stopped' ELSE 'failed' END,failure_reason=reason WHERE id=a.id;
   INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,gen,jsonb_build_object('kind','handoff_denied','reason',reason));
  END;
 END IF;
 out_result:=jsonb_build_object('resolved',true,'outcome',CASE WHEN success THEN 'succeeded' ELSE 'failed' END,'next_run_id',next_run);
 UPDATE ax_agent_segments SET finish_generation=gen,finish_controller=controller,finish_response=out_result WHERE run_id=run;
 RETURN out_result;
END $$;

DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax\_%' ESCAPE '\' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
