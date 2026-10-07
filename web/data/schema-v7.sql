SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
CREATE TABLE ax_definitions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES org_workspaces(id), created_by_user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('skill','agent')), visibility text NOT NULL CHECK(visibility IN ('personal','workspace')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), archived_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), draft jsonb NOT NULL, draft_bytes integer NOT NULL CHECK(draft_bytes BETWEEN 1 AND 131072)
);
CREATE INDEX ax_definitions_page ON ax_definitions(workspace_id,created_at DESC,id DESC);
CREATE TABLE ax_definition_versions (
 id uuid PRIMARY KEY, definition_id uuid NOT NULL REFERENCES ax_definitions(id), version integer NOT NULL CHECK(version BETWEEN 1 AND 100),
 content jsonb NOT NULL, content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 131072), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 published_by_user_id uuid NOT NULL REFERENCES users(id), published_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(definition_id,version)
);
CREATE TABLE ax_definition_mutations (
 owner_user_id uuid NOT NULL REFERENCES users(id), request_key uuid NOT NULL, request_hash text NOT NULL,
 definition_id uuid NOT NULL REFERENCES ax_definitions(id), version_id uuid REFERENCES ax_definition_versions(id), result_definition jsonb NOT NULL,
 PRIMARY KEY(owner_user_id,request_key)
);
CREATE FUNCTION ax_definition_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME<>'ax_definitions' OR TG_OP='DELETE' THEN PERFORM ax_error('immutable_definition'); END IF;
 IF ROW(NEW.id,NEW.workspace_id,NEW.created_by_user_id,NEW.kind,NEW.visibility,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.created_by_user_id,OLD.kind,OLD.visibility,OLD.created_at) OR OLD.archived_at IS NOT NULL THEN PERFORM ax_error('immutable_definition'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_definition_immutable BEFORE UPDATE OR DELETE ON ax_definitions FOR EACH ROW EXECUTE FUNCTION ax_definition_immutable();
CREATE TRIGGER ax_definition_version_immutable BEFORE UPDATE OR DELETE ON ax_definition_versions FOR EACH ROW EXECUTE FUNCTION ax_definition_immutable();
CREATE TRIGGER ax_definition_mutation_immutable BEFORE UPDATE OR DELETE ON ax_definition_mutations FOR EACH ROW EXECUTE FUNCTION ax_definition_immutable();
CREATE FUNCTION ax_definition_canonical(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN RETURN '{'||coalesce((SELECT string_agg(to_json(key)::text||':'||ax_definition_canonical(val),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) e(key,val)),'')||'}';
 WHEN 'array' THEN RETURN '['||coalesce((SELECT string_agg(ax_definition_canonical(val),',' ORDER BY n) FROM jsonb_array_elements(value) WITH ORDINALITY e(val,n)),'')||']';
 ELSE RETURN value::text;
 END CASE;
END $$;
CREATE FUNCTION ax_definition_nonempty(value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT btrim(value,E' \t\n\r\f'||chr(11)||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>''
$$;
CREATE FUNCTION ax_definition_payload(kind_value text,value jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE f jsonb; p text; size integer; fields text[];
BEGIN
 fields:=CASE kind_value WHEN 'skill' THEN ARRAY['name','description','instructions','files'] WHEN 'agent' THEN ARRAY['name','instructions','skill_version_ids','allowed_tools'] END;
 IF fields IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>4 OR NOT value ?& fields THEN PERFORM ax_error('invalid_request'); END IF;
 IF jsonb_typeof(value->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'instructions') IS DISTINCT FROM 'string' OR NOT ax_definition_nonempty(value->>'instructions') OR octet_length(value->>'instructions')>16384 THEN PERFORM ax_error('invalid_request'); END IF;
 IF kind_value='skill' THEN
  IF value->>'name' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(value->>'name')>64 OR jsonb_typeof(value->'description') IS DISTINCT FROM 'string' OR octet_length(value->>'description')>1024 OR jsonb_typeof(value->'files') IS DISTINCT FROM 'array' THEN PERFORM ax_error('invalid_request'); END IF;
  IF jsonb_array_length(value->'files')>16 THEN PERFORM ax_error('invalid_request'); END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(value->'files') LOOP
   IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(f))<>2 OR NOT f ?& ARRAY['path','content'] OR jsonb_typeof(f->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'content') IS DISTINCT FROM 'string' OR octet_length(f->>'content')>32768 THEN PERFORM ax_error('invalid_request'); END IF;
   p:=f->>'path';
   IF char_length(p)>255 OR p !~ '^(references|scripts|assets)/([A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$' THEN PERFORM ax_error('invalid_request'); END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(value->'files'))<>(SELECT count(DISTINCT entry->>'path') FROM jsonb_array_elements(value->'files') entry) THEN PERFORM ax_error('invalid_request'); END IF;
 ELSE
  IF NOT ax_definition_nonempty(value->>'name') OR octet_length(value->>'name')>256 OR jsonb_typeof(value->'skill_version_ids') IS DISTINCT FROM 'array' OR jsonb_typeof(value->'allowed_tools') IS DISTINCT FROM 'array' THEN PERFORM ax_error('invalid_request'); END IF;
  IF jsonb_array_length(value->'skill_version_ids')>8 OR jsonb_array_length(value->'allowed_tools')>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'allowed_tools') t WHERE t<>'"python"'::jsonb) THEN PERFORM ax_error('invalid_request'); END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(value->'skill_version_ids') LOOP
   IF jsonb_typeof(f)<>'string' OR f#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN PERFORM ax_error('invalid_request'); END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(value->'skill_version_ids'))<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(value->'skill_version_ids') v) THEN PERFORM ax_error('invalid_request'); END IF;
 END IF;
 size:=octet_length(ax_definition_canonical(value));
 IF size>131072 THEN PERFORM ax_error('invalid_request'); END IF;
 RETURN size;
END $$;
CREATE FUNCTION ax_definition_editor(owner uuid,d ax_definitions) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT d.created_by_user_id=owner OR (d.visibility='workspace' AND EXISTS(SELECT 1 FROM org_memberships WHERE workspace_id=d.workspace_id AND user_id=owner AND access_level='admin'))
$$;
CREATE FUNCTION ax_definition_access(owner uuid,wid uuid,did uuid,editing boolean DEFAULT false) RETURNS ax_definitions LANGUAGE plpgsql AS $$
DECLARE d ax_definitions;
BEGIN
 SELECT * INTO d FROM ax_definitions WHERE id=did AND workspace_id=wid AND (visibility='workspace' OR created_by_user_id=owner);
 IF NOT FOUND THEN PERFORM ax_error('definition_not_found'); END IF;
 PERFORM ax_file_authorize(owner,wid);
 IF editing AND NOT ax_definition_editor(owner,d) THEN PERFORM ax_error('definition_forbidden'); END IF;
 RETURN d;
END $$;
CREATE FUNCTION ax_definition_dependencies(owner uuid,wid uuid,visibility_value text,value jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE vid uuid; d ax_definitions;
BEGIN
 FOR vid IN SELECT (v#>>'{}')::uuid FROM jsonb_array_elements(value->'skill_version_ids') v LOOP
  SELECT b.* INTO d FROM ax_definition_versions v JOIN ax_definitions b ON b.id=v.definition_id WHERE v.id=vid FOR SHARE OF b;
  IF NOT FOUND OR d.kind<>'skill' OR d.workspace_id<>wid OR d.archived_at IS NOT NULL OR (d.visibility='personal' AND (visibility_value='workspace' OR d.created_by_user_id<>owner)) THEN PERFORM ax_error('definition_dependency_unavailable'); END IF;
 END LOOP;
END $$;
CREATE FUNCTION ax_definition_version_json(v ax_definition_versions) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',v.id,'definition_id',v.definition_id,'version',v.version,'kind',(SELECT kind FROM ax_definitions WHERE id=v.definition_id),'content',v.content,'sha256',v.sha256,'published_by_user_id',v.published_by_user_id,'published_at',to_char(v.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;
CREATE FUNCTION ax_definition_summary(owner uuid,d ax_definitions) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v ax_definition_versions; editing boolean:=ax_definition_editor(owner,d);
BEGIN
 SELECT * INTO v FROM ax_definition_versions WHERE definition_id=d.id ORDER BY version DESC LIMIT 1;
 RETURN jsonb_build_object('id',d.id,'workspace_id',d.workspace_id,'created_by_user_id',d.created_by_user_id,'kind',d.kind,'visibility',d.visibility,'name',CASE WHEN editing THEN d.draft->>'name' ELSE v.content->>'name' END,'revision',CASE WHEN editing THEN d.revision END,'can_edit',editing,'archived_at',CASE WHEN d.archived_at IS NOT NULL THEN to_char(d.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,'created_at',to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'latest_version',CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('id',v.id,'name',v.content->>'name','version',v.version,'sha256',v.sha256,'published_at',to_char(v.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) END);
END $$;
CREATE FUNCTION ax_definition_get(owner uuid,wid uuid,did uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE d ax_definitions; v ax_definition_versions; editing boolean;
BEGIN
 d:=ax_definition_access(owner,wid,did);
 SELECT * INTO d FROM ax_definitions WHERE id=did FOR SHARE;
 editing:=ax_definition_editor(owner,d);
 SELECT * INTO v FROM ax_definition_versions WHERE definition_id=did ORDER BY version DESC LIMIT 1;
 IF NOT editing AND (d.archived_at IS NOT NULL OR v.id IS NULL) THEN PERFORM ax_error('definition_not_found'); END IF;
 RETURN jsonb_build_object('definition',ax_definition_summary(owner,d),'draft',CASE WHEN editing THEN jsonb_build_object('revision',d.revision,'content',d.draft) END,'version',CASE WHEN v.id IS NOT NULL THEN ax_definition_version_json(v) END);
END $$;
CREATE FUNCTION ax_definition_version(owner uuid,wid uuid,vid uuid,for_use boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE d ax_definitions; v ax_definition_versions;
BEGIN
 SELECT * INTO v FROM ax_definition_versions WHERE id=vid;
 IF NOT FOUND THEN PERFORM ax_error('definition_version_not_found'); END IF;
 d:=ax_definition_access(owner,wid,v.definition_id);
 SELECT * INTO d FROM ax_definitions WHERE id=d.id FOR SHARE;
 IF for_use IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 IF for_use THEN
  IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
  IF d.kind='agent' THEN PERFORM ax_definition_dependencies(owner,wid,d.visibility,v.content); END IF;
 END IF;
 RETURN ax_definition_version_json(v);
END $$;
CREATE FUNCTION ax_definition_list(owner uuid,wid uuid,options jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE boundary ax_definitions; item ax_definitions; items jsonb:='[]'; cursor uuid; lim integer; wanted text; filt text; archived boolean; before_id uuid;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 IF jsonb_typeof(options) IS DISTINCT FROM 'object' OR options - ARRAY['kind','filter','before','limit','include_archived']<>'{}'::jsonb THEN PERFORM ax_error('invalid_request'); END IF;
 wanted:=options->>'kind'; filt:=coalesce(options->>'filter','all');
 IF (options ? 'kind' AND jsonb_typeof(options->'kind')<>'string') OR (wanted IS NOT NULL AND wanted NOT IN ('skill','agent')) OR (options ? 'filter' AND jsonb_typeof(options->'filter')<>'string') OR filt NOT IN ('all','personal','workspace') OR (options ? 'limit' AND (jsonb_typeof(options->'limit')<>'number' OR options->>'limit' !~ '^[0-9]{1,2}$')) OR (options ? 'include_archived' AND jsonb_typeof(options->'include_archived')<>'boolean') THEN PERFORM ax_error('invalid_request'); END IF;
 lim:=coalesce((options->>'limit')::integer,50); archived:=coalesce((options->>'include_archived')::boolean,false);
 IF lim NOT BETWEEN 1 AND 50 THEN PERFORM ax_error('invalid_request'); END IF;
 IF options ? 'before' THEN
  BEGIN before_id:=(options->>'before')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
  IF before_id IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
  boundary:=ax_definition_access(owner,wid,before_id);
  IF NOT ax_definition_editor(owner,boundary) AND (boundary.archived_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ax_definition_versions WHERE definition_id=boundary.id)) THEN PERFORM ax_error('definition_not_found'); END IF;
 END IF;
 FOR item IN SELECT d.* FROM ax_definitions d WHERE d.workspace_id=wid AND (d.visibility='workspace' OR d.created_by_user_id=owner) AND (wanted IS NULL OR d.kind=wanted) AND (filt='all' OR d.visibility=filt) AND (d.archived_at IS NULL OR (archived AND ax_definition_editor(owner,d))) AND (ax_definition_editor(owner,d) OR EXISTS(SELECT 1 FROM ax_definition_versions WHERE definition_id=d.id)) AND (before_id IS NULL OR (d.created_at,d.id)<(boundary.created_at,boundary.id)) ORDER BY d.created_at DESC,d.id DESC LIMIT lim+1 LOOP
  IF jsonb_array_length(items)=lim THEN RETURN jsonb_build_object('definitions',items,'next_cursor',cursor); END IF;
  items:=items||jsonb_build_array(ax_definition_summary(owner,item)); cursor:=item.id;
 END LOOP;
 RETURN jsonb_build_object('definitions',items,'next_cursor',NULL);
END $$;
CREATE FUNCTION ax_definition_mutate(owner uuid,wid uuid,operation text,did uuid,payload jsonb,proposed uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d ax_definitions; v ax_definition_versions; prior ax_definition_mutations; mutation_key uuid; digest text; expected integer; size integer; delta integer; result jsonb; number integer;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 IF operation NOT IN ('create','update','publish','archive') OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'key') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN mutation_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 IF mutation_key IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 digest:=encode(sha256(convert_to(ax_definition_canonical(jsonb_build_object('workspace_id',wid,'operation',operation,'id',did,'payload',payload)),'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(926019,1);
 SELECT * INTO prior FROM ax_definition_mutations m WHERE m.owner_user_id=owner AND m.request_key=mutation_key;
 IF FOUND THEN
  IF prior.request_hash<>digest THEN PERFORM ax_error('idempotency_conflict'); END IF;
  PERFORM ax_definition_access(owner,wid,prior.definition_id,true);
  IF prior.version_id IS NOT NULL THEN SELECT * INTO v FROM ax_definition_versions WHERE id=prior.version_id; END IF;
  RETURN jsonb_build_object('definition',prior.result_definition,'version',CASE WHEN v.id IS NOT NULL THEN ax_definition_version_json(v) END,'replayed',true);
 END IF;
 IF operation='create' THEN
  IF proposed IS NULL OR did IS NOT NULL OR (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['key','kind','visibility','content'] OR payload->>'visibility' NOT IN ('personal','workspace') OR jsonb_typeof(payload->'visibility') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
  size:=ax_definition_payload(payload->>'kind',payload->'content');
  IF payload->>'kind'='agent' THEN PERFORM ax_definition_dependencies(owner,wid,payload->>'visibility',payload->'content'); END IF;
  IF (SELECT count(*) FROM ax_definitions WHERE workspace_id=wid AND created_by_user_id=owner)>=100 THEN PERFORM ax_error('definition_count_limit'); END IF;
  delta:=size;
 ELSE
  d:=ax_definition_access(owner,wid,did,true);
  SELECT * INTO d FROM ax_definitions WHERE id=did FOR UPDATE;
  IF (SELECT count(*) FROM jsonb_object_keys(payload))<>(CASE WHEN operation='update' THEN 3 ELSE 2 END) OR NOT payload ?& ARRAY['key','expected_revision'] OR (operation='update' AND NOT payload ? 'content') OR jsonb_typeof(payload->'expected_revision') IS DISTINCT FROM 'number' OR payload->>'expected_revision' !~ '^[0-9]{1,10}$' OR (payload->>'expected_revision')::numeric NOT BETWEEN 1 AND 2147483647 THEN PERFORM ax_error('invalid_request'); END IF;
  expected:=(payload->>'expected_revision')::integer;
  IF d.revision<>expected THEN PERFORM ax_error('definition_revision_conflict'); END IF;
  IF d.archived_at IS NOT NULL THEN PERFORM ax_error('definition_archived'); END IF;
  IF operation='update' THEN
   size:=ax_definition_payload(d.kind,payload->'content'); delta:=size-d.draft_bytes;
   IF d.kind='agent' THEN PERFORM ax_definition_dependencies(owner,wid,d.visibility,payload->'content'); END IF;
  ELSIF operation='publish' THEN
   IF proposed IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
   IF d.kind='agent' THEN PERFORM ax_definition_dependencies(owner,wid,d.visibility,d.draft); END IF;
   SELECT coalesce(max(version),0)+1 INTO number FROM ax_definition_versions WHERE definition_id=did;
   IF number>100 THEN PERFORM ax_error('definition_version_limit'); END IF;
   delta:=d.draft_bytes;
  ELSE delta:=0;
  END IF;
 END IF;
 IF coalesce((SELECT sum(draft_bytes) FROM ax_definitions),0)+coalesce((SELECT sum(content_bytes) FROM ax_definition_versions),0)+delta>134217728 THEN PERFORM ax_error('definition_quota_exceeded'); END IF;
 IF operation='create' THEN
  INSERT INTO ax_definitions(id,workspace_id,created_by_user_id,kind,visibility,draft,draft_bytes) VALUES(proposed,wid,owner,payload->>'kind',payload->>'visibility',payload->'content',size) RETURNING * INTO d;
 ELSIF operation='update' THEN
  UPDATE ax_definitions SET draft=payload->'content',draft_bytes=size,revision=revision+1 WHERE id=did RETURNING * INTO d;
 ELSIF operation='publish' THEN
  INSERT INTO ax_definition_versions(id,definition_id,version,content,content_bytes,sha256,published_by_user_id) VALUES(proposed,did,number,d.draft,d.draft_bytes,encode(sha256(convert_to(ax_definition_canonical(d.draft),'UTF8')),'hex'),owner) RETURNING * INTO v;
  UPDATE ax_definitions SET revision=revision+1 WHERE id=did RETURNING * INTO d;
 ELSE
  UPDATE ax_definitions SET revision=revision+1,archived_at=clock_timestamp() WHERE id=did RETURNING * INTO d;
 END IF;
 result:=ax_definition_summary(owner,d);
 INSERT INTO ax_definition_mutations VALUES(owner,mutation_key,digest,d.id,v.id,result);
 RETURN jsonb_build_object('definition',result,'version',CASE WHEN v.id IS NOT NULL THEN ax_definition_version_json(v) END,'replayed',false);
END $$;
CREATE FUNCTION ax_definition_create(owner uuid,wid uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'create',NULL,payload,proposed) $$;
CREATE FUNCTION ax_definition_update(owner uuid,wid uuid,did uuid,payload jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'update',did,payload) $$;
CREATE FUNCTION ax_definition_publish(owner uuid,wid uuid,did uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'publish',did,payload,proposed) $$;
CREATE FUNCTION ax_definition_archive(owner uuid,wid uuid,did uuid,payload jsonb) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT ax_definition_mutate(owner,wid,'archive',did,payload) $$;
DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax_definition_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
END $$;
