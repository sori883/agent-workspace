SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);

CREATE TABLE org_workspaces(id uuid PRIMARY KEY, name text NOT NULL, created_by_user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE org_memberships(workspace_id uuid REFERENCES org_workspaces(id), user_id uuid REFERENCES users(id), access_level text NOT NULL CHECK(access_level IN ('admin','member')), business_role text NOT NULL CHECK(business_role IN ('general','developer')), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE org_groups(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES org_workspaces(id), name text NOT NULL, UNIQUE(workspace_id,id));
CREATE TABLE org_group_memberships(workspace_id uuid, group_id uuid, user_id uuid, PRIMARY KEY(workspace_id,group_id,user_id), FOREIGN KEY(workspace_id,group_id) REFERENCES org_groups(workspace_id,id) ON DELETE CASCADE, FOREIGN KEY(workspace_id,user_id) REFERENCES org_memberships(workspace_id,user_id) ON DELETE CASCADE);
CREATE TABLE org_invitations(id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES org_workspaces(id), created_by_user_id uuid NOT NULL REFERENCES users(id), email text NOT NULL, token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'), expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, accepted_by_user_id uuid REFERENCES users(id));
CREATE TABLE org_requests(actor uuid REFERENCES users(id), key uuid, operation text NOT NULL, workspace_id uuid REFERENCES org_workspaces(id), payload jsonb NOT NULL, target_id uuid NOT NULL, PRIMARY KEY(actor,key));
CREATE TABLE org_audit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor uuid NOT NULL REFERENCES users(id), workspace_id uuid NOT NULL REFERENCES org_workspaces(id), operation text NOT NULL, target uuid, data jsonb NOT NULL DEFAULT '{}', recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE ax_conversations ADD COLUMN workspace_id uuid REFERENCES org_workspaces(id);
ALTER TABLE ax_runs ADD COLUMN workspace_id uuid REFERENCES org_workspaces(id);
ALTER TABLE ax_conversations ADD CONSTRAINT ax_conversations_workspace_unique UNIQUE(workspace_id,id);
ALTER TABLE ax_runs ADD CONSTRAINT ax_runs_conversation_workspace_fk FOREIGN KEY(workspace_id,conversation_id) REFERENCES ax_conversations(workspace_id,id);
CREATE INDEX ax_runs_workspace_owner ON ax_runs(workspace_id,owner_user_id,sort_at DESC);
CREATE INDEX org_memberships_user ON org_memberships(user_id,workspace_id);

CREATE FUNCTION org_creator_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN PERFORM ax_error('immutable_workspace_creator'); END IF; RETURN NEW; END $$;
CREATE TRIGGER org_creator_immutable BEFORE UPDATE ON org_workspaces FOR EACH ROW EXECUTE FUNCTION org_creator_immutable();

CREATE FUNCTION org_active(actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id=actor AND status='active') THEN PERFORM ax_error('invalid_owner_user_id'); END IF; END $$;
CREATE FUNCTION org_authorize(actor uuid, wid uuid, admin_only boolean DEFAULT false) RETURNS org_memberships LANGUAGE plpgsql STABLE AS $$
DECLARE m org_memberships;
BEGIN
  PERFORM org_active(actor);
  SELECT * INTO m FROM org_memberships WHERE workspace_id=wid AND user_id=actor;
  IF NOT FOUND THEN PERFORM ax_error('workspace_not_found'); END IF;
  IF admin_only AND m.access_level<>'admin' THEN PERFORM ax_error('workspace_forbidden'); END IF;
  RETURN m;
END $$;
CREATE FUNCTION org_name(value text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS NULL OR length(value) NOT BETWEEN 1 AND 100 OR octet_length(value)>300 OR value !~ '[^[:space:]]' OR value ~ '[[:cntrl:]]' THEN PERFORM ax_error('invalid_request'); END IF; END $$;
CREATE FUNCTION org_summary(actor uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE m org_memberships; name text;
BEGIN m:=org_authorize(actor,wid); SELECT w.name INTO name FROM org_workspaces w WHERE w.id=wid; RETURN jsonb_build_object('id',wid,'name',name,'access_level',m.access_level,'business_role',m.business_role); END $$;
CREATE FUNCTION org_list(actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM org_active(actor);
  RETURN jsonb_build_object('workspaces',coalesce((SELECT jsonb_agg(org_summary(actor,w.id) ORDER BY w.created_at,w.id) FROM org_workspaces w JOIN org_memberships m ON m.workspace_id=w.id WHERE m.user_id=actor),'[]'::jsonb),'created_count',(SELECT count(*) FROM org_workspaces WHERE created_by_user_id=actor),'creation_limit',3);
END $$;
CREATE FUNCTION org_create(actor uuid, request_key uuid, value text, proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior org_requests;
BEGIN
  PERFORM org_active(actor); PERFORM org_name(value);
  IF request_key IS NULL OR proposed IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||request_key::text,714285903));
  PERFORM 1 FROM users WHERE id=actor FOR UPDATE;
  PERFORM org_active(actor);
  SELECT * INTO prior FROM org_requests WHERE org_requests.actor=org_create.actor AND key=request_key;
  IF FOUND THEN
    IF prior.operation<>'workspace_create' OR prior.payload<>jsonb_build_object('name',value) THEN PERFORM ax_error('idempotency_conflict'); END IF;
    RETURN jsonb_build_object('workspace',org_summary(actor,prior.target_id),'replayed',true);
  END IF;
  IF (SELECT count(*) FROM org_workspaces WHERE created_by_user_id=actor)>=3 THEN PERFORM ax_error('workspace_creation_limit'); END IF;
  INSERT INTO org_workspaces(id,name,created_by_user_id) VALUES(proposed,value,actor);
  INSERT INTO org_memberships VALUES(proposed,actor,'admin','general');
  INSERT INTO org_requests VALUES(actor,request_key,'workspace_create',proposed,jsonb_build_object('name',value),proposed);
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,proposed,'workspace_create',proposed);
  RETURN jsonb_build_object('workspace',org_summary(actor,proposed),'replayed',false);
END $$;
CREATE FUNCTION org_group(gid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',g.id,'name',g.name,'member_user_ids',coalesce((SELECT jsonb_agg(user_id ORDER BY user_id) FROM org_group_memberships WHERE group_id=g.id),'[]'::jsonb)) FROM org_groups g WHERE g.id=gid
$$;
CREATE FUNCTION org_detail(actor uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE viewer org_memberships; invitations jsonb:='[]';
BEGIN
  viewer:=org_authorize(actor,wid);
  IF viewer.access_level='admin' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'expires_at',to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'status',CASE WHEN revoked THEN 'revoked' WHEN accepted_by_user_id IS NOT NULL THEN 'accepted' WHEN expires_at<=statement_timestamp() THEN 'expired' ELSE 'pending' END) ORDER BY expires_at,id),'[]') INTO invitations FROM org_invitations WHERE workspace_id=wid;
  END IF;
  RETURN jsonb_build_object('workspace',org_summary(actor,wid),'members',coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',u.id,'display_name',u.display_name,'access_level',m.access_level,'business_role',m.business_role) ORDER BY u.id) FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=wid),'[]'::jsonb),'groups',coalesce((SELECT jsonb_agg(org_group(id) ORDER BY name,id) FROM org_groups WHERE workspace_id=wid),'[]'::jsonb),'invitations',invitations);
END $$;
CREATE FUNCTION org_mutate(actor uuid,wid uuid,operation text,target uuid,value jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE m org_memberships; current_member org_memberships; level text; role text;
BEGIN
  PERFORM 1 FROM org_workspaces WHERE id=wid FOR UPDATE;
  m:=org_authorize(actor,wid,operation<>'leave');
  CASE operation
  WHEN 'rename' THEN
    PERFORM org_name(value->>'name'); UPDATE org_workspaces SET name=value->>'name' WHERE id=wid;
  WHEN 'member','remove_member','leave' THEN
    IF operation='leave' THEN target:=actor; END IF;
    SELECT * INTO current_member FROM org_memberships WHERE workspace_id=wid AND user_id=target;
    IF NOT FOUND THEN PERFORM ax_error('member_not_found'); END IF;
    level:=value->>'access_level'; role:=value->>'business_role';
    IF operation='member' AND (level IS NULL OR level NOT IN ('admin','member') OR role IS NULL OR role NOT IN ('general','developer')) THEN PERFORM ax_error('invalid_request'); END IF;
    IF current_member.access_level='admin' AND (operation<>'member' OR level<>'admin') AND
      NOT EXISTS(SELECT 1 FROM org_memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.workspace_id=wid AND mm.user_id<>target AND mm.access_level='admin' AND u.status='active') THEN PERFORM ax_error('last_workspace_admin'); END IF;
    IF operation='member' THEN UPDATE org_memberships SET access_level=level,business_role=role WHERE workspace_id=wid AND user_id=target;
    ELSE DELETE FROM org_memberships WHERE workspace_id=wid AND user_id=target; END IF;
  WHEN 'rename_group','delete_group','group_member' THEN
    IF NOT EXISTS(SELECT 1 FROM org_groups WHERE workspace_id=wid AND id=target) THEN PERFORM ax_error('group_not_found'); END IF;
    IF operation='rename_group' THEN PERFORM org_name(value->>'name'); UPDATE org_groups SET name=value->>'name' WHERE workspace_id=wid AND id=target;
    ELSIF operation='delete_group' THEN DELETE FROM org_groups WHERE workspace_id=wid AND id=target;
    ELSE
      IF jsonb_typeof(value->'member') IS DISTINCT FROM 'boolean' OR NOT EXISTS(SELECT 1 FROM org_memberships mm JOIN users u ON u.id=mm.user_id WHERE mm.workspace_id=wid AND mm.user_id=(value->>'user_id')::uuid AND u.status='active') THEN PERFORM ax_error('member_not_found'); END IF;
      IF (value->>'member')::boolean THEN INSERT INTO org_group_memberships VALUES(wid,target,(value->>'user_id')::uuid) ON CONFLICT DO NOTHING;
      ELSE DELETE FROM org_group_memberships WHERE workspace_id=wid AND group_id=target AND user_id=(value->>'user_id')::uuid; END IF;
    END IF;
  WHEN 'revoke_invitation' THEN
    IF NOT EXISTS(SELECT 1 FROM org_invitations WHERE workspace_id=wid AND id=target) THEN PERFORM ax_error('invitation_not_found'); END IF;
    UPDATE org_invitations SET revoked=true WHERE workspace_id=wid AND id=target;
  ELSE PERFORM ax_error('invalid_request');
  END CASE;
  INSERT INTO org_audit_events(actor,workspace_id,operation,target,data) VALUES(actor,wid,operation,target,value);
  RETURN '{"ok":true}'::jsonb;
END $$;
CREATE FUNCTION org_create_group(actor uuid,wid uuid,request_key uuid,value text,proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior org_requests;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||request_key::text,714285903));
  PERFORM 1 FROM org_workspaces WHERE id=wid FOR UPDATE;
  PERFORM org_authorize(actor,wid,true); PERFORM org_name(value);
  IF request_key IS NULL OR proposed IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
  SELECT * INTO prior FROM org_requests WHERE org_requests.actor=org_create_group.actor AND key=request_key;
  IF FOUND THEN
    IF prior.operation<>'group_create' OR prior.workspace_id<>wid OR prior.payload<>jsonb_build_object('name',value) THEN PERFORM ax_error('idempotency_conflict'); END IF;
    IF NOT EXISTS(SELECT 1 FROM org_groups WHERE id=prior.target_id AND workspace_id=wid) THEN PERFORM ax_error('group_not_found'); END IF;
    RETURN jsonb_build_object('group',org_group(prior.target_id),'replayed',true);
  END IF;
  INSERT INTO org_groups VALUES(proposed,wid,value);
  INSERT INTO org_requests VALUES(actor,request_key,'group_create',wid,jsonb_build_object('name',value),proposed);
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,wid,'group_create',proposed);
  RETURN jsonb_build_object('group',org_group(proposed),'replayed',false);
END $$;
CREATE FUNCTION org_invite(actor uuid,wid uuid,request_key uuid,email_value text,proposed uuid,hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior org_requests; invitation org_invitations;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||request_key::text,714285903));
  PERFORM 1 FROM org_workspaces WHERE id=wid FOR UPDATE;
  PERFORM org_authorize(actor,wid,true);
  IF request_key IS NULL OR proposed IS NULL OR email_value IS NULL OR length(email_value)>254 OR email_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR hash IS NULL OR hash !~ '^[0-9a-f]{64}$' THEN PERFORM ax_error('invalid_request'); END IF;
  email_value:=lower(email_value);
  SELECT * INTO prior FROM org_requests WHERE org_requests.actor=org_invite.actor AND key=request_key;
  IF FOUND THEN
    IF prior.operation<>'invite' OR prior.workspace_id<>wid OR prior.payload<>jsonb_build_object('email',email_value) THEN PERFORM ax_error('idempotency_conflict'); END IF;
    SELECT * INTO invitation FROM org_invitations WHERE id=prior.target_id;
    RETURN jsonb_build_object('id',invitation.id,'expires_at',to_char(invitation.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'replayed',true);
  END IF;
  INSERT INTO org_invitations(id,workspace_id,created_by_user_id,email,token_hash,expires_at) VALUES(proposed,wid,actor,email_value,hash,clock_timestamp()+interval '7 days') RETURNING * INTO invitation;
  INSERT INTO org_requests VALUES(actor,request_key,'invite',wid,jsonb_build_object('email',email_value),proposed);
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,wid,'invite',proposed);
  RETURN jsonb_build_object('id',proposed,'expires_at',to_char(invitation.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'replayed',false);
END $$;
CREATE FUNCTION org_accept_invitation(actor uuid,hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE invitation org_invitations; verified text;
BEGIN
  PERFORM org_active(actor);
  SELECT * INTO invitation FROM org_invitations WHERE token_hash=hash;
  IF NOT FOUND THEN PERFORM ax_error('invitation_unavailable'); END IF;
  PERFORM 1 FROM org_workspaces WHERE id=invitation.workspace_id FOR UPDATE;
  SELECT * INTO invitation FROM org_invitations WHERE token_hash=hash FOR UPDATE;
  IF invitation.revoked OR invitation.expires_at<=clock_timestamp() THEN PERFORM ax_error('invitation_unavailable'); END IF;
  SELECT verified_email INTO verified FROM users WHERE id=actor AND status='active' FOR SHARE;
  IF verified IS NULL THEN PERFORM ax_error('verified_email_required'); END IF;
  IF lower(verified)<>invitation.email THEN PERFORM ax_error('invitation_recipient_mismatch'); END IF;
  IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=invitation.workspace_id AND m.user_id=invitation.created_by_user_id AND m.access_level='admin' AND u.status='active') THEN PERFORM ax_error('invitation_sender_inactive'); END IF;
  IF invitation.accepted_by_user_id IS NOT NULL THEN
    IF invitation.accepted_by_user_id<>actor OR NOT EXISTS(SELECT 1 FROM org_memberships WHERE workspace_id=invitation.workspace_id AND user_id=actor) THEN PERFORM ax_error('invitation_already_used'); END IF;
    RETURN jsonb_build_object('workspace',org_summary(actor,invitation.workspace_id),'replayed',true);
  END IF;
  INSERT INTO org_memberships VALUES(invitation.workspace_id,actor,'member','general') ON CONFLICT DO NOTHING;
  UPDATE org_invitations SET accepted_by_user_id=actor WHERE id=invitation.id;
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,invitation.workspace_id,'accept_invitation',invitation.id);
  RETURN jsonb_build_object('workspace',org_summary(actor,invitation.workspace_id),'replayed',false);
END $$;

CREATE FUNCTION ax_workspace_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (TG_TABLE_NAME='ax_runs' AND NEW.legacy) THEN NEW.workspace_id:=nullif(current_setting('ax.workspace_id',true),'')::uuid; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ax_runs_workspace_insert BEFORE INSERT ON ax_runs FOR EACH ROW EXECUTE FUNCTION ax_workspace_insert();
CREATE FUNCTION ax_conversation_workspace_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.workspace_id:=nullif(current_setting('ax.workspace_id',true),'')::uuid; RETURN NEW; END $$;
CREATE TRIGGER ax_conversations_workspace_insert BEFORE INSERT ON ax_conversations FOR EACH ROW EXECUTE FUNCTION ax_conversation_workspace_insert();
CREATE FUNCTION ax_workspace_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN PERFORM ax_error('immutable_workspace'); END IF; RETURN NEW; END $$;
CREATE TRIGGER ax_run_workspace_immutable BEFORE UPDATE ON ax_runs FOR EACH ROW EXECUTE FUNCTION ax_workspace_immutable();
CREATE TRIGGER ax_conversation_workspace_immutable BEFORE UPDATE ON ax_conversations FOR EACH ROW EXECUTE FUNCTION ax_workspace_immutable();
CREATE FUNCTION ax_ws_authorize(owner uuid,run text,wid uuid) RETURNS ax_runs LANGUAGE plpgsql STABLE AS $$
DECLARE r ax_runs;
BEGIN
  r:=ax_authorize(owner,run);
  IF r.workspace_id IS DISTINCT FROM wid THEN PERFORM ax_error('run_not_found'); END IF;
  IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF;
  RETURN r;
END $$;
CREATE FUNCTION ax_ws_accept(owner uuid,kind text,cid uuid,payload jsonb,image text,proposed_run text,wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE answer jsonb; r ax_runs; previous text;
BEGIN
  IF wid IS NULL THEN PERFORM ax_error('workspace_required'); END IF;
  PERFORM 1 FROM org_workspaces WHERE id=wid FOR SHARE;
  PERFORM org_authorize(owner,wid);
  IF kind='chat' AND EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid AND (workspace_id IS DISTINCT FROM wid OR owner_user_id IS DISTINCT FROM owner)) THEN PERFORM ax_error('conversation_not_found'); END IF;
  previous:=current_setting('ax.workspace_id',true);
  PERFORM set_config('ax.workspace_id',wid::text,true);
  answer:=ax_accept(owner,kind,cid,payload,image,proposed_run);
  r:=ax_ws_authorize(owner,answer->>'run_id',wid);
  PERFORM set_config('ax.workspace_id',coalesce(previous,''),true);
  RETURN answer;
END $$;
CREATE FUNCTION ax_ws_read_run(owner uuid,run text,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; BEGIN r:=ax_ws_authorize(owner,run,wid); RETURN ax_snapshot(r); END $$;
CREATE FUNCTION ax_ws_list_runs(owner uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs; rows jsonb:='[]';
BEGIN
  PERFORM org_active(owner); IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF;
  FOR r IN SELECT * FROM ax_runs WHERE owner_user_id=owner AND workspace_id IS NOT DISTINCT FROM wid ORDER BY sort_at DESC,run_id DESC LIMIT 50 LOOP
    PERFORM ax_ws_authorize(owner,r.run_id,wid); rows:=rows||jsonb_build_array(ax_snapshot(r,false));
  END LOOP; RETURN rows;
END $$;
CREATE FUNCTION ax_ws_read_conversation(owner uuid,cid uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM ax_conversations WHERE id=cid AND owner_user_id=owner AND workspace_id IS NOT DISTINCT FROM wid) THEN PERFORM ax_error('conversation_not_found'); END IF;
  IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF;
  RETURN ax_read_conversation(owner,cid);
END $$;
CREATE FUNCTION ax_ws_list_conversations(owner uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE cid uuid; rows jsonb:='[]';
BEGIN
  PERFORM org_active(owner); IF wid IS NOT NULL THEN PERFORM org_authorize(owner,wid); END IF;
  FOR cid IN SELECT c.id FROM ax_conversations c JOIN ax_runs r ON r.run_id=c.head_run_id WHERE c.owner_user_id=owner AND c.workspace_id IS NOT DISTINCT FROM wid ORDER BY r.sort_at DESC,c.id DESC LIMIT 50 LOOP
    rows:=rows||jsonb_build_array(ax_ws_read_conversation(owner,cid,wid));
  END LOOP; RETURN rows;
END $$;
CREATE FUNCTION ax_ws_request_recovery(owner uuid,run text,wid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN PERFORM ax_ws_authorize(owner,run,wid); RETURN ax_request_recovery(owner,run); END $$;
ALTER FUNCTION ax_intent(text,bigint,text,text) RENAME TO ax_intent_v1;
DO $$ BEGIN EXECUTE replace(pg_get_functiondef('ax_intent_v1(text,bigint,text,text)'::regprocedure),'ax_intent.operation','ax_intent_v1.operation'); END $$;
CREATE FUNCTION ax_intent(run text,gen bigint,controller text,operation text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs;
BEGIN
  r:=ax_check_claim(run,gen,controller);
  IF operation NOT IN ('egress_deny','suspend') THEN
    IF r.workspace_id IS NULL THEN PERFORM ax_error('workspace_required'); END IF;
    PERFORM 1 FROM org_workspaces WHERE id=r.workspace_id FOR SHARE;
    IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id AND u.status='active') THEN PERFORM ax_error('workspace_access_revoked'); END IF;
  END IF;
  RETURN ax_intent_v1(run,gen,controller,operation);
END $$;

CREATE FUNCTION ax_cancel_unstarted(run text,gen bigint,controller text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r ax_runs;
BEGIN
  PERFORM 1 FROM ax_execution_slot WHERE id FOR UPDATE;
  r:=ax_check_claim(run,gen,controller);
  IF r.apply_attempted OR r.start_attempted OR r.result IS NOT NULL OR EXISTS(SELECT 1 FROM ax_effects WHERE run_id=run) THEN PERFORM ax_error('execution_already_claimed'); END IF;
  UPDATE ax_runs SET resolved=true,phase='not_started',outcome='not_started',error_type='workspace_access_revoked',cleanup='{"egress_denied":false,"suspended":false}',cleanup_errors='[]' WHERE run_id=run;
  UPDATE ax_jobs SET state='done',lease_until=NULL WHERE run_id=run;
  UPDATE ax_execution_slot SET run_id=NULL,hold_reason=NULL WHERE id AND run_id=run;
  RETURN '{"resolved":true,"outcome":"not_started"}'::jsonb;
END $$;

DO $$
DECLARE f record; role_name text;
BEGIN
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND (proname LIKE 'org\_%' ESCAPE '\' OR proname LIKE 'ax\_%' ESCAPE '\') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    IF f.proname IN ('ax_accept','ax_read_run','ax_list_runs','ax_read_conversation','ax_list_conversations','ax_request_recovery','ax_intent_v1') THEN
      FOREACH role_name IN ARRAY ARRAY['ax_api','ax_execution'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name); END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;
