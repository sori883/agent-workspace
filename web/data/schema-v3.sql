SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);
LOCK TABLE org_workspaces,org_memberships IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM org_workspaces w LEFT JOIN org_memberships m ON m.workspace_id=w.id AND m.user_id=w.created_by_user_id LEFT JOIN users u ON u.id=w.created_by_user_id WHERE m.access_level IS DISTINCT FROM 'admin' OR u.status IS DISTINCT FROM 'active') THEN
    PERFORM ax_error('workspace_owner_migration_required');
  END IF;
END $$;
ALTER TABLE org_workspaces ADD COLUMN owner_user_id uuid REFERENCES users(id);
UPDATE org_workspaces SET owner_user_id=created_by_user_id;
ALTER TABLE org_workspaces ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE org_workspaces ADD CONSTRAINT org_owner_membership FOREIGN KEY(id,owner_user_id) REFERENCES org_memberships(workspace_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX org_workspaces_owner ON org_workspaces(owner_user_id);
CREATE FUNCTION org_owner_admin_constraint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; owner uuid;
BEGIN
  IF TG_TABLE_NAME='org_workspaces' THEN wid:=NEW.id; ELSE wid:=coalesce(NEW.workspace_id,OLD.workspace_id); END IF;
  SELECT owner_user_id INTO owner FROM org_workspaces WHERE id=wid;
  IF FOUND AND NOT EXISTS(SELECT 1 FROM org_memberships WHERE workspace_id=wid AND user_id=owner AND access_level='admin') THEN PERFORM ax_error('invalid_workspace_owner'); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER org_workspace_owner_admin AFTER INSERT OR UPDATE ON org_workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org_owner_admin_constraint();
CREATE CONSTRAINT TRIGGER org_membership_owner_admin AFTER INSERT OR UPDATE OR DELETE ON org_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org_owner_admin_constraint();

CREATE TABLE org_ownership_transfers(
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES org_workspaces(id),
  from_user_id uuid NOT NULL REFERENCES users(id),to_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK(status IN ('pending','accepted','rejected','cancelled','expired')),
  expires_at timestamptz NOT NULL, CHECK(from_user_id<>to_user_id)
);
CREATE UNIQUE INDEX org_one_pending_transfer ON org_ownership_transfers(workspace_id) WHERE status='pending';
CREATE FUNCTION org_transfer_summary(t org_ownership_transfers) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',t.id,'from_user_id',t.from_user_id,'to_user_id',t.to_user_id,'expires_at',to_char(t.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'status',CASE WHEN t.status='pending' AND t.expires_at<=statement_timestamp() THEN 'expired' ELSE t.status END)
$$;
CREATE FUNCTION org_ownership_quota_lock(first_user uuid,second_user uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE uid uuid;
BEGIN
  FOR uid IN SELECT DISTINCT value FROM unnest(ARRAY[first_user,second_user]) value WHERE value IS NOT NULL ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(uid::text,714285904));
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION org_summary(actor uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE m org_memberships; w org_workspaces;
BEGIN
  m:=org_authorize(actor,wid); SELECT * INTO w FROM org_workspaces WHERE id=wid;
  RETURN jsonb_build_object('id',wid,'name',w.name,'owner_user_id',w.owner_user_id,'access_level',m.access_level,'business_role',m.business_role);
END $$;
CREATE OR REPLACE FUNCTION org_list(actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM org_active(actor);
  RETURN jsonb_build_object('workspaces',coalesce((SELECT jsonb_agg(org_summary(actor,w.id) ORDER BY w.created_at,w.id) FROM org_workspaces w JOIN org_memberships m ON m.workspace_id=w.id WHERE m.user_id=actor),'[]'::jsonb),'owned_count',(SELECT count(*) FROM org_workspaces WHERE owner_user_id=actor),'ownership_limit',50);
END $$;
CREATE OR REPLACE FUNCTION org_create(actor uuid,request_key uuid,value text,proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior org_requests;
BEGIN
  PERFORM org_active(actor); PERFORM org_name(value);
  IF request_key IS NULL OR proposed IS NULL THEN PERFORM ax_error('invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||request_key::text,714285903));
  PERFORM org_ownership_quota_lock(actor); PERFORM org_active(actor);
  SELECT * INTO prior FROM org_requests WHERE org_requests.actor=org_create.actor AND key=request_key;
  IF FOUND THEN
    IF prior.operation<>'workspace_create' OR prior.payload<>jsonb_build_object('name',value) THEN PERFORM ax_error('idempotency_conflict'); END IF;
    RETURN jsonb_build_object('workspace',org_summary(actor,prior.target_id),'replayed',true);
  END IF;
  IF (SELECT count(*) FROM org_workspaces WHERE owner_user_id=actor)>=50 THEN PERFORM ax_error('workspace_ownership_limit'); END IF;
  INSERT INTO org_workspaces(id,name,created_by_user_id,owner_user_id) VALUES(proposed,value,actor,actor);
  INSERT INTO org_memberships VALUES(proposed,actor,'admin','general');
  INSERT INTO org_requests VALUES(actor,request_key,'workspace_create',proposed,jsonb_build_object('name',value),proposed);
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,proposed,'workspace_create',proposed);
  RETURN jsonb_build_object('workspace',org_summary(actor,proposed),'replayed',false);
END $$;
ALTER FUNCTION org_detail(uuid,uuid) RENAME TO org_detail_v2;
CREATE FUNCTION org_detail(actor uuid,wid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE detail jsonb; transfer jsonb;
BEGIN
  detail:=org_detail_v2(actor,wid);
  SELECT org_transfer_summary(t) INTO transfer FROM org_ownership_transfers t WHERE t.workspace_id=wid AND t.status='pending' AND t.expires_at>statement_timestamp() AND actor IN(t.from_user_id,t.to_user_id);
  RETURN detail||jsonb_build_object('ownership_transfer',transfer);
END $$;
ALTER FUNCTION org_mutate(uuid,uuid,text,uuid,jsonb) RENAME TO org_mutate_v2;
CREATE FUNCTION org_mutate(actor uuid,wid uuid,operation text,target uuid,value jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE owner uuid; result jsonb;
BEGIN
  SELECT owner_user_id INTO owner FROM org_workspaces WHERE id=wid FOR UPDATE;
  PERFORM org_authorize(actor,wid,operation<>'leave');
  IF operation='leave' THEN target:=actor; END IF;
  IF target=owner AND (operation IN ('remove_member','leave') OR operation='member' AND value->>'access_level' IS DISTINCT FROM 'admin') THEN PERFORM ax_error('workspace_owner_cannot_leave'); END IF;
  result:=org_mutate_v2(actor,wid,operation,target,value);
  RETURN result;
END $$;
CREATE FUNCTION org_cancel_departed_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH changed AS (
    UPDATE org_ownership_transfers SET status='cancelled' WHERE workspace_id=OLD.workspace_id AND to_user_id=OLD.user_id AND status='pending' RETURNING id,workspace_id
  ) INSERT INTO org_audit_events(actor,workspace_id,operation,target) SELECT OLD.user_id,workspace_id,'ownership_recipient_departed',id FROM changed;
  RETURN OLD;
END $$;
CREATE TRIGGER org_transfer_recipient_departed AFTER DELETE ON org_memberships FOR EACH ROW EXECUTE FUNCTION org_cancel_departed_recipient();

CREATE FUNCTION org_propose_ownership(actor uuid,wid uuid,request_key uuid,recipient uuid,proposed uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior org_requests; t org_ownership_transfers; owner uuid;
BEGIN
  PERFORM org_active(actor);
  IF request_key IS NULL OR recipient IS NULL OR proposed IS NULL OR recipient=actor THEN PERFORM ax_error('ownership_transfer_invalid_recipient'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||request_key::text,714285903));
  SELECT owner_user_id INTO owner FROM org_workspaces WHERE id=wid FOR UPDATE;
  SELECT * INTO prior FROM org_requests WHERE org_requests.actor=org_propose_ownership.actor AND key=request_key;
  IF FOUND THEN
    IF prior.operation<>'ownership_transfer' OR prior.workspace_id<>wid OR prior.payload<>jsonb_build_object('to_user_id',recipient) THEN PERFORM ax_error('idempotency_conflict'); END IF;
    SELECT * INTO t FROM org_ownership_transfers WHERE id=prior.target_id;
    RETURN jsonb_build_object('transfer',org_transfer_summary(t),'replayed',true);
  END IF;
  PERFORM org_authorize(actor,wid);
  IF owner<>actor THEN PERFORM ax_error('workspace_owner_required'); END IF;
  IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=wid AND m.user_id=recipient AND u.status='active') THEN PERFORM ax_error('ownership_transfer_invalid_recipient'); END IF;
  UPDATE org_ownership_transfers SET status='expired' WHERE workspace_id=wid AND status='pending' AND expires_at<=clock_timestamp();
  IF EXISTS(SELECT 1 FROM org_ownership_transfers WHERE workspace_id=wid AND status='pending') THEN PERFORM ax_error('ownership_transfer_pending'); END IF;
  INSERT INTO org_ownership_transfers VALUES(proposed,wid,actor,recipient,'pending',clock_timestamp()+interval '7 days') RETURNING * INTO t;
  INSERT INTO org_requests VALUES(actor,request_key,'ownership_transfer',wid,jsonb_build_object('to_user_id',recipient),proposed);
  INSERT INTO org_audit_events(actor,workspace_id,operation,target,data) VALUES(actor,wid,'ownership_proposed',proposed,jsonb_build_object('to_user_id',recipient));
  RETURN jsonb_build_object('transfer',org_transfer_summary(t),'replayed',false);
END $$;
CREATE FUNCTION org_respond_ownership(actor uuid,wid uuid,transfer_id uuid,action text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE t org_ownership_transfers; owner uuid; final_status text;
BEGIN
  PERFORM org_active(actor);
  IF action IS NULL OR action NOT IN ('accept','reject','cancel') THEN PERFORM ax_error('invalid_request'); END IF;
  SELECT * INTO t FROM org_ownership_transfers WHERE id=transfer_id AND workspace_id=wid;
  IF NOT FOUND THEN PERFORM ax_error('ownership_transfer_not_found'); END IF;
  IF (action='cancel' AND actor<>t.from_user_id) OR (action<>'cancel' AND actor<>t.to_user_id) THEN PERFORM ax_error('ownership_transfer_forbidden'); END IF;
  IF action='accept' THEN PERFORM org_ownership_quota_lock(t.from_user_id,t.to_user_id); END IF;
  SELECT owner_user_id INTO owner FROM org_workspaces WHERE id=wid FOR UPDATE;
  SELECT * INTO t FROM org_ownership_transfers WHERE id=transfer_id AND workspace_id=wid FOR UPDATE;
  final_status:=CASE action WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' ELSE 'cancelled' END;
  IF t.status=final_status THEN RETURN '{"ok":true}'::jsonb; END IF;
  IF t.status<>'pending' OR t.expires_at<=clock_timestamp() OR owner<>t.from_user_id THEN PERFORM ax_error('ownership_transfer_unavailable'); END IF;
  IF action='accept' THEN
    IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=wid AND m.user_id=t.from_user_id AND m.access_level='admin' AND u.status='active') THEN PERFORM ax_error('ownership_transfer_unavailable'); END IF;
    IF NOT EXISTS(SELECT 1 FROM org_memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=wid AND m.user_id=actor AND u.status='active') THEN PERFORM ax_error('ownership_transfer_invalid_recipient'); END IF;
    IF (SELECT count(*) FROM org_workspaces WHERE owner_user_id=actor)>=50 THEN PERFORM ax_error('workspace_ownership_limit'); END IF;
    UPDATE org_memberships SET access_level='admin' WHERE workspace_id=wid AND user_id=actor;
    UPDATE org_workspaces SET owner_user_id=actor WHERE id=wid;
  END IF;
  UPDATE org_ownership_transfers SET status=final_status WHERE id=transfer_id;
  INSERT INTO org_audit_events(actor,workspace_id,operation,target) VALUES(actor,wid,'ownership_'||final_status,transfer_id);
  RETURN '{"ok":true}'::jsonb;
END $$;
DO $$
DECLARE f record; role_name text;
BEGIN
  FOR f IN SELECT oid::regprocedure signature,proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname LIKE 'org\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
    IF f.proname IN ('org_detail_v2','org_mutate_v2') THEN
      FOREACH role_name IN ARRAY ARRAY['ax_api','ax_execution'] LOOP
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name); END IF;
      END LOOP;
    END IF;
  END LOOP;
END $$;
