SELECT set_config('search_path', quote_ident(current_schema()) || ', pg_temp', true);

ALTER TABLE ax_agent_roots ADD COLUMN skill_storage_runtime boolean NOT NULL DEFAULT false;
ALTER TABLE ax_agent_roots ALTER COLUMN skill_storage_runtime SET DEFAULT true;

CREATE OR REPLACE FUNCTION ax_workbench_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ax_agent_roots' THEN
  IF ROW(NEW.runtime_version,NEW.execution_policy,NEW.definition_version_id,NEW.definition_manifest,NEW.initial_text,NEW.runtime_image,NEW.code_image,NEW.code_profile,NEW.skill_discovery,NEW.skill_catalog,NEW.skill_catalog_omitted,NEW.skill_storage_runtime) IS DISTINCT FROM ROW(OLD.runtime_version,OLD.execution_policy,OLD.definition_version_id,OLD.definition_manifest,OLD.initial_text,OLD.runtime_image,OLD.code_image,OLD.code_profile,OLD.skill_discovery,OLD.skill_catalog,OLD.skill_catalog_omitted,OLD.skill_storage_runtime) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSIF TG_TABLE_NAME='ax_agent_segments' THEN
  IF ROW(NEW.attempt_kind,NEW.predecessor_run_id,NEW.descriptor,NEW.checkpoint_revision) IS DISTINCT FROM ROW(OLD.attempt_kind,OLD.predecessor_run_id,OLD.descriptor,OLD.checkpoint_revision) THEN PERFORM ax_error('immutable_workbench'); END IF;
 ELSE PERFORM ax_error('immutable_workbench'); END IF;
 RETURN NEW;
END $$;

ALTER FUNCTION ax_workbench_skill_context(ax_agent_roots) RENAME TO ax_workbench_skill_context_inline;
CREATE FUNCTION ax_workbench_skill_context(a ax_agent_roots) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE loaded jsonb; files jsonb; builtin jsonb; objects jsonb;
BEGIN
 IF NOT a.skill_storage_runtime THEN RETURN ax_workbench_skill_context_inline(a); END IF;
 PERFORM ax_workbench_definitions(a);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.content->>'name','description',v.content->>'description','instructions',v.content->>'instructions',
  'files',coalesce((SELECT jsonb_agg(jsonb_build_object('path',f->>'path','size_bytes',octet_length(f->>'content'),'sha256',encode(sha256(convert_to(f->>'content','UTF8')),'hex')) ORDER BY f->>'path') FROM jsonb_array_elements(v.content->'files') f),'[]'::jsonb)) ORDER BY v.content->>'name',v.id),'[]'::jsonb)
 INTO loaded FROM ax_workbench_skill_loads l JOIN ax_definition_versions v ON v.id::text=l.skill_id WHERE l.root_id=a.id AND l.path='SKILL.md' AND NOT v.content ? 'source';
 SELECT coalesce(jsonb_agg(jsonb_build_object('skill_id',l.skill_id,'path',l.path,'content',f->>'content','size_bytes',octet_length(f->>'content'),'sha256',encode(sha256(convert_to(f->>'content','UTF8')),'hex')) ORDER BY l.skill_id,l.path),'[]'::jsonb)
 INTO files FROM ax_workbench_skill_loads l JOIN ax_definition_versions v ON v.id::text=l.skill_id CROSS JOIN LATERAL jsonb_array_elements(v.content->'files') f WHERE l.root_id=a.id AND l.path<>'SKILL.md' AND f->>'path'=l.path AND NOT v.content ? 'source';
 SELECT coalesce(jsonb_agg(skill_id ORDER BY skill_id),'[]'::jsonb) INTO builtin FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id IN ('general-v1','tabular-v1');
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.content->>'name','description',v.content->>'description','content_sha256',v.content->>'content_sha256','source',v.content->'source','files',v.content->'files',
  'loaded_paths',coalesce((SELECT jsonb_agg(l.path ORDER BY CASE WHEN l.path='SKILL.md' THEN 0 ELSE 1 END,l.path) FROM ax_workbench_skill_loads l WHERE l.root_id=a.id AND l.skill_id=v.id::text),'[]'::jsonb)) ORDER BY v.content->>'name',v.id),'[]'::jsonb)
 INTO objects FROM ax_definition_versions v WHERE v.content ? 'source' AND EXISTS(SELECT 1 FROM ax_workbench_skill_loads l WHERE l.root_id=a.id AND l.skill_id=v.id::text AND l.path='SKILL.md');
 RETURN jsonb_build_object('version',2,'catalog',a.skill_catalog,'omitted_count',a.skill_catalog_omitted,'loaded_skills',loaded,'loaded_files',files,'builtin_skill_ids',builtin,'objects',objects);
END $$;

CREATE FUNCTION ax_workbench_skill_object(run text,gen bigint,controller text,vid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE a ax_agent_roots; s ax_agent_segments; pinned jsonb; current_value jsonb;
BEGIN
 a:=ax_workbench_claim(run,gen,controller);
 SELECT * INTO s FROM ax_agent_segments WHERE run_id=run;
 IF NOT a.skill_storage_runtime OR s.attempt_kind<>'runtime' OR s.descriptor->'skill_context'->'version' IS DISTINCT FROM '2'::jsonb THEN PERFORM ax_error('skill_not_available'); END IF;
 SELECT value INTO pinned FROM jsonb_array_elements(s.descriptor->'skill_context'->'objects') WHERE value->>'id'=vid::text;
 IF pinned IS NULL OR jsonb_array_length(pinned->'loaded_paths')=0 OR NOT EXISTS(SELECT 1 FROM ax_workbench_skill_loads WHERE root_id=a.id AND skill_id=vid::text AND path='SKILL.md') THEN PERFORM ax_error('skill_not_loaded'); END IF;
 SELECT value INTO current_value FROM jsonb_array_elements(ax_workbench_skill_context(a)->'objects') WHERE value->>'id'=vid::text;
 IF current_value IS DISTINCT FROM pinned THEN PERFORM ax_error('skill_storage_integrity'); END IF;
 RETURN pinned;
END $$;

REVOKE ALL ON FUNCTION ax_workbench_skill_context(ax_agent_roots), ax_workbench_skill_object(text,bigint,text,uuid) FROM PUBLIC;
