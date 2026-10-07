SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
CREATE TABLE ax_files (
 id uuid PRIMARY KEY,
 owner_user_id uuid NOT NULL REFERENCES users(id), workspace_id uuid NOT NULL REFERENCES org_workspaces(id), request_key uuid NOT NULL,
 name text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 media_type text NOT NULL CHECK(media_type IN ('text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), ready_at timestamptz,
 UNIQUE(owner_user_id,request_key), CHECK((state='ready')=(ready_at IS NOT NULL))
);
CREATE INDEX ax_files_owner_page ON ax_files(owner_user_id,workspace_id,created_at DESC,id DESC);
CREATE TABLE ax_file_chunks (
 file_id uuid NOT NULL REFERENCES ax_files(id), chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 255),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 32768), PRIMARY KEY(file_id,chunk_index)
);
CREATE FUNCTION ax_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'uploading' OR ROW(NEW.id,NEW.owner_user_id,NEW.workspace_id,NEW.request_key,NEW.name,NEW.size_bytes,NEW.sha256,NEW.media_type,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.workspace_id,OLD.request_key,OLD.name,OLD.size_bytes,OLD.sha256,OLD.media_type,OLD.created_at) THEN PERFORM ax_error('immutable_file'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_file_immutable BEFORE UPDATE OR DELETE ON ax_files FOR EACH ROW EXECUTE FUNCTION ax_file_immutable();
CREATE FUNCTION ax_file_chunk_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f ax_files;
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM ax_error('immutable_file'); END IF;
 SELECT * INTO f FROM ax_files WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.file_id ELSE NEW.file_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN
  IF f.state IS DISTINCT FROM 'cancelled' THEN PERFORM ax_error('immutable_file'); END IF;
  RETURN OLD;
 END IF;
 IF f.state IS DISTINCT FROM 'uploading' THEN PERFORM ax_error('immutable_file'); END IF;
 IF NEW.chunk_index>=(f.size_bytes+32767)/32768 OR octet_length(NEW.content)<>least(32768,f.size_bytes-NEW.chunk_index*32768) THEN PERFORM ax_error('invalid_file_chunk'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ax_file_chunk_immutable BEFORE INSERT OR UPDATE OR DELETE ON ax_file_chunks FOR EACH ROW EXECUTE FUNCTION ax_file_chunk_immutable();
CREATE FUNCTION ax_file_authorize(owner uuid,wid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF owner IS NULL OR wid IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
 PERFORM 1 FROM org_workspaces WHERE id=wid FOR SHARE;
 PERFORM 1 FROM users WHERE id=owner FOR SHARE;
 PERFORM 1 FROM org_memberships WHERE workspace_id=wid AND user_id=owner FOR SHARE;
 PERFORM org_authorize(owner,wid);
END $$;
CREATE FUNCTION ax_file_owned(owner uuid,wid uuid,fid uuid) RETURNS ax_files LANGUAGE plpgsql AS $$
DECLARE f ax_files;
BEGIN
 SELECT * INTO f FROM ax_files WHERE id=fid AND owner_user_id=owner AND workspace_id=wid;
 IF NOT FOUND THEN PERFORM ax_error('file_not_found'); END IF;
 PERFORM ax_file_authorize(owner,wid);
 RETURN f;
END $$;
CREATE FUNCTION ax_file_info(f ax_files) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',f.id,'name',f.name,'size_bytes',f.size_bytes,'sha256',f.sha256,'media_type',f.media_type,'state',f.state,
 'chunk_size',32768,'chunk_count',(f.size_bytes+32767)/32768,'received_chunks',(SELECT count(*) FROM ax_file_chunks WHERE file_id=f.id),
 'created_at',to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'ready_at',CASE WHEN f.ready_at IS NOT NULL THEN to_char(f.ready_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END)
$$;
CREATE FUNCTION ax_file_begin(owner uuid,wid uuid,payload jsonb,proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files; upload_key uuid; name text; size integer; digest text; media text;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 IF proposed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>4 OR NOT payload ?& ARRAY['key','name','size_bytes','sha256'] THEN PERFORM ax_error('invalid_request'); END IF;
 IF jsonb_typeof(payload->'key') IS DISTINCT FROM 'string' OR jsonb_typeof(payload->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(payload->'size_bytes') IS DISTINCT FROM 'number' OR payload->>'size_bytes' !~ '^[0-9]{1,7}$' OR jsonb_typeof(payload->'sha256') IS DISTINCT FROM 'string' THEN PERFORM ax_error('invalid_request'); END IF;
 BEGIN upload_key:=(payload->>'key')::uuid; EXCEPTION WHEN invalid_text_representation THEN PERFORM ax_error('invalid_request'); END;
 name:=payload->>'name'; size:=(payload->>'size_bytes')::integer; digest:=payload->>'sha256';
 IF upload_key IS NULL OR size NOT BETWEEN 1 AND 8388608 OR digest !~ '^[0-9a-f]{64}$' OR octet_length(name)>255 OR char_length(name)<=4 OR name<>btrim(name) OR name ~ '[[:cntrl:]/\\]' OR name !~* '\.(csv|xlsx)$' THEN PERFORM ax_error('invalid_request'); END IF;
 media:=CASE WHEN name ~* '\.csv$' THEN 'text/csv' ELSE 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' END;
 PERFORM pg_advisory_xact_lock(926018,1);
 SELECT * INTO f FROM ax_files WHERE owner_user_id=owner AND ax_files.request_key=upload_key;
 IF FOUND THEN
  IF f.workspace_id<>wid OR f.name<>name OR f.size_bytes<>size OR f.sha256<>digest THEN PERFORM ax_error('idempotency_conflict'); END IF;
  RETURN jsonb_build_object('file',ax_file_info(f),'replayed',true);
 END IF;
 IF (SELECT count(*) FROM ax_files WHERE owner_user_id=owner AND state='uploading')>=4 THEN PERFORM ax_error('file_draft_limit'); END IF;
 IF coalesce((SELECT sum(size_bytes) FROM ax_files WHERE owner_user_id=owner AND state<>'cancelled'),0)+size>268435456 OR coalesce((SELECT sum(size_bytes) FROM ax_files WHERE state<>'cancelled'),0)+size>1073741824 THEN PERFORM ax_error('file_quota_exceeded'); END IF;
 INSERT INTO ax_files(id,owner_user_id,workspace_id,request_key,name,size_bytes,sha256,media_type) VALUES(proposed,owner,wid,upload_key,name,size,digest,media) RETURNING * INTO f;
 RETURN jsonb_build_object('file',ax_file_info(f),'replayed',false);
END $$;
CREATE FUNCTION ax_file_get(owner uuid,wid uuid,fid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files;
BEGIN
 f:=ax_file_owned(owner,wid,fid);
 SELECT * INTO f FROM ax_files WHERE id=fid FOR SHARE;
 RETURN ax_file_info(f);
END $$;
CREATE FUNCTION ax_file_list(owner uuid,wid uuid,before_id uuid DEFAULT NULL,page_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE boundary ax_files; result jsonb; cursor uuid; stamp timestamptz;
BEGIN
 PERFORM ax_file_authorize(owner,wid);
 IF page_limit IS NULL OR page_limit NOT BETWEEN 1 AND 100 THEN PERFORM ax_error('invalid_request'); END IF;
 IF before_id IS NOT NULL THEN
  SELECT * INTO boundary FROM ax_files WHERE id=before_id AND owner_user_id=owner AND workspace_id=wid;
  IF NOT FOUND THEN PERFORM ax_error('file_not_found'); END IF;
 END IF;
 SELECT coalesce(jsonb_agg(ax_file_info(page) ORDER BY page.created_at DESC,page.id DESC),'[]'::jsonb) INTO result FROM
 (SELECT * FROM ax_files WHERE owner_user_id=owner AND workspace_id=wid AND state<>'cancelled' AND (before_id IS NULL OR (created_at,id)<(boundary.created_at,boundary.id)) ORDER BY created_at DESC,id DESC LIMIT page_limit) page;
 IF jsonb_array_length(result)=page_limit THEN
  cursor:=(result->(page_limit-1)->>'id')::uuid;
  SELECT created_at INTO stamp FROM ax_files WHERE id=cursor;
  IF NOT EXISTS(SELECT 1 FROM ax_files WHERE owner_user_id=owner AND workspace_id=wid AND state<>'cancelled' AND (created_at,id)<(stamp,cursor)) THEN cursor:=NULL; END IF;
 END IF;
 RETURN jsonb_build_object('files',result,'next_cursor',cursor);
END $$;
CREATE FUNCTION ax_file_chunk(owner uuid,wid uuid,fid uuid,part integer,bytes bytea) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files; prior bytea;
BEGIN
 f:=ax_file_owned(owner,wid,fid);
 SELECT * INTO f FROM ax_files WHERE id=fid FOR UPDATE;
 IF part IS NULL OR part<0 OR part>=(f.size_bytes+32767)/32768 OR bytes IS NULL OR octet_length(bytes)<>least(32768,f.size_bytes-part*32768) THEN PERFORM ax_error('invalid_file_chunk'); END IF;
 IF f.state='cancelled' THEN PERFORM ax_error('file_cancelled'); END IF;
 SELECT content INTO prior FROM ax_file_chunks WHERE file_id=fid AND chunk_index=part;
 IF FOUND THEN
  IF prior<>bytes THEN PERFORM ax_error('file_chunk_conflict'); END IF;
  RETURN '{"ok":true,"replayed":true}'::jsonb;
 END IF;
 IF f.state<>'uploading' THEN PERFORM ax_error('file_already_ready'); END IF;
 INSERT INTO ax_file_chunks VALUES(fid,part,bytes);
 RETURN '{"ok":true,"replayed":false}'::jsonb;
END $$;
CREATE FUNCTION ax_file_seal(owner uuid,wid uuid,fid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files; body bytea; parts integer;
BEGIN
 f:=ax_file_owned(owner,wid,fid);
 SELECT * INTO f FROM ax_files WHERE id=fid FOR UPDATE;
 IF f.state='cancelled' THEN PERFORM ax_error('file_cancelled'); END IF;
 IF f.state='ready' THEN RETURN jsonb_build_object('file',ax_file_info(f),'replayed',true); END IF;
 SELECT count(*),string_agg(content,''::bytea ORDER BY chunk_index) INTO parts,body FROM ax_file_chunks WHERE file_id=fid;
 IF parts<>(f.size_bytes+32767)/32768 OR octet_length(body) IS DISTINCT FROM f.size_bytes THEN PERFORM ax_error('file_incomplete'); END IF;
 IF encode(sha256(body),'hex')<>f.sha256 THEN PERFORM ax_error('file_hash_mismatch'); END IF;
 UPDATE ax_files SET state='ready',ready_at=clock_timestamp() WHERE id=fid RETURNING * INTO f;
 RETURN jsonb_build_object('file',ax_file_info(f),'replayed',false);
END $$;
CREATE FUNCTION ax_file_read_chunk(owner uuid,wid uuid,fid uuid,part integer) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files; body bytea;
BEGIN
 f:=ax_file_owned(owner,wid,fid);
 SELECT * INTO f FROM ax_files WHERE id=fid FOR SHARE;
 IF f.state<>'ready' THEN PERFORM ax_error('file_not_ready'); END IF;
 IF part IS NULL OR part<0 OR part>=(f.size_bytes+32767)/32768 THEN PERFORM ax_error('invalid_file_chunk'); END IF;
 SELECT content INTO body FROM ax_file_chunks WHERE file_id=fid AND chunk_index=part;
 IF NOT FOUND THEN PERFORM ax_error('file_incomplete'); END IF;
 RETURN encode(body,'hex');
END $$;
CREATE FUNCTION ax_file_cancel(owner uuid,wid uuid,fid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE f ax_files;
BEGIN
 f:=ax_file_owned(owner,wid,fid);
 PERFORM pg_advisory_xact_lock(926018,1);
 SELECT * INTO f FROM ax_files WHERE id=fid FOR UPDATE;
 IF f.state='ready' THEN PERFORM ax_error('file_already_ready'); END IF;
 IF f.state='cancelled' THEN RETURN '{"ok":true,"replayed":true}'::jsonb; END IF;
 UPDATE ax_files SET state='cancelled' WHERE id=fid;
 DELETE FROM ax_file_chunks WHERE file_id=fid;
 RETURN '{"ok":true,"replayed":false}'::jsonb;
END $$;
CREATE FUNCTION ax_file_cancel_unavailable(owner uuid,current_wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE wid uuid; fid uuid; locked_workspaces uuid[]:='{}'; cancelled integer:=0;
BEGIN
 PERFORM ax_file_authorize(owner,current_wid);
 FOR wid IN SELECT w.id FROM org_workspaces w WHERE EXISTS(SELECT 1 FROM ax_files f WHERE f.workspace_id=w.id AND f.owner_user_id=owner AND f.state='uploading') ORDER BY w.id FOR SHARE LOOP
  locked_workspaces:=array_append(locked_workspaces,wid);
 END LOOP;
 PERFORM pg_advisory_xact_lock(926018,1);
 FOR fid IN SELECT f.id FROM ax_files f WHERE f.owner_user_id=owner AND f.workspace_id=ANY(locked_workspaces) AND f.state='uploading' AND NOT EXISTS(SELECT 1 FROM org_memberships m WHERE m.workspace_id=f.workspace_id AND m.user_id=owner) ORDER BY f.id FOR UPDATE LOOP
  UPDATE ax_files SET state='cancelled' WHERE id=fid AND owner_user_id=owner AND state='uploading' AND NOT EXISTS(SELECT 1 FROM org_memberships m WHERE m.workspace_id=ax_files.workspace_id AND m.user_id=owner);
  IF FOUND THEN
   DELETE FROM ax_file_chunks WHERE file_id=fid;
   cancelled:=cancelled+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('cancelled_count',cancelled);
END $$;
DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'ax_file_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
END $$;
