package native

import (
	"regexp"
	"strings"
)

var skillNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var skillPathPattern = regexp.MustCompile(`^(references|scripts|assets)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$`)

type WorkbenchSkillSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
type WorkbenchSkillFileRef struct {
	Path      string `json:"path"`
	SizeBytes int    `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}
type WorkbenchLoadedSkill struct {
	ID           string                  `json:"id"`
	Name         string                  `json:"name"`
	Description  string                  `json:"description"`
	Instructions string                  `json:"instructions"`
	Files        []WorkbenchSkillFileRef `json:"files"`
}
type WorkbenchLoadedSkillFile struct {
	SkillID   string `json:"skill_id"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	SizeBytes int    `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}
type WorkbenchSkillContext struct {
	Version         int                        `json:"version"`
	Catalog         []WorkbenchSkillSummary    `json:"catalog"`
	OmittedCount    int                        `json:"omitted_count"`
	LoadedSkills    []WorkbenchLoadedSkill     `json:"loaded_skills"`
	LoadedFiles     []WorkbenchLoadedSkillFile `json:"loaded_files"`
	BuiltinSkillIDs []string                   `json:"builtin_skill_ids"`
	Objects         *[]WorkbenchSkillObject    `json:"objects,omitempty"`
}

func validSkillPath(path string) bool { return len(path) <= 255 && skillPathPattern.MatchString(path) }
func validSkillSummary(id, name, description string) bool {
	return uuidPattern.MatchString(id) && len(name) <= 64 && skillNamePattern.MatchString(name) && validText(description) && len(description) <= 1024
}
func (c WorkbenchSkillContext) Validate() error {
	if (c.Version != 1 && c.Version != 2) || c.OmittedCount < 0 || c.OmittedCount > 2147483647 || c.Catalog == nil || len(c.Catalog) > 32 || c.LoadedSkills == nil || len(c.LoadedSkills) > 8 || c.LoadedFiles == nil || len(c.LoadedFiles) > 128 || c.BuiltinSkillIDs == nil || len(c.BuiltinSkillIDs) > 2 {
		return errProtocol
	}
	encoded, err := CanonicalJSON(c.Catalog)
	if err != nil || len(encoded) > 8192 {
		return errProtocol
	}
	catalog := map[string]WorkbenchSkillSummary{}
	for _, item := range c.Catalog {
		if !validSkillSummary(item.ID, item.Name, item.Description) {
			return errProtocol
		}
		if _, exists := catalog[item.ID]; exists {
			return errProtocol
		}
		catalog[item.ID] = item
	}
	loaded := map[string]bool{}
	refs := map[string]WorkbenchSkillFileRef{}
	for _, item := range c.LoadedSkills {
		if !validSkillSummary(item.ID, item.Name, item.Description) || loaded[item.ID] || !validText(item.Instructions) || strings.TrimSpace(item.Instructions) == "" || len(item.Instructions) > 16384 || item.Files == nil || len(item.Files) > 16 {
			return errProtocol
		}
		if summary, exists := catalog[item.ID]; exists && (summary.Name != item.Name || summary.Description != item.Description) {
			return errProtocol
		}
		loaded[item.ID] = true
		for _, file := range item.Files {
			key := item.ID + ":" + file.Path
			if !validSkillPath(file.Path) || file.SizeBytes < 0 || file.SizeBytes > 32768 || !hashPattern.MatchString(file.SHA256) {
				return errProtocol
			}
			if _, exists := refs[key]; exists {
				return errProtocol
			}
			refs[key] = file
		}
	}
	seen := map[string]bool{}
	for _, file := range c.LoadedFiles {
		key := file.SkillID + ":" + file.Path
		ref, exists := refs[key]
		if !exists || seen[key] || !validText(file.Content) || len(file.Content) != file.SizeBytes || ref.SizeBytes != file.SizeBytes || ref.SHA256 != file.SHA256 || HashBytes([]byte(file.Content)) != file.SHA256 {
			return errProtocol
		}
		seen[key] = true
	}
	seen = map[string]bool{}
	for _, id := range c.BuiltinSkillIDs {
		if (id != "general-v1" && id != "tabular-v1") || seen[id] {
			return errProtocol
		}
		seen[id] = true
	}
	objectCount, err := c.validateObjects(catalog, loaded)
	if err != nil {
		return err
	}
	count := len(c.LoadedSkills) + objectCount
	if seen["tabular-v1"] {
		count++
	}
	if count > 8 {
		return errProtocol
	}
	return nil
}

func (p WorkbenchProposal) ValidateSkillBinding(c *WorkbenchSkillContext) error {
	if p.Kind != "read_skills" && p.Kind != "read_skill_file" {
		return nil
	}
	if c == nil || c.Validate() != nil {
		return errProtocol
	}
	loaded := map[string]bool{"general-v1": true}
	for _, id := range c.BuiltinSkillIDs {
		loaded[id] = true
	}
	for _, item := range c.LoadedSkills {
		loaded[item.ID] = true
	}
	for _, item := range c.ObjectSkills() {
		if len(item.LoadedPaths) > 0 {
			loaded[item.ID] = true
		}
	}
	if p.Kind == "read_skills" {
		available := map[string]bool{"tabular-v1": true}
		for _, item := range c.Catalog {
			available[item.ID] = true
		}
		for _, id := range p.SkillIDs {
			if loaded[id] || !available[id] {
				return errProtocol
			}
			loaded[id] = true
		}
		if len(loaded)-1 > 8 {
			return errProtocol
		}
		return nil
	}
	for _, item := range c.LoadedFiles {
		if item.SkillID == p.SkillID && item.Path == p.Path {
			return errProtocol
		}
	}
	for _, item := range c.LoadedSkills {
		if item.ID == p.SkillID {
			for _, ref := range item.Files {
				if ref.Path == p.Path {
					return nil
				}
			}
		}
	}
	for _, item := range c.ObjectSkills() {
		if item.ID != p.SkillID || len(item.LoadedPaths) == 0 {
			continue
		}
		for _, path := range item.LoadedPaths {
			if path == p.Path {
				return errProtocol
			}
		}
		for _, ref := range item.Files {
			if ref.Path == p.Path && ref.Path != "SKILL.md" {
				return nil
			}
		}
	}
	return errProtocol
}
