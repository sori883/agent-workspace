package controller

import (
	"context"
	"errors"
	"reflect"

	"github.com/sori883/agent-workspace/execution/native"
)

type SkillObjectReader interface {
	ReadSkill(context.Context, native.WorkbenchSkillObject) (map[string][]byte, error)
}
type SkillObjectStore interface {
	SkillObject(context.Context, *Claim, native.WorkbenchSkillObject) (native.WorkbenchSkillObject, error)
}
type SkillObjectExecutor interface {
	SkillFileChunk(context.Context, native.WorkbenchRequest, native.WorkbenchSkillObject, native.SkillObjectFile, []byte) error
}

func (p *Postgres) SkillObject(ctx context.Context, c *Claim, expected native.WorkbenchSkillObject) (native.WorkbenchSkillObject, error) {
	var raw []byte
	var object native.WorkbenchSkillObject
	if err := p.pool.QueryRow(ctx, p.query("ax_workbench_skill_object")+"($1,$2,$3,$4)", c.RunID, c.Generation, p.controllerID, expected.ID).Scan(&raw); err != nil {
		return object, classifyIntentError(err)
	}
	if native.DecodeStrict(raw, &object) != nil || object.Validate() != nil || !reflect.DeepEqual(object, expected) {
		return object, errors.New("skill_storage_integrity")
	}
	return object, nil
}

func (c *Controller) stageSkillObjects(ctx context.Context, claim *Claim, executor WorkbenchExecutor) error {
	context := claim.Workbench.Descriptor.SkillContext
	if context == nil || len(context.ObjectSkills()) == 0 {
		return nil
	}
	store, storeOK := c.Store.(SkillObjectStore)
	transport, transportOK := executor.(SkillObjectExecutor)
	for _, expected := range context.ObjectSkills() {
		if len(expected.LoadedPaths) == 0 {
			continue
		}
		if !storeOK || !transportOK || c.SkillObjects == nil {
			return errors.New("skill_storage_unavailable")
		}
		object, err := store.SkillObject(ctx, claim, expected)
		if err != nil {
			return err
		}
		files, err := c.SkillObjects.ReadSkill(ctx, object)
		if err != nil {
			return err
		}
		if len(files) != len(object.LoadedPaths) {
			return errors.New("skill_storage_integrity")
		}
		if _, err = store.SkillObject(ctx, claim, expected); err != nil {
			return err
		}
		for _, path := range object.LoadedPaths {
			var metadata native.SkillObjectFile
			for _, file := range object.Files {
				if file.Path == path {
					metadata = file
				}
			}
			data, exists := files[path]
			if !exists || len(data) != metadata.SizeBytes || native.HashBytes(data) != metadata.SHA256 {
				return errors.New("skill_storage_integrity")
			}
			if err = transport.SkillFileChunk(ctx, *claim.WorkbenchRequest, object, metadata, data); err != nil {
				return err
			}
		}
	}
	return nil
}
