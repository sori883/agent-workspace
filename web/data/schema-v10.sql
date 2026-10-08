SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);

CREATE TABLE ax_skill_storage_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), physical_limit_bytes bigint NOT NULL CHECK(physical_limit_bytes BETWEEN 163840 AND 1099511627776)
);
INSERT INTO ax_skill_storage_control VALUES(true,268435456);
CREATE TABLE ax_skill_save_requests (
 owner_user_id uuid NOT NULL REFERENCES users(id), request_key uuid NOT NULL, workspace_id uuid NOT NULL REFERENCES org_workspaces(id),
 definition_id uuid NOT NULL, revision_id uuid NOT NULL UNIQUE, operation text NOT NULL CHECK(operation IN ('create','update')),
 request_hash text NOT NULL, metadata jsonb NOT NULL, lease_token uuid NOT NULL, generation integer NOT NULL DEFAULT 1,
 reserved_bytes integer NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 163840), logical_delta integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committed')), result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_user_id,request_key),
 CHECK((state='pending' AND result IS NULL) OR (state='committed' AND result IS NOT NULL))
);
CREATE TABLE ax_skill_revisions (
 id uuid PRIMARY KEY, definition_id uuid NOT NULL REFERENCES ax_definitions(id), source jsonb NOT NULL,
 metadata jsonb NOT NULL, content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 131072), total_bytes integer NOT NULL CHECK(total_bytes BETWEEN 1 AND 163840),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER ax_skill_revision_immutable BEFORE UPDATE OR DELETE ON ax_skill_revisions FOR EACH ROW EXECUTE FUNCTION ax_definition_immutable();

CREATE FUNCTION ax_skill_metadata(value jsonb,creating boolean) RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE f jsonb; p text; bytes integer:=0;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value ?& ARRAY['key','name','description','files','content_sha256','content_bytes','file_bytes','store_id']
  OR value - ARRAY['key','name','description','files','content_sha256','content_bytes','file_bytes','store_id',CASE WHEN creating THEN 'visibility' ELSE 'expected_revision' END]<>'{}'::jsonb
  OR (SELECT count(*) FROM jsonb_object_keys(value))<>9 THEN PERFORM ax_error('invalid_request'); END IF;
 IF jsonb_typeof(value->'name') IS DISTINCT FROM 'string' OR value->>'name' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(value->>'name')>64
  OR jsonb_typeof(value->'description') IS DISTINCT FROM 'string' OR octet_length(value->>'description')>1024
  OR value->>'content_sha256' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(value->'content_sha256') IS DISTINCT FROM 'string'
  OR value->>'store_id' !~ '^[a-z0-9][a-z0-9-]{0,63}$' OR jsonb_typeof(value->'store_id') IS DISTINCT FROM 'string'
  OR jsonb_typeof(value->'content_bytes') IS DISTINCT FROM 'number' OR value->>'content_bytes' !~ '^[0-9]{1,6}$' OR (value->>'content_bytes')::integer NOT BETWEEN 1 AND 131072
  OR jsonb_typeof(value->'file_bytes') IS DISTINCT FROM 'number' OR value->>'file_bytes' !~ '^[0-9]{1,6}$' OR (value->>'file_bytes')::integer NOT BETWEEN 1 AND 147456
  OR jsonb_typeof(value->'files') IS DISTINCT FROM 'array' THEN PERFORM ax_error('invalid_request'); END IF;
 IF creating THEN
  IF jsonb_typeof(value->'visibility') IS DISTINCT FROM 'string' OR value->>'visibility' NOT IN ('personal','workspace') THEN PERFORM ax_error('invalid_request'); END IF;
 ELSE
  IF jsonb_typeof(value->'expected_revision') IS DISTINCT FROM 'number' OR value->>'expected_revision' !~ '^[0-9]{1,10}$' OR (value->>'expected_revision')::numeric NOT BETWEEN 1 AND 2147483647 THEN PERFORM ax_error('invalid_request'); END IF;
 END IF;
 IF jsonb_array_length(value->'files') NOT BETWEEN 1 AND 17 OR value->'files'->0->>'path' IS DISTINCT FROM 'SKILL.md' THEN PERFORM ax_error('invalid_request'); END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(value->'files') LOOP
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT f ?& ARRAY['path','size_bytes','media_type','sha256'] OR (SELECT count(*) FROM jsonb_object_keys(f))<>4
   OR jsonb_typeof(f->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'size_bytes') IS DISTINCT FROM 'number' OR f->>'size_bytes' !~ '^[0-9]{1,5}$'
   OR (f->>'size_bytes')::integer NOT BETWEEN 0 AND 32768 OR f->>'media_type' IS DISTINCT FROM 'text/plain; charset=utf-8'
   OR jsonb_typeof(f->'sha256') IS DISTINCT FROM 'string' OR f->>'sha256' !~ '^[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
  p:=f->>'path';
  IF char_length(p)>255 OR (p<>'SKILL.md' AND p !~ '^(references|scripts|assets)/([A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$') THEN PERFORM ax_error('invalid_request'); END IF;
  bytes:=bytes+(f->>'size_bytes')::integer;
 END LOOP;
 IF bytes<>(value->>'file_bytes')::integer OR (SELECT count(DISTINCT entry->>'path') FROM jsonb_array_elements(value->'files') entry)<>jsonb_array_length(value->'files') THEN PERFORM ax_error('invalid_request'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(value->'files') AS parent_paths(parent_file) CROSS JOIN jsonb_array_elements(value->'files') AS child_paths(child_file) WHERE starts_with(child_file->>'path',(parent_file->>'path')||'/')) THEN PERFORM ax_error('invalid_request'); END IF;
END $$;

CREATE FUNCTION ax_skill_save_begin(owner uuid,wid uuid,did uuid,payload jsonb,proposed uuid,revision uuid,lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE d ax_definitions; r ax_skill_save_requests; mutation_key uuid; digest text; delta integer; reserve integer; op text:=CASE WHEN did IS NULL THEN 'create' ELSE 'update' END;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 PERFORM ax_skill_metadata(payload,did IS NULL);
 BEGIN mutation_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 IF mutation_key IS NULL OR proposed IS NULL OR revision IS NULL OR lease IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(convert_to(ax_definition_canonical(jsonb_build_object('workspace_id',wid,'operation',op,'id',did,'payload',payload)),'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(926019,1);
 IF EXISTS(SELECT 1 FROM ax_definition_mutations WHERE owner_user_id=owner AND request_key=mutation_key) THEN PERFORM ax_error('idempotency_conflict'); END IF;
 SELECT * INTO r FROM ax_skill_save_requests WHERE owner_user_id=owner AND request_key=mutation_key FOR UPDATE;
 IF FOUND THEN
  IF r.request_hash<>digest THEN PERFORM ax_error('idempotency_conflict'); END IF;
  IF r.operation='update' OR r.state='committed' THEN PERFORM ax_definition_access(owner,wid,r.definition_id,true); END IF;
  IF r.state='committed' THEN RETURN jsonb_build_object('definition_id',r.definition_id,'revision_id',r.revision_id,'lease_token',r.lease_token,'generation',r.generation,'result',r.result||'{"replayed":true}'::jsonb); END IF;
 END IF;
 IF did IS NULL THEN
  IF (SELECT count(*) FROM ax_definitions WHERE workspace_id=wid AND created_by_user_id=owner)+(SELECT count(*) FROM ax_skill_save_requests WHERE workspace_id=wid AND owner_user_id=owner AND operation='create' AND state='pending' AND request_key<>mutation_key)>=100 THEN PERFORM ax_error('definition_count_limit'); END IF;
  delta:=(payload->>'content_bytes')::integer;
 ELSE
  d:=ax_definition_access(owner,wid,did,true);
  SELECT * INTO d FROM ax_definitions WHERE id=did FOR UPDATE;
  IF d.kind<>'skill' THEN PERFORM ax_error('invalid_request'); END IF;
  IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
  IF d.revision<>(payload->>'expected_revision')::integer THEN PERFORM ax_error('definition_revision_conflict'); END IF;
  delta:=greatest(0,(payload->>'content_bytes')::integer-d.draft_bytes);
 END IF;
 IF r.request_key IS NOT NULL THEN
  UPDATE ax_skill_save_requests SET lease_token=lease,generation=generation+1 WHERE owner_user_id=owner AND request_key=mutation_key RETURNING * INTO r;
 ELSE
  reserve:=(payload->>'file_bytes')::integer+16384;
  IF coalesce((SELECT sum(total_bytes) FROM ax_skill_revisions),0)+coalesce((SELECT sum(reserved_bytes) FROM ax_skill_save_requests WHERE state='pending'),0)+reserve>(SELECT physical_limit_bytes FROM ax_skill_storage_control WHERE singleton) THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
  IF coalesce((SELECT sum(draft_bytes) FROM ax_definitions),0)+coalesce((SELECT sum(content_bytes) FROM ax_definition_versions),0)+coalesce((SELECT sum(logical_delta) FROM ax_skill_save_requests WHERE state='pending'),0)+delta>134217728 THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
  INSERT INTO ax_skill_save_requests(owner_user_id,request_key,workspace_id,definition_id,revision_id,operation,request_hash,metadata,lease_token,reserved_bytes,logical_delta)
   VALUES(owner,mutation_key,wid,coalesce(did,proposed),revision,op,digest,payload,lease,reserve,delta) RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('definition_id',r.definition_id,'revision_id',r.revision_id,'lease_token',r.lease_token,'generation',r.generation,'result',NULL);
END $$;

CREATE FUNCTION ax_skill_save_commit(owner uuid,wid uuid,mutation_key uuid,lease uuid,gen integer,source_value jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_skill_save_requests; d ax_definitions; stored jsonb; prefix text; actual integer; delta integer; result_value jsonb;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 PERFORM pg_advisory_xact_lock(926019,1);
 SELECT * INTO r FROM ax_skill_save_requests WHERE owner_user_id=owner AND request_key=mutation_key AND workspace_id=wid FOR UPDATE;
 IF NOT FOUND THEN PERFORM ax_error('invalid_request'); END IF;
 IF r.operation='update' OR r.state='committed' THEN PERFORM ax_definition_access(owner,wid,r.definition_id,true); END IF;
 IF r.state='committed' THEN
  IF NOT EXISTS(SELECT 1 FROM ax_skill_revisions WHERE id=r.revision_id AND source=source_value) THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN r.result||'{"replayed":true}'::jsonb;
 END IF;
 IF r.lease_token IS DISTINCT FROM lease OR r.generation IS DISTINCT FROM gen THEN PERFORM ax_error('skill_save_superseded'); END IF;
 prefix:='workspaces/'||wid||'/skills/'||r.definition_id||'/revisions/'||r.revision_id||'/';
 IF jsonb_typeof(source_value) IS DISTINCT FROM 'object' OR NOT source_value ?& ARRAY['type','store_id','revision_id','manifest_key','manifest_sha256','manifest_bytes','total_bytes'] OR (SELECT count(*) FROM jsonb_object_keys(source_value))<>7
  OR source_value->>'type' IS DISTINCT FROM 'skill-object-v1' OR source_value->>'store_id' IS DISTINCT FROM r.metadata->>'store_id'
  OR source_value->>'revision_id' IS DISTINCT FROM r.revision_id::text OR source_value->>'manifest_key' IS DISTINCT FROM prefix||'manifest.json'
  OR jsonb_typeof(source_value->'manifest_sha256') IS DISTINCT FROM 'string' OR source_value->>'manifest_sha256' !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(source_value->'manifest_bytes') IS DISTINCT FROM 'number' OR source_value->>'manifest_bytes' !~ '^[0-9]{1,5}$' OR (source_value->>'manifest_bytes')::integer NOT BETWEEN 1 AND 16384
  OR jsonb_typeof(source_value->'total_bytes') IS DISTINCT FROM 'number' OR source_value->>'total_bytes' !~ '^[0-9]{1,6}$' THEN PERFORM ax_error('invalid_request'); END IF;
 actual:=(source_value->>'total_bytes')::integer;
 IF actual<>(r.metadata->>'file_bytes')::integer+(source_value->>'manifest_bytes')::integer OR actual>r.reserved_bytes THEN PERFORM ax_error('invalid_request'); END IF;
 stored:=jsonb_build_object('name',r.metadata->>'name','description',r.metadata->>'description','files',r.metadata->'files','content_sha256',r.metadata->>'content_sha256','source',source_value);
 IF r.operation='create' THEN
  IF (SELECT count(*) FROM ax_definitions WHERE workspace_id=wid AND created_by_user_id=owner)>=100 THEN PERFORM ax_error('definition_count_limit'); END IF;
  delta:=(r.metadata->>'content_bytes')::integer;
 ELSE
  SELECT * INTO d FROM ax_definitions WHERE id=r.definition_id FOR UPDATE;
  IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
  IF d.revision<>(r.metadata->>'expected_revision')::integer THEN PERFORM ax_error('definition_revision_conflict'); END IF;
  delta:=(r.metadata->>'content_bytes')::integer-d.draft_bytes;
 END IF;
 IF coalesce((SELECT sum(draft_bytes) FROM ax_definitions),0)+coalesce((SELECT sum(content_bytes) FROM ax_definition_versions),0)+delta+coalesce((SELECT sum(logical_delta) FROM ax_skill_save_requests WHERE state='pending' AND (owner_user_id,request_key)<>(owner,mutation_key)),0)>134217728 THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
 IF coalesce((SELECT sum(total_bytes) FROM ax_skill_revisions),0)+coalesce((SELECT sum(reserved_bytes) FROM ax_skill_save_requests WHERE state='pending' AND (owner_user_id,request_key)<>(owner,mutation_key)),0)+actual>(SELECT physical_limit_bytes FROM ax_skill_storage_control WHERE singleton) THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
 IF r.operation='create' THEN
  INSERT INTO ax_definitions(id,workspace_id,created_by_user_id,kind,visibility,draft,draft_bytes) VALUES(r.definition_id,wid,owner,'skill',r.metadata->>'visibility',stored,(r.metadata->>'content_bytes')::integer) RETURNING * INTO d;
 ELSE
  UPDATE ax_definitions SET draft=stored,draft_bytes=(r.metadata->>'content_bytes')::integer,revision=revision+1 WHERE id=r.definition_id RETURNING * INTO d;
 END IF;
 INSERT INTO ax_skill_revisions(id,definition_id,source,metadata,content_sha256,content_bytes,total_bytes) VALUES(r.revision_id,d.id,source_value,r.metadata-ARRAY['key','expected_revision','visibility','store_id'],r.metadata->>'content_sha256',(r.metadata->>'content_bytes')::integer,actual);
 result_value:=jsonb_build_object('definition',ax_definition_summary(owner,d),'version',NULL,'replayed',false);
 UPDATE ax_skill_save_requests SET state='committed',reserved_bytes=actual,result=result_value WHERE owner_user_id=owner AND request_key=mutation_key;
 RETURN result_value;
END $$;

ALTER FUNCTION ax_definition_mutate(uuid,uuid,text,uuid,jsonb,uuid) RENAME TO ax_definition_mutate_inline;
CREATE FUNCTION ax_definition_mutate(owner uuid,wid uuid,operation text,did uuid,payload jsonb,proposed uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d ax_definitions; v ax_definition_versions; prior ax_definition_mutations; mutation_key uuid; digest text; n integer; result_value jsonb;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 BEGIN mutation_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 PERFORM pg_advisory_xact_lock(926019,1);
 IF EXISTS(SELECT 1 FROM ax_skill_save_requests WHERE owner_user_id=owner AND request_key=mutation_key) THEN PERFORM ax_error('idempotency_conflict'); END IF;
 IF did IS NOT NULL THEN d:=ax_definition_access(owner,wid,did,true); END IF;
 IF operation='update' AND d.draft ? 'source' THEN PERFORM ax_error('skill_storage_required'); END IF;
 IF operation<>'publish' OR NOT coalesce(d.draft ? 'source',false) THEN
  result_value:=ax_definition_mutate_inline(owner,wid,operation,did,payload,proposed);
  IF operation<>'archive' AND coalesce((SELECT sum(draft_bytes) FROM ax_definitions),0)+coalesce((SELECT sum(content_bytes) FROM ax_definition_versions),0)+coalesce((SELECT sum(logical_delta) FROM ax_skill_save_requests WHERE state='pending'),0)>134217728 THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
  RETURN result_value;
 END IF;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['key','expected_revision'] OR (SELECT count(*) FROM jsonb_object_keys(payload))<>2
  OR mutation_key IS NULL OR proposed IS NULL OR jsonb_typeof(payload->'expected_revision') IS DISTINCT FROM 'number' OR payload->>'expected_revision' !~ '^[0-9]{1,10}$'
  OR (payload->>'expected_revision')::numeric NOT BETWEEN 1 AND 2147483647 THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(convert_to(ax_definition_canonical(jsonb_build_object('workspace_id',wid,'operation',operation,'id',did,'payload',payload)),'UTF8')),'hex');
 SELECT * INTO prior FROM ax_definition_mutations WHERE owner_user_id=owner AND request_key=mutation_key;
 IF FOUND THEN
  IF prior.request_hash<>digest THEN PERFORM ax_error('idempotency_conflict'); END IF;
  SELECT * INTO v FROM ax_definition_versions WHERE id=prior.version_id;
  RETURN jsonb_build_object('definition',prior.result_definition,'version',ax_definition_version_json(v),'replayed',true);
 END IF;
 SELECT * INTO d FROM ax_definitions WHERE id=did FOR UPDATE;
 IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
 IF d.revision<>(payload->>'expected_revision')::integer THEN PERFORM ax_error('definition_revision_conflict'); END IF;
 IF NOT EXISTS(SELECT 1 FROM ax_skill_revisions WHERE definition_id=did AND id=(d.draft->'source'->>'revision_id')::uuid AND source=d.draft->'source' AND content_sha256=d.draft->>'content_sha256') THEN PERFORM ax_error('skill_storage_integrity'); END IF;
 SELECT coalesce(max(version),0)+1 INTO n FROM ax_definition_versions WHERE definition_id=did;
 IF n>100 THEN PERFORM ax_error('definition_version_limit'); END IF;
 IF coalesce((SELECT sum(draft_bytes) FROM ax_definitions),0)+coalesce((SELECT sum(content_bytes) FROM ax_definition_versions),0)+coalesce((SELECT sum(logical_delta) FROM ax_skill_save_requests WHERE state='pending'),0)+d.draft_bytes>134217728 THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
 INSERT INTO ax_definition_versions(id,definition_id,version,content,content_bytes,sha256,published_by_user_id) VALUES(proposed,did,n,d.draft,d.draft_bytes,d.draft->>'content_sha256',owner) RETURNING * INTO v;
 UPDATE ax_definitions SET revision=revision+1 WHERE id=did RETURNING * INTO d;
 result_value:=ax_definition_summary(owner,d);
 INSERT INTO ax_definition_mutations VALUES(owner,mutation_key,digest,d.id,v.id,result_value);
 RETURN jsonb_build_object('definition',result_value,'version',ax_definition_version_json(v),'replayed',false);
END $$;
CREATE OR REPLACE FUNCTION ax_definition_create(owner uuid,wid uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'create',NULL,payload,proposed) $$;
CREATE OR REPLACE FUNCTION ax_definition_update(owner uuid,wid uuid,did uuid,payload jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'update',did,payload) $$;
CREATE OR REPLACE FUNCTION ax_definition_publish(owner uuid,wid uuid,did uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'publish',did,payload,proposed) $$;
CREATE OR REPLACE FUNCTION ax_definition_archive(owner uuid,wid uuid,did uuid,payload jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'archive',did,payload) $$;
CREATE FUNCTION ax_skill_publish_prepare(owner uuid,wid uuid,did uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE d ax_definitions; prior ax_definition_mutations; digest text; mutation_key uuid; v ax_definition_versions;
BEGIN
 d:=ax_definition_access(owner,wid,did,true);
 BEGIN mutation_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 digest:=encode(sha256(convert_to(ax_definition_canonical(jsonb_build_object('workspace_id',wid,'operation','publish','id',did,'payload',payload)),'UTF8')),'hex');
 SELECT * INTO prior FROM ax_definition_mutations WHERE owner_user_id=owner AND request_key=mutation_key;
 IF FOUND THEN
  IF prior.request_hash<>digest OR prior.version_id IS NULL THEN PERFORM ax_error('idempotency_conflict'); END IF;
  SELECT * INTO v FROM ax_definition_versions WHERE id=prior.version_id;
  RETURN v.content;
 END IF;
 IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
 IF d.revision IS DISTINCT FROM (payload->>'expected_revision')::integer THEN PERFORM ax_error('definition_revision_conflict'); END IF;
 RETURN d.draft;
END $$;
DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND (proname LIKE 'ax_skill_%' OR proname LIKE 'ax_definition_%') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END $$;
