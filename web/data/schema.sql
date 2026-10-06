SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);

CREATE TABLE ax_control(id boolean PRIMARY KEY DEFAULT true CHECK(id), accepting boolean NOT NULL DEFAULT false);
INSERT INTO ax_control VALUES (true, false);
CREATE TABLE ax_conversations(
  id uuid PRIMARY KEY, owner_user_id uuid REFERENCES users(id), head_run_id text,
  turn_count integer NOT NULL DEFAULT 0 CHECK(turn_count BETWEEN 0 AND 32),
  context_bytes bytea NOT NULL DEFAULT convert_to('[]','UTF8'), invalid boolean NOT NULL DEFAULT false
);
CREATE TABLE ax_runs(
  run_id text PRIMARY KEY CHECK(run_id ~ '^ax-run-[0-9a-f]{16}$'), owner_user_id uuid REFERENCES users(id),
  actor_id text, legacy boolean NOT NULL DEFAULT false,
  conversation_id uuid REFERENCES ax_conversations(id), sequence integer, parent_run_id text,
  request_data jsonb NOT NULL, request_bytes bytea NOT NULL, request_hash text NOT NULL,
  image text NOT NULL, manifest jsonb NOT NULL, fingerprint text NOT NULL,
  accepted_at text, sort_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  phase text NOT NULL, outcome text NOT NULL DEFAULT 'pending', resolved boolean NOT NULL DEFAULT false,
  apply_attempted boolean NOT NULL DEFAULT false, start_attempted boolean NOT NULL DEFAULT false,
  result jsonb, cleanup jsonb NOT NULL DEFAULT '{}', cleanup_errors jsonb NOT NULL DEFAULT '[]',
  error_type text, known_estimated_usd_before numeric NOT NULL DEFAULT 0,
  failure_review jsonb, invalid boolean NOT NULL DEFAULT false,
  CHECK(legacy OR (actor_id IS NOT NULL AND (owner_user_id IS NOT NULL OR actor_id LIKE 'service:%'))),
  CHECK((conversation_id IS NULL AND sequence IS NULL AND parent_run_id IS NULL) OR
    (conversation_id IS NOT NULL AND sequence BETWEEN 1 AND 32)),
  UNIQUE(conversation_id,sequence)
);
CREATE TABLE ax_submissions(
  actor_id text NOT NULL, key_hash text NOT NULL, payload_hash text NOT NULL,
  run_id text NOT NULL UNIQUE REFERENCES ax_runs(run_id), PRIMARY KEY(actor_id,key_hash)
);
CREATE TABLE ax_jobs(
  run_id text PRIMARY KEY REFERENCES ax_runs(run_id), kind text NOT NULL CHECK(kind IN ('execute','recovery')),
  state text NOT NULL CHECK(state IN ('ready','claimed','held','done')),
  controller_id text, generation bigint NOT NULL DEFAULT 0, lease_until timestamptz,
  retirement jsonb
);
CREATE TABLE ax_execution_slot(id boolean PRIMARY KEY CHECK(id), run_id text REFERENCES ax_runs(run_id), hold_reason text);
INSERT INTO ax_execution_slot VALUES(true,NULL,NULL);
CREATE TABLE ax_effects(
  run_id text NOT NULL REFERENCES ax_runs(run_id), operation text NOT NULL CHECK(operation IN
    ('create','resume','stage','egress_prepare','egress_allow','start','egress_deny','suspend')),
  operation_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, generation bigint NOT NULL,
  intent_at timestamptz NOT NULL DEFAULT clock_timestamp(), evidence jsonb,
  PRIMARY KEY(run_id,operation)
);
CREATE TABLE ax_observations(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id text NOT NULL REFERENCES ax_runs(run_id),
  generation bigint NOT NULL, operation_id uuid, evidence jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE ax_artifacts(
  run_id text PRIMARY KEY REFERENCES ax_runs(run_id), name text NOT NULL,
  content bytea NOT NULL CHECK(octet_length(content)<=65536), sha256 text NOT NULL,
  CHECK(sha256=encode(sha256(content),'hex'))
);
CREATE TABLE ax_imports(
  run_id text PRIMARY KEY REFERENCES ax_runs(run_id), source_hash text NOT NULL,
  receipt_bytes bytea NOT NULL, request_bytes bytea NOT NULL, result_bytes bytea,
  manifest_bytes bytea NOT NULL, artifact_bytes bytea, imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION ax_error(code text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE=code; END $$;

CREATE FUNCTION ax_immutable_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.run_id,NEW.owner_user_id,NEW.actor_id,NEW.legacy,NEW.conversation_id,NEW.sequence,NEW.parent_run_id,NEW.request_data,NEW.request_bytes,NEW.request_hash,NEW.image,NEW.manifest,NEW.fingerprint,NEW.accepted_at)
    IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.actor_id,OLD.legacy,OLD.conversation_id,OLD.sequence,OLD.parent_run_id,OLD.request_data,OLD.request_bytes,OLD.request_hash,OLD.image,OLD.manifest,OLD.fingerprint,OLD.accepted_at) THEN PERFORM ax_error('immutable_run'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ax_run_immutable BEFORE UPDATE ON ax_runs FOR EACH ROW EXECUTE FUNCTION ax_immutable_run();

CREATE FUNCTION ax_immutable_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN PERFORM ax_error('immutable_conversation'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ax_conversation_immutable BEFORE UPDATE ON ax_conversations FOR EACH ROW EXECUTE FUNCTION ax_immutable_conversation();

CREATE FUNCTION ax_json(value jsonb, compact boolean DEFAULT false) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE answer text; comma text := CASE WHEN compact THEN ',' ELSE ', ' END;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text || CASE WHEN compact THEN ':' ELSE ': ' END || ax_json(v,compact),comma ORDER BY key COLLATE "C"),'')||'}'
      INTO answer FROM jsonb_each(value) t(key,v);
    WHEN 'array' THEN SELECT '['||coalesce(string_agg(ax_json(v,compact),comma ORDER BY i),'')||']' INTO answer FROM jsonb_array_elements(value) WITH ORDINALITY t(v,i);
    ELSE answer := value::text;
  END CASE;
  RETURN answer;
END $$;

CREATE FUNCTION ax_quote_bytes(value bytea) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE answer text;
BEGIN
  IF position(decode('00','hex') IN value)=0 THEN RETURN to_json(convert_from(value,'UTF8'))::text; END IF;
  SELECT '"'||string_agg(substring(quoted FROM 2 FOR length(quoted)-2),'\u0000' ORDER BY i)||'"' INTO answer
  FROM (SELECT to_json(convert_from(decode(replace(part,' ',''),'hex'),'UTF8'))::text AS quoted,i
    FROM unnest(string_to_array(regexp_replace(encode(value,'hex'),'(..)','\1 ','g'),'00 ')) WITH ORDINALITY t(part,i)) parts;
  RETURN answer;
END $$;

CREATE FUNCTION ax_manifest(run_id text,image text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('apiVersion','ax.io/v1alpha1','kind','Task','metadata',jsonb_build_object('name',run_id,'atespace','ax-demo'),
   'spec',jsonb_build_object('image',image,'command',jsonb_build_array('python3','/opt/ax-task/runner.py','wait'),'debug',true))
$$;

CREATE FUNCTION ax_validate_request(value jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n text; body text; size integer:=0;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>6 OR
    NOT value ?& ARRAY['schema_version','run_id','adapter','instruction','inputs','output_name'] OR
    value->'schema_version' IS DISTINCT FROM '1'::jsonb OR coalesce(value->>'run_id','') !~ '^ax-run-[0-9a-f]{16}$' OR
    coalesce(value->>'adapter','') NOT IN ('offline','antigravity') OR jsonb_typeof(value->'instruction') IS DISTINCT FROM 'string' OR
    octet_length(value->>'instruction') NOT BETWEEN 1 AND 2048 OR (value->>'instruction') !~ '[^[:space:]]' OR
    jsonb_typeof(value->'inputs') IS DISTINCT FROM 'object' OR jsonb_typeof(value->'output_name') IS DISTINCT FROM 'string' OR coalesce(value->>'output_name','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    THEN PERFORM ax_error('invalid_request'); END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(value->'inputs'))>4 THEN PERFORM ax_error('invalid_request'); END IF;
  FOR n,body IN SELECT key,v#>>'{}' FROM jsonb_each(value->'inputs') e(key,v) LOOP
    IF n !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' OR jsonb_typeof(value->'inputs'->n)<>'string' THEN PERFORM ax_error('invalid_request'); END IF;
    size:=size+octet_length(body);
  END LOOP;
  IF size>4096 THEN PERFORM ax_error('invalid_request'); END IF;
END $$;

CREATE FUNCTION ax_validate_result(value jsonb, run text, adapter text, output text, artifact bytea) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u jsonb; amount jsonb; n text; a jsonb:=value->'artifact';
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>10 OR
    NOT value ?& ARRAY['schema_version','run_id','adapter','status','exit_code','stop_reason','usage','estimated_usd','error_type','artifact'] OR
    value->'schema_version' IS DISTINCT FROM '1'::jsonb OR value->>'run_id' IS DISTINCT FROM run OR value->>'adapter' IS DISTINCT FROM adapter OR
    coalesce(value->>'status','') NOT IN ('succeeded','failed','timed_out') OR jsonb_typeof(value->'exit_code') IS DISTINCT FROM 'number' OR coalesce(value->>'exit_code','') !~ '^-?[0-9]+$'
    THEN PERFORM ax_error('invalid_result'); END IF;
  FOREACH n IN ARRAY ARRAY['stop_reason','error_type'] LOOP
    IF value->n IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->n) IS DISTINCT FROM 'string' OR (value->>n) !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$') THEN PERFORM ax_error('invalid_result'); END IF;
  END LOOP;
  IF value->'estimated_usd' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'estimated_usd') IS DISTINCT FROM 'number' OR (value->>'estimated_usd')::numeric<0) THEN PERFORM ax_error('invalid_paid_usage'); END IF;
  u:=value->'usage';
  IF u IS DISTINCT FROM 'null'::jsonb THEN
    IF jsonb_typeof(u) IS DISTINCT FROM 'object' OR u='{}'::jsonb THEN PERFORM ax_error('invalid_paid_usage'); END IF;
    FOR n,amount IN SELECT * FROM jsonb_each(u) LOOP
      IF n !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$' OR jsonb_typeof(amount)<>'number' OR amount::text !~ '^[0-9]+$' THEN PERFORM ax_error('invalid_paid_usage'); END IF;
    END LOOP;
  END IF;
  IF a IS DISTINCT FROM 'null'::jsonb THEN
    IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>3 OR
      a->>'name' IS DISTINCT FROM output OR artifact IS NULL OR jsonb_typeof(a->'size_bytes') IS DISTINCT FROM 'number' OR coalesce(a->>'size_bytes','') !~ '^[0-9]+$' OR
      (a->>'size_bytes')::numeric<>octet_length(artifact) OR octet_length(artifact)>65536 OR a->>'sha256' IS DISTINCT FROM encode(sha256(artifact),'hex') THEN PERFORM ax_error('artifact_verification_failed'); END IF;
    PERFORM ax_quote_bytes(artifact);
  ELSIF artifact IS NOT NULL THEN PERFORM ax_error('unexpected_artifact'); END IF;
  IF value->>'status'='succeeded' THEN
    IF (value->>'exit_code')::numeric<>0 OR value->'error_type'<>'null'::jsonb OR u='null'::jsonb OR value->'estimated_usd'='null'::jsonb OR a='null'::jsonb THEN PERFORM ax_error('incomplete_success'); END IF;
    IF adapter='offline' THEN
      IF value->>'stop_reason' IS DISTINCT FROM 'OFFLINE' OR (value->>'estimated_usd')::numeric<>0 OR EXISTS(SELECT 1 FROM jsonb_each(u) e WHERE e.value::text::numeric<>0) THEN PERFORM ax_error('invalid_paid_usage'); END IF;
    ELSIF value->>'stop_reason' IS DISTINCT FROM 'UNSPECIFIED' OR coalesce((u->>'prompt_token_count')::numeric,0)<=0 OR coalesce((u->>'total_token_count')::numeric,0)<=0 THEN PERFORM ax_error('incomplete_success'); END IF;
  ELSIF (value->>'exit_code')::numeric=0 THEN PERFORM ax_error('invalid_result'); END IF;
END $$;

CREATE FUNCTION ax_check_claim(run text, gen bigint, controller text) RETURNS ax_runs LANGUAGE plpgsql AS $$
DECLARE j ax_jobs; r ax_runs;
BEGIN
  SELECT * INTO j FROM ax_jobs WHERE run_id=run FOR UPDATE;
  IF NOT FOUND OR gen IS NULL OR controller IS NULL OR j.state<>'claimed' OR j.generation<>gen OR j.controller_id IS DISTINCT FROM controller OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN PERFORM ax_error('stale_claim'); END IF;
  SELECT * INTO r FROM ax_runs WHERE run_id=run FOR UPDATE;
  IF NOT FOUND OR r.resolved OR r.invalid THEN PERFORM ax_error('execution_already_claimed'); END IF;
  RETURN r;
END $$;

CREATE FUNCTION ax_claim(controller_id text, lease_seconds integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE j ax_jobs; r ax_runs; effects jsonb;
BEGIN
  IF controller_id IS NULL OR controller_id !~ '^[A-Za-z0-9_.:-]{1,128}$' OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300 THEN PERFORM ax_error('invalid_controller'); END IF;
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM ax_jobs WHERE state='claimed') THEN RETURN NULL; END IF;
  SELECT * INTO j FROM ax_jobs WHERE state='ready' ORDER BY run_id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM ax_runs WHERE run_id=j.run_id FOR UPDATE;
  IF r.resolved OR r.invalid OR (j.kind='execute' AND (r.phase<>'accepted' OR r.apply_attempted OR r.start_attempted OR EXISTS(SELECT 1 FROM ax_effects WHERE run_id=r.run_id))) THEN PERFORM ax_error('execution_already_claimed'); END IF;
  IF r.request_data->>'run_id'<>r.run_id OR r.manifest<>ax_manifest(r.run_id,r.image) OR
    r.request_hash<>encode(sha256(r.request_bytes),'hex') OR convert_from(r.request_bytes,'UTF8')::jsonb<>r.request_data OR
    r.fingerprint<>encode(sha256(convert_to(ax_json((r.request_data-'run_id')||jsonb_build_object('image',r.image)),'UTF8')),'hex') THEN PERFORM ax_error('request_receipt_mismatch'); END IF;
  PERFORM ax_validate_request(r.request_data);
  UPDATE ax_jobs SET state='claimed',controller_id=ax_claim.controller_id,generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>lease_seconds) WHERE run_id=r.run_id RETURNING * INTO j;
  UPDATE ax_runs SET phase=CASE WHEN j.kind='recovery' THEN 'recovering' ELSE 'claimed' END WHERE run_id=r.run_id;
  UPDATE ax_execution_slot SET run_id=r.run_id,hold_reason='unresolved_run' WHERE id;
  SELECT coalesce(jsonb_object_agg(operation,jsonb_build_object('operation_id',operation_id,'evidence',evidence)),'{}'::jsonb) INTO effects FROM ax_effects WHERE run_id=r.run_id;
  RETURN jsonb_build_object('run_id',r.run_id,'generation',j.generation,'kind',j.kind,'request',r.request_data,'image',r.image,'manifest',r.manifest,'result',r.result,'effects',effects,'lease_until',j.lease_until);
END $$;

CREATE FUNCTION ax_heartbeat(run text, gen bigint, controller text, lease_seconds integer DEFAULT 30) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM ax_check_claim(run,gen,controller);
  IF lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300 THEN PERFORM ax_error('invalid_controller'); END IF;
  UPDATE ax_jobs SET lease_until=clock_timestamp()+make_interval(secs=>lease_seconds) WHERE run_id=run;
END $$;

CREATE FUNCTION ax_intent(run text, gen bigint, controller text, operation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; op uuid; prior text;
BEGIN
  r:=ax_check_claim(run,gen,controller);
  IF operation IS NULL OR operation NOT IN ('create','resume','stage','egress_prepare','egress_allow','start','egress_deny','suspend') THEN PERFORM ax_error('invalid_operation'); END IF;
  IF EXISTS(SELECT 1 FROM ax_effects e WHERE e.run_id=run AND e.operation=ax_intent.operation) THEN PERFORM ax_error('execution_already_claimed'); END IF;
  IF operation NOT IN ('egress_deny','suspend') THEN
    IF (SELECT kind FROM ax_jobs WHERE run_id=run)<>'execute' OR r.phase='needs_recovery' OR r.error_type IS NOT NULL OR
      EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND ax_effects.operation IN ('egress_deny','suspend')) THEN PERFORM ax_error('restart_forbidden'); END IF;
    prior:=CASE operation WHEN 'resume' THEN 'create' WHEN 'stage' THEN 'resume' WHEN 'egress_allow' THEN 'stage' WHEN 'egress_prepare' THEN 'stage' WHEN 'start' THEN CASE WHEN r.request_data->>'adapter'='offline' THEN 'egress_prepare' ELSE 'egress_allow' END ELSE NULL END;
    IF prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND ax_effects.operation=prior AND evidence->'confirmed'='true'::jsonb) THEN PERFORM ax_error('preceding_effect_unconfirmed'); END IF;
    IF (operation='egress_allow' AND r.request_data->>'adapter'='offline') OR (operation='egress_prepare' AND r.request_data->>'adapter'<>'offline') THEN PERFORM ax_error('model_not_allowed'); END IF;
  END IF;
  INSERT INTO ax_effects(run_id,operation,generation) VALUES(run,operation,gen) RETURNING operation_id INTO op;
  UPDATE ax_runs SET apply_attempted=apply_attempted OR operation='create',start_attempted=start_attempted OR operation='start',phase=operation||'_attempted' WHERE run_id=run;
  RETURN jsonb_build_object('operation_id',op);
END $$;

CREATE FUNCTION ax_evidence(run text, gen bigint, controller text, op uuid, value jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE e ax_effects;
BEGIN
  PERFORM ax_check_claim(run,gen,controller);
  SELECT * INTO e FROM ax_effects WHERE run_id=run AND operation_id=op;
  IF NOT FOUND OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'actor' IS DISTINCT FROM run THEN PERFORM ax_error('invalid_evidence'); END IF;
  IF e.operation='egress_deny' THEN
    IF value<>jsonb_build_object('egress_denied',true,'actor',run) THEN PERFORM ax_error('invalid_evidence'); END IF;
  ELSIF e.operation='suspend' THEN
    IF value<>jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run) THEN PERFORM ax_error('invalid_evidence'); END IF;
  ELSIF value<>jsonb_build_object('confirmed',true,'actor',run) THEN PERFORM ax_error('invalid_evidence'); END IF;
  INSERT INTO ax_observations(run_id,generation,operation_id,evidence) VALUES(run,gen,op,value);
  UPDATE ax_effects SET evidence=value WHERE operation_id=op;
  IF e.operation='start' THEN UPDATE ax_runs SET phase='running' WHERE run_id=run; END IF;
END $$;

CREATE FUNCTION ax_collect(run text, gen bigint, controller text, value jsonb, artifact bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs;
BEGIN
  r:=ax_check_claim(run,gen,controller);
  IF NOT r.start_attempted THEN PERFORM ax_error('start_unconfirmed'); END IF;
  PERFORM ax_validate_result(value,run,r.request_data->>'adapter',r.request_data->>'output_name',artifact);
  IF r.result IS NOT NULL AND r.result<>value THEN PERFORM ax_error('result_conflict'); END IF;
  IF artifact IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM ax_artifacts WHERE run_id=run AND content<>artifact) THEN PERFORM ax_error('artifact_verification_failed'); END IF;
    INSERT INTO ax_artifacts(run_id,name,content,sha256) VALUES(run,value->'artifact'->>'name',artifact,encode(sha256(artifact),'hex')) ON CONFLICT(run_id) DO NOTHING;
  END IF;
  UPDATE ax_runs SET result=value,phase='collected',error_type=NULL WHERE run_id=run;
END $$;

CREATE FUNCTION ax_finish(run text, gen bigint, controller text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; denied boolean; suspended boolean; known boolean; complete boolean; success boolean; body bytea; context bytea;
BEGIN
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  r:=ax_check_claim(run,gen,controller);
  SELECT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='egress_deny' AND evidence=jsonb_build_object('egress_denied',true,'actor',run)) INTO denied;
  SELECT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run AND operation='suspend' AND evidence=jsonb_build_object('phase','SUSPENDED','worker_assignment',NULL,'actor',run)) INTO suspended;
  known:=NOT r.start_attempted OR (r.result IS NOT NULL AND (r.request_data->>'adapter'='offline' OR (jsonb_typeof(r.result->'usage')='object' AND jsonb_typeof(r.result->'estimated_usd')='number')));
  complete:=denied AND suspended AND known;
  success:=complete AND r.result IS NOT NULL AND r.result->>'status'='succeeded';
  IF r.result IS NOT NULL THEN
    SELECT content INTO body FROM ax_artifacts WHERE run_id=run;
    PERFORM ax_validate_result(r.result,run,r.request_data->>'adapter',r.request_data->>'output_name',body);
  END IF;
  UPDATE ax_runs SET resolved=complete,outcome=CASE WHEN success THEN 'succeeded' ELSE 'failed' END,
    phase=CASE WHEN complete THEN 'finished' ELSE 'needs_recovery' END,
    cleanup=jsonb_build_object('egress_denied',denied,'suspended',suspended),
    cleanup_errors=to_jsonb(array_remove(ARRAY[CASE WHEN NOT denied THEN 'egress_denied_unconfirmed' END,CASE WHEN NOT suspended THEN 'suspended_unconfirmed' END],NULL)) WHERE run_id=run;
  UPDATE ax_jobs SET state=CASE WHEN complete THEN 'done' ELSE 'held' END,lease_until=NULL WHERE run_id=run;
  IF complete THEN
    IF success AND r.conversation_id IS NOT NULL THEN
      SELECT context_bytes INTO context FROM ax_conversations WHERE id=r.conversation_id AND head_run_id=run AND owner_user_id IS NOT DISTINCT FROM r.owner_user_id FOR UPDATE;
      IF NOT FOUND OR convert_from(context,'UTF8') IS DISTINCT FROM r.request_data->'inputs'->>'conversation.json' THEN PERFORM ax_error('invalid_conversation_state'); END IF;
      context:=substring(context FROM 1 FOR octet_length(context)-1)||convert_to(CASE WHEN context=convert_to('[]','UTF8') THEN '' ELSE ',' END ||
        '{"role":"user","content":'||to_json(r.request_data->>'instruction')::text||'},{"role":"assistant","content":'||ax_quote_bytes(body)||'}]','UTF8');
      UPDATE ax_conversations SET context_bytes=context WHERE id=r.conversation_id;
    END IF;
    UPDATE ax_execution_slot SET run_id=NULL,hold_reason=NULL WHERE id;
  ELSE UPDATE ax_execution_slot SET hold_reason=CASE WHEN NOT known THEN 'unknown_paid_usage' ELSE 'needs_recovery' END WHERE id; END IF;
  RETURN jsonb_build_object('resolved',complete,'outcome',CASE WHEN success THEN 'succeeded' ELSE 'failed' END);
END $$;

CREATE FUNCTION ax_fail(run text, gen bigint, controller text, code text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM ax_check_claim(run,gen,controller);
  IF code IS NULL OR code !~ '^[A-Za-z][A-Za-z0-9_.:-]{0,95}$' THEN PERFORM ax_error('invalid_error_code'); END IF;
  UPDATE ax_runs SET phase='needs_recovery',error_type=code WHERE run_id=run;
END $$;

CREATE FUNCTION ax_request_recovery(owner uuid, run text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; j ax_jobs;
BEGIN
  PERFORM ax_authorize(owner,run);
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  r:=ax_authorize(owner,run);
  IF r.resolved THEN RETURN jsonb_build_object('run_id',run); END IF;
  SELECT * INTO j FROM ax_jobs WHERE run_id=run FOR UPDATE;
  IF j.state='claimed' AND j.lease_until>clock_timestamp() THEN PERFORM ax_error('another_cli_running'); END IF;
  IF NOT r.apply_attempted AND NOT r.start_attempted AND NOT EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run) THEN
    UPDATE ax_runs SET resolved=true,phase='not_started',outcome='not_started',error_type=NULL,cleanup='{"egress_denied":false,"suspended":false}',cleanup_errors='[]' WHERE run_id=run;
    UPDATE ax_jobs SET state='done',generation=generation+1,lease_until=NULL WHERE run_id=run;
    UPDATE ax_execution_slot SET run_id=NULL,hold_reason=NULL WHERE id AND run_id=run;
  ELSE
    UPDATE ax_runs SET phase='needs_recovery' WHERE run_id=run;
    UPDATE ax_jobs SET state='held',kind='recovery' WHERE run_id=run;
    UPDATE ax_execution_slot SET hold_reason='controller_unknown' WHERE id;
  END IF;
  RETURN jsonb_build_object('run_id',run);
END $$;

CREATE FUNCTION ax_authorize_recovery(run text, retirement jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE j ax_jobs;
BEGIN
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  SELECT * INTO j FROM ax_jobs WHERE run_id=run FOR UPDATE;
  IF NOT FOUND OR j.state NOT IN ('claimed','held') OR (SELECT resolved FROM ax_runs WHERE run_id=run) THEN PERFORM ax_error('invalid_recovery'); END IF;
  IF retirement IS NULL OR retirement->>'controller_id' IS DISTINCT FROM j.controller_id OR retirement->>'generation' IS DISTINCT FROM j.generation::text OR
    retirement->'process_stopped' IS DISTINCT FROM 'true'::jsonb OR retirement->'transport_fenced' IS DISTINCT FROM 'true'::jsonb OR retirement->'inflight_settled' IS DISTINCT FROM 'true'::jsonb THEN PERFORM ax_error('retirement_unconfirmed'); END IF;
  UPDATE ax_jobs SET state='ready',kind='recovery',retirement=ax_authorize_recovery.retirement,lease_until=NULL WHERE run_id=run;
  INSERT INTO ax_observations(run_id,generation,evidence) VALUES(run,j.generation,retirement);
END $$;

CREATE FUNCTION ax_guard(adapter text, signature text) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE r ax_runs; total numeric:=0; cost numeric;
BEGIN
  FOR r IN SELECT * FROM ax_runs ORDER BY run_id LOOP
    IF r.invalid THEN PERFORM ax_error('invalid_run_ledger'); END IF;
    IF NOT r.resolved THEN PERFORM ax_error('unresolved_run'); END IF;
    IF r.request_data->>'adapter'='antigravity' AND r.start_attempted THEN
      IF r.result IS NULL OR r.result->'usage' IS NULL OR r.result->'usage'='null'::jsonb OR r.result->'estimated_usd' IS NULL OR r.result->'estimated_usd'='null'::jsonb THEN PERFORM ax_error('unknown_paid_usage'); END IF;
      IF jsonb_typeof(r.result->'estimated_usd')<>'number' OR (r.result->>'estimated_usd')::numeric<0 THEN PERFORM ax_error('invalid_paid_usage'); END IF;
      cost:=(r.result->>'estimated_usd')::numeric; total:=total+cost;
      IF adapter='antigravity' AND r.result->>'status'<>'succeeded' THEN
        IF r.fingerprint=signature THEN PERFORM ax_error('failed_request_already_attempted'); END IF;
        IF r.failure_review IS NULL OR jsonb_typeof(r.failure_review->'note') IS DISTINCT FROM 'string' OR
          (r.failure_review->>'note') !~ '[^[:space:]]' OR octet_length(r.failure_review->>'note')>2048 THEN PERFORM ax_error('paid_failure_requires_review'); END IF;
      END IF;
    END IF;
  END LOOP;
  IF adapter='antigravity' AND total>=0.01 THEN PERFORM ax_error('pilot_estimate_limit_reached'); END IF;
  RETURN total;
END $$;

CREATE FUNCTION ax_authorize(owner uuid, run text) RETURNS ax_runs LANGUAGE plpgsql STABLE AS $$
DECLARE r ax_runs; c ax_conversations;
BEGIN
  SELECT * INTO r FROM ax_runs WHERE run_id=run AND owner_user_id=owner;
  IF NOT FOUND OR owner IS NULL THEN PERFORM ax_error('run_not_found'); END IF;
  IF r.conversation_id IS NOT NULL THEN
    SELECT * INTO c FROM ax_conversations WHERE id=r.conversation_id;
    IF c.owner_user_id IS DISTINCT FROM owner OR c.invalid OR EXISTS(SELECT 1 FROM ax_runs WHERE conversation_id=c.id AND owner_user_id IS DISTINCT FROM owner) THEN PERFORM ax_error('invalid_conversation_state'); END IF;
  END IF;
  IF r.invalid THEN PERFORM ax_error('invalid_run_ledger'); END IF;
  RETURN r;
END $$;

CREATE FUNCTION ax_accept(owner uuid, kind text, cid uuid, payload jsonb, image text, proposed_run text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<admission>>
DECLARE c ax_conversations; req jsonb; body jsonb; key_hash text; payload_hash text; signature text; total numeric;
  prior ax_submissions; actor text:='user:'||owner::text; parent text; stamp text; seq integer;
BEGIN
  IF owner IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=owner AND status='active') THEN PERFORM ax_error('invalid_owner_user_id'); END IF;
  IF kind NOT IN ('run','chat') OR payload IS NULL OR jsonb_typeof(payload)<>'object' OR image !~ '^localhost:5001/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$' OR proposed_run !~ '^ax-run-[0-9a-f]{16}$' THEN PERFORM ax_error('invalid_request'); END IF;
  BEGIN key_hash:=encode(sha256(convert_to(ax_json(jsonb_build_array(owner::text,(payload->>'key')::uuid::text),true),'UTF8')),'hex');
  EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
  IF payload->>'key' IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
  body:=payload-'key';
  IF kind='chat' THEN
    IF cid IS NULL OR NOT payload ?& ARRAY['key','parent_run_id','text','allow_model'] OR (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR payload->'allow_model' IS DISTINCT FROM 'true'::jsonb THEN PERFORM ax_error('invalid_request'); END IF;
    body:=body||jsonb_build_object('id',cid::text);
    SELECT * INTO c FROM ax_conversations WHERE id=cid;
    IF FOUND AND c.owner_user_id IS DISTINCT FROM owner THEN PERFORM ax_error('conversation_not_found'); END IF;
    IF c.invalid THEN PERFORM ax_error('invalid_conversation_state'); END IF;
  ELSIF cid IS NOT NULL OR NOT payload ?& ARRAY['key','mode','instruction','input_text','output_name','allow_model'] OR (SELECT count(*) FROM jsonb_object_keys(payload))<>6 OR
    coalesce(payload->>'mode','') NOT IN ('offline','model') OR jsonb_typeof(payload->'allow_model') IS DISTINCT FROM 'boolean' OR jsonb_typeof(payload->'input_text') IS DISTINCT FROM 'string' OR
    (payload->>'mode'='model' AND payload->'allow_model'<>'true'::jsonb) THEN PERFORM ax_error('invalid_request'); END IF;
  payload_hash:=encode(sha256(convert_to(ax_json(body,kind='chat'),'UTF8')),'hex');
  SELECT * INTO prior FROM ax_submissions s WHERE s.actor_id=actor AND s.key_hash=admission.key_hash;
  IF FOUND THEN
    IF prior.payload_hash<>admission.payload_hash THEN PERFORM ax_error('idempotency_conflict'); END IF;
    PERFORM ax_authorize(owner,prior.run_id);
    RETURN jsonb_build_object('run_id',prior.run_id,'replayed',true);
  END IF;
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  SELECT * INTO prior FROM ax_submissions s WHERE s.actor_id=actor AND s.key_hash=admission.key_hash;
  IF FOUND THEN
    IF prior.payload_hash<>admission.payload_hash THEN PERFORM ax_error('idempotency_conflict'); END IF;
    PERFORM ax_authorize(owner,prior.run_id);
    RETURN jsonb_build_object('run_id',prior.run_id,'replayed',true);
  END IF;
  IF NOT (SELECT accepting FROM ax_control WHERE id) THEN PERFORM ax_error('admission_closed'); END IF;
  IF kind='chat' THEN
    SELECT * INTO c FROM ax_conversations WHERE id=cid FOR UPDATE;
    IF FOUND AND c.owner_user_id IS DISTINCT FROM owner THEN PERFORM ax_error('conversation_not_found'); END IF;
    IF c.invalid THEN PERFORM ax_error('invalid_conversation_state'); END IF;
    parent:=payload->>'parent_run_id';
    IF parent IS DISTINCT FROM c.head_run_id THEN PERFORM ax_error('conversation_conflict'); END IF;
    IF EXISTS(SELECT 1 FROM ax_runs WHERE conversation_id=cid AND NOT resolved) THEN PERFORM ax_error('conversation_busy'); END IF;
    IF coalesce(c.turn_count,0)>=32 OR octet_length(coalesce(c.context_bytes,convert_to('[]','UTF8')))>4096 THEN PERFORM ax_error('conversation_context_full'); END IF;
    seq:=coalesce(c.turn_count,0)+1;
    req:=jsonb_build_object('schema_version',1,'run_id',proposed_run,'adapter','antigravity','instruction',payload->'text','inputs',jsonb_build_object('conversation.json',convert_from(coalesce(c.context_bytes,convert_to('[]','UTF8')),'UTF8')),'output_name','reply.txt');
  ELSE req:=jsonb_build_object('schema_version',1,'run_id',proposed_run,'adapter',CASE WHEN payload->>'mode'='offline' THEN 'offline' ELSE 'antigravity' END,'instruction',payload->'instruction','inputs',CASE WHEN payload->>'input_text'='' THEN '{}'::jsonb ELSE jsonb_build_object('input.txt',payload->'input_text') END,'output_name',payload->'output_name'); END IF;
  PERFORM ax_validate_request(req);
  signature:=encode(sha256(convert_to(ax_json((req-'run_id')||jsonb_build_object('image',image)),'UTF8')),'hex');
  total:=ax_guard(req->>'adapter',signature);
  stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  IF kind='chat' THEN INSERT INTO ax_conversations(id,owner_user_id) VALUES(cid,owner) ON CONFLICT DO NOTHING; END IF;
  INSERT INTO ax_runs(run_id,owner_user_id,actor_id,conversation_id,sequence,parent_run_id,request_data,request_bytes,request_hash,image,manifest,fingerprint,accepted_at,phase,known_estimated_usd_before)
    VALUES(proposed_run,owner,actor,cid,seq,parent,req,convert_to(ax_json(req,true),'UTF8'),encode(sha256(convert_to(ax_json(req,true),'UTF8')),'hex'),image,ax_manifest(proposed_run,image),signature,stamp,'accepted',total);
  INSERT INTO ax_submissions VALUES(actor,key_hash,payload_hash,proposed_run);
  INSERT INTO ax_jobs(run_id,kind,state) VALUES(proposed_run,'execute','ready');
  UPDATE ax_execution_slot SET run_id=proposed_run,hold_reason='unresolved_run' WHERE id;
  IF kind='chat' THEN UPDATE ax_conversations SET head_run_id=proposed_run,turn_count=seq WHERE id=cid; END IF;
  RETURN jsonb_build_object('run_id',proposed_run,'replayed',false);
END $$;

CREATE FUNCTION ax_snapshot(r ax_runs, with_artifact boolean DEFAULT true) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('run_id',r.run_id,'owner_user_id',r.owner_user_id,'conversation_id',r.conversation_id,'sequence',r.sequence,'parent_run_id',r.parent_run_id,
   'request',r.request_data,'request_hash',r.request_hash,'request_hex',encode(r.request_bytes,'hex'),'image',r.image,'manifest',r.manifest,'fingerprint',r.fingerprint,
   'accepted_at',r.accepted_at,'phase',r.phase,'outcome',r.outcome,'resolved',r.resolved,'error_type',r.error_type,'result',r.result,
   'cleanup',r.cleanup,'cleanup_errors',r.cleanup_errors,'invalid',r.invalid,
   'active',NOT r.resolved AND EXISTS(SELECT 1 FROM ax_jobs j WHERE j.run_id=r.run_id AND j.state='claimed' AND j.lease_until>statement_timestamp()),
   'artifact_hex',CASE WHEN with_artifact THEN (SELECT encode(content,'hex') FROM ax_artifacts WHERE run_id=r.run_id) ELSE NULL END)
$$;

CREATE FUNCTION ax_read_run(owner uuid, run text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs;
BEGIN r:=ax_authorize(owner,run); RETURN ax_snapshot(r); END $$;

CREATE FUNCTION ax_list_runs(owner uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; rows jsonb:='[]';
BEGIN
  IF owner IS NULL THEN PERFORM ax_error('invalid_owner_user_id'); END IF;
  FOR r IN SELECT * FROM ax_runs WHERE owner_user_id=owner ORDER BY sort_at DESC,run_id DESC LIMIT 50 LOOP
    PERFORM ax_authorize(owner,r.run_id);
    rows:=rows||jsonb_build_array(ax_snapshot(r,false));
  END LOOP;
  RETURN rows;
END $$;

CREATE FUNCTION ax_read_conversation(owner uuid, cid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c ax_conversations; rows jsonb;
BEGIN
  SELECT * INTO c FROM ax_conversations WHERE id=cid AND owner_user_id=owner;
  IF NOT FOUND OR owner IS NULL THEN PERFORM ax_error('conversation_not_found'); END IF;
  IF c.invalid OR EXISTS(SELECT 1 FROM ax_runs WHERE conversation_id=cid AND (owner_user_id IS DISTINCT FROM owner OR invalid)) THEN PERFORM ax_error('invalid_conversation_state'); END IF;
  SELECT coalesce(jsonb_agg(ax_snapshot(r,r.resolved AND r.outcome='succeeded') ORDER BY r.sequence),'[]') INTO rows FROM ax_runs r WHERE conversation_id=cid;
  RETURN jsonb_build_object('id',cid,'head_run_id',c.head_run_id,'turn_count',c.turn_count,'context_hex',encode(c.context_bytes,'hex'),'runs',rows);
END $$;

CREATE FUNCTION ax_list_conversations(owner uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cid uuid; rows jsonb:='[]';
BEGIN
  IF owner IS NULL THEN PERFORM ax_error('invalid_owner_user_id'); END IF;
  FOR cid IN SELECT c.id FROM ax_conversations c JOIN ax_runs r ON r.run_id=c.head_run_id WHERE c.owner_user_id=owner ORDER BY r.sort_at DESC,c.id DESC LIMIT 50 LOOP
    rows:=rows||jsonb_build_array(ax_read_conversation(owner,cid));
  END LOOP;
  RETURN rows;
END $$;

CREATE FUNCTION ax_review_failure(run text, note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; body bytea;
BEGIN
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  SELECT * INTO r FROM ax_runs WHERE run_id=run FOR UPDATE;
  IF NOT FOUND THEN PERFORM ax_error('run_not_found'); END IF;
  IF note IS NULL OR note !~ '[^[:space:]]' OR octet_length(note)>2048 THEN PERFORM ax_error('invalid_review_note'); END IF;
  IF NOT r.resolved OR r.cleanup<>'{"egress_denied":true,"suspended":true}'::jsonb OR r.cleanup_errors<>'[]'::jsonb OR r.result IS NULL OR r.result->'usage'='null'::jsonb OR r.result->'estimated_usd'='null'::jsonb THEN PERFORM ax_error('failure_review_unresolved'); END IF;
  IF r.request_data->>'adapter'<>'antigravity' OR NOT r.start_attempted OR r.result->>'status'='succeeded' THEN PERFORM ax_error('not_failed_paid_run'); END IF;
  SELECT content INTO body FROM ax_artifacts WHERE run_id=run;
  PERFORM ax_validate_result(r.result,run,'antigravity',r.request_data->>'output_name',body);
  IF r.failure_review IS NOT NULL THEN
    IF r.failure_review->>'note' IS DISTINCT FROM note THEN PERFORM ax_error('failure_already_reviewed'); END IF;
    RETURN;
  END IF;
  UPDATE ax_runs SET failure_review=jsonb_build_object('note',note,'recorded_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) WHERE run_id=run;
END $$;

CREATE FUNCTION ax_import_run(meta jsonb, receipt_bytes bytea, request_bytes bytea, result_bytes bytea, manifest_bytes bytea, artifact_bytes bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE receipt jsonb; req jsonb; manifest jsonb; source text; run text; owner uuid; cid uuid; bad boolean; prior ax_imports;
  actor text; link jsonb; signature text; result jsonb; artifact_ok boolean:=false;
BEGIN
  PERFORM 1 FROM ax_control WHERE id FOR UPDATE;
  IF (SELECT accepting FROM ax_control WHERE id) OR EXISTS(SELECT 1 FROM ax_runs WHERE NOT legacy) THEN PERFORM ax_error('import_closed'); END IF;
  receipt:=convert_from(receipt_bytes,'UTF8')::jsonb; req:=convert_from(request_bytes,'UTF8')::jsonb; manifest:=convert_from(manifest_bytes,'UTF8')::jsonb;
  run:=receipt->>'run_id'; owner:=(receipt->>'owner_user_id')::uuid; link:=receipt->'conversation'; cid:=(link->>'id')::uuid;
  source:=encode(sha256(convert_to(ax_json(jsonb_build_array(encode(receipt_bytes,'hex'),encode(request_bytes,'hex'),encode(result_bytes,'hex'),encode(manifest_bytes,'hex'),encode(artifact_bytes,'hex')),true),'UTF8')),'hex');
  SELECT * INTO prior FROM ax_imports WHERE run_id=run;
  IF FOUND THEN
    IF prior.source_hash<>source THEN PERFORM ax_error('import_conflict'); END IF;
    RETURN jsonb_build_object('run_id',run,'replayed',true,'source_hash',source,'invalid',(SELECT invalid FROM ax_runs WHERE run_id=run));
  END IF;
  IF run IS NULL OR run !~ '^ax-run-[0-9a-f]{16}$' OR req->>'run_id' IS DISTINCT FROM run OR jsonb_typeof(receipt->'resolved') IS DISTINCT FROM 'boolean' OR jsonb_typeof(receipt->'start_attempted') IS DISTINCT FROM 'boolean' THEN PERFORM ax_error('invalid_run_ledger'); END IF;
  actor:=CASE WHEN owner IS NULL THEN 'legacy:ownerless' ELSE 'user:'||owner::text END;
  result:=nullif(receipt->'result','null'::jsonb);
  bad:=coalesce((meta->>'invalid')::boolean,false);
  BEGIN
    PERFORM ax_validate_request(req);
    signature:=encode(sha256(convert_to(ax_json((req-'run_id')||jsonb_build_object('image',receipt->>'image')),'UTF8')),'hex');
    IF receipt->>'adapter' IS DISTINCT FROM req->>'adapter' OR signature IS DISTINCT FROM receipt->>'fingerprint' OR manifest<>ax_manifest(run,receipt->>'image') THEN bad:=true; END IF;
    IF result_bytes IS NOT NULL AND convert_from(result_bytes,'UTF8')::jsonb IS DISTINCT FROM result THEN bad:=true; END IF;
    IF result IS NOT NULL THEN
      PERFORM ax_validate_result(result,run,req->>'adapter',req->>'output_name',artifact_bytes);
      artifact_ok:=artifact_bytes IS NOT NULL;
    ELSIF artifact_bytes IS NOT NULL OR result_bytes IS NOT NULL THEN bad:=true; END IF;
    IF (receipt->>'resolved')::boolean AND receipt->>'outcome' NOT IN ('dry_run','not_started') AND
      (receipt->'cleanup' IS DISTINCT FROM '{"egress_denied":true,"suspended":true}'::jsonb OR receipt->'cleanup_errors' IS DISTINCT FROM '[]'::jsonb) THEN bad:=true; END IF;
  EXCEPTION WHEN OTHERS THEN bad:=true;
  END;
  IF cid IS NOT NULL THEN
    INSERT INTO ax_conversations(id,owner_user_id) VALUES(cid,owner) ON CONFLICT DO NOTHING;
    IF EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid AND owner_user_id IS DISTINCT FROM owner) THEN
      bad:=true; UPDATE ax_conversations SET invalid=true WHERE id=cid;
    END IF;
  END IF;
  INSERT INTO ax_runs(run_id,owner_user_id,actor_id,legacy,conversation_id,sequence,parent_run_id,request_data,request_bytes,request_hash,image,manifest,fingerprint,accepted_at,sort_at,phase,outcome,resolved,apply_attempted,start_attempted,result,cleanup,cleanup_errors,error_type,known_estimated_usd_before,failure_review,invalid)
  VALUES(run,owner,actor,true,cid,(link->>'sequence')::integer,link->>'parent_run_id',req,request_bytes,encode(sha256(request_bytes),'hex'),receipt->>'image',manifest,receipt->>'fingerprint',receipt->'submission'->>'accepted_at',(meta->>'sort_at')::timestamptz,
    receipt->>'phase',receipt->>'outcome',(receipt->>'resolved')::boolean,coalesce((receipt->>'apply_attempted')::boolean,false),(receipt->>'start_attempted')::boolean,result,coalesce(receipt->'cleanup','{}'),coalesce(receipt->'cleanup_errors','[]'),receipt->>'error_type',coalesce((receipt->>'known_estimated_usd_before')::numeric,0),receipt->'failure_review',bad);
  IF receipt->'submission' IS NOT NULL AND receipt->'submission'<>'null'::jsonb THEN
    INSERT INTO ax_submissions VALUES(actor,receipt->'submission'->>'key_hash',receipt->'submission'->>'payload_hash',run);
  END IF;
  IF artifact_ok THEN INSERT INTO ax_artifacts VALUES(run,result->'artifact'->>'name',artifact_bytes,encode(sha256(artifact_bytes),'hex')); END IF;
  INSERT INTO ax_imports(run_id,source_hash,receipt_bytes,request_bytes,result_bytes,manifest_bytes,artifact_bytes) VALUES(run,source,receipt_bytes,request_bytes,result_bytes,manifest_bytes,artifact_bytes);
  IF NOT (receipt->>'resolved')::boolean THEN
    INSERT INTO ax_jobs(run_id,kind,state) VALUES(run,'recovery','held');
    UPDATE ax_execution_slot SET hold_reason='imported_unresolved' WHERE id;
  END IF;
  RETURN jsonb_build_object('run_id',run,'replayed',false,'source_hash',source,'invalid',bad);
END $$;

CREATE FUNCTION ax_complete_import() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c ax_conversations; r ax_runs; context bytea; parent text; seq integer; bad boolean; body bytea;
BEGIN
  PERFORM 1 FROM ax_control WHERE id FOR UPDATE;
  IF (SELECT accepting FROM ax_control WHERE id) OR EXISTS(SELECT 1 FROM ax_runs WHERE NOT legacy) THEN PERFORM ax_error('import_closed'); END IF;
  FOR c IN SELECT * FROM ax_conversations FOR UPDATE LOOP
    context:=convert_to('[]','UTF8'); parent:=NULL; seq:=0; bad:=c.invalid;
    FOR r IN SELECT * FROM ax_runs WHERE conversation_id=c.id ORDER BY sequence LOOP
      seq:=seq+1;
      IF r.invalid OR r.owner_user_id IS DISTINCT FROM c.owner_user_id OR r.sequence<>seq OR r.parent_run_id IS DISTINCT FROM parent OR r.request_data->>'adapter'<>'antigravity' OR r.request_data->>'output_name'<>'reply.txt' OR
        r.request_data->'inputs'<>jsonb_build_object('conversation.json',convert_from(context,'UTF8')) OR r.accepted_at IS NULL OR r.accepted_at !~ 'Z$' OR octet_length(context)>4096 OR
        (parent IS NOT NULL AND NOT (SELECT resolved FROM ax_runs WHERE run_id=parent)) THEN bad:=true; END IF;
      IF r.resolved AND r.outcome='succeeded' THEN
        SELECT content INTO body FROM ax_artifacts WHERE run_id=r.run_id;
        IF body IS NULL OR r.result->>'status' IS DISTINCT FROM 'succeeded' OR r.cleanup<>'{"egress_denied":true,"suspended":true}'::jsonb OR r.cleanup_errors<>'[]'::jsonb THEN bad:=true;
        ELSE
          context:=substring(context FROM 1 FOR octet_length(context)-1)||convert_to(CASE WHEN context=convert_to('[]','UTF8') THEN '' ELSE ',' END||'{"role":"user","content":'||to_json(r.request_data->>'instruction')::text||'},{"role":"assistant","content":'||ax_quote_bytes(body)||'}]','UTF8');
        END IF;
      END IF;
      parent:=r.run_id;
    END LOOP;
    UPDATE ax_conversations SET head_run_id=parent,turn_count=seq,context_bytes=context,invalid=bad WHERE id=c.id;
    IF bad THEN UPDATE ax_runs SET invalid=true WHERE conversation_id=c.id; END IF;
  END LOOP;
  RETURN jsonb_build_object('runs',(SELECT count(*) FROM ax_runs),'conversations',(SELECT count(*) FROM ax_conversations),'invalid',(SELECT count(*) FROM ax_runs WHERE invalid),'unresolved',(SELECT count(*) FROM ax_runs WHERE NOT resolved));
END $$;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
END $$;
