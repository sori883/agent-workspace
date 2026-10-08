package native

import (
	"context"
	"encoding/base64"
	"regexp"
	"strings"
)

var skillStorePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var skillManifestPattern = regexp.MustCompile(`^workspaces/([0-9a-f-]{36})/skills/([0-9a-f-]{36})/revisions/([0-9a-f-]{36})/manifest\.json$`)

type SkillObjectSource struct {
	Type           string `json:"type"`
	StoreID        string `json:"store_id"`
	RevisionID     string `json:"revision_id"`
	ManifestKey    string `json:"manifest_key"`
	ManifestSHA256 string `json:"manifest_sha256"`
	ManifestBytes  int    `json:"manifest_bytes"`
	TotalBytes     int    `json:"total_bytes"`
}
type SkillObjectFile struct {
	Path      string `json:"path"`
	SizeBytes int    `json:"size_bytes"`
	MediaType string `json:"media_type"`
	SHA256    string `json:"sha256"`
}
type WorkbenchSkillObject struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	Description   string            `json:"description"`
	ContentSHA256 string            `json:"content_sha256"`
	Source        SkillObjectSource `json:"source"`
	Files         []SkillObjectFile `json:"files"`
	LoadedPaths   []string          `json:"loaded_paths"`
}

func (s SkillObjectSource) Identity() (workspace, definition, revision string) {
	parts := skillManifestPattern.FindStringSubmatch(s.ManifestKey)
	if len(parts) != 4 {
		return
	}
	return parts[1], parts[2], parts[3]
}
func (s SkillObjectSource) Validate() error {
	w, d, r := s.Identity()
	if s.Type != "skill-object-v1" || !skillStorePattern.MatchString(s.StoreID) || !uuidPattern.MatchString(w) || !uuidPattern.MatchString(d) || !uuidPattern.MatchString(r) || r != s.RevisionID || !hashPattern.MatchString(s.ManifestSHA256) || s.ManifestBytes < 1 || s.ManifestBytes > 16384 || s.TotalBytes < 1 || s.TotalBytes > 163840 {
		return errProtocol
	}
	return nil
}
func (o WorkbenchSkillObject) Validate() error {
	if !validSkillSummary(o.ID, o.Name, o.Description) || !hashPattern.MatchString(o.ContentSHA256) || o.Source.Validate() != nil || len(o.Files) < 1 || len(o.Files) > 17 || o.Files[0].Path != "SKILL.md" || o.Files[0].SizeBytes < 1 || o.LoadedPaths == nil || len(o.LoadedPaths) > 17 {
		return errProtocol
	}
	files := map[string]bool{}
	total := o.Source.ManifestBytes
	for _, f := range o.Files {
		if (f.Path != "SKILL.md" && !validSkillPath(f.Path)) || files[f.Path] || f.SizeBytes < 0 || f.SizeBytes > 32768 || f.MediaType != "text/plain; charset=utf-8" || !hashPattern.MatchString(f.SHA256) {
			return errProtocol
		}
		for prior := range files {
			if strings.HasPrefix(f.Path, prior+"/") || strings.HasPrefix(prior, f.Path+"/") {
				return errProtocol
			}
		}
		files[f.Path] = true
		total += f.SizeBytes
	}
	if total != o.Source.TotalBytes || len(o.LoadedPaths) > 0 && o.LoadedPaths[0] != "SKILL.md" {
		return errProtocol
	}
	seen := map[string]bool{}
	for _, path := range o.LoadedPaths {
		if !files[path] || seen[path] {
			return errProtocol
		}
		seen[path] = true
	}
	return nil
}
func (c WorkbenchSkillContext) ObjectSkills() []WorkbenchSkillObject {
	if c.Objects == nil {
		return nil
	}
	return *c.Objects
}
func (c WorkbenchSkillContext) validateObjects(catalog map[string]WorkbenchSkillSummary, loaded map[string]bool) (int, error) {
	if c.Version == 1 {
		if c.Objects != nil {
			return 0, errProtocol
		}
		return 0, nil
	}
	if c.Version != 2 || c.Objects == nil || len(*c.Objects) > 8 {
		return 0, errProtocol
	}
	seen := map[string]bool{}
	count := 0
	for _, o := range *c.Objects {
		if o.Validate() != nil || len(o.LoadedPaths) == 0 || seen[o.ID] || loaded[o.ID] {
			return 0, errProtocol
		}
		if summary, exists := catalog[o.ID]; exists {
			if summary.Name != o.Name || summary.Description != o.Description {
				return 0, errProtocol
			}
		}
		seen[o.ID] = true
		count++
	}
	return count, nil
}

type SkillFileChunk struct {
	RunID            string `json:"run_id"`
	DescriptorSHA256 string `json:"descriptor_sha256"`
	SkillID          string `json:"skill_id"`
	Path             string `json:"path"`
	Index            int    `json:"index"`
	ContentBase64    string `json:"content_base64"`
}

func (a *Adapter) SkillFileChunk(ctx context.Context, r WorkbenchRequest, object WorkbenchSkillObject, file SkillObjectFile, data []byte) error {
	if a.config.Atespace != "ax-runtime" || !runPattern.MatchString(r.RunID) || !hashPattern.MatchString(r.DescriptorSHA256) || object.Validate() != nil || len(data) != file.SizeBytes || HashBytes(data) != file.SHA256 {
		return invalid(StageOperation)
	}
	bound := false
	for _, path := range object.LoadedPaths {
		if path == file.Path {
			for _, expected := range object.Files {
				if file == expected {
					bound = true
				}
			}
		}
	}
	if !bound {
		return invalid(StageOperation)
	}
	return a.workbenchAck(ctx, r.RunID, "skill-file-chunk", SkillFileChunk{r.RunID, r.DescriptorSHA256, object.ID, file.Path, 0, base64.StdEncoding.EncodeToString(data)}, "staged")
}
func SkillObjectPrefix(s SkillObjectSource) string {
	return strings.TrimSuffix(s.ManifestKey, "manifest.json")
}
