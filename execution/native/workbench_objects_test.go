package native

import (
	"bytes"
	"testing"
)

func objectSkillFixture() WorkbenchSkillObject {
	id := testSkillID
	return WorkbenchSkillObject{ID: id, Name: "sales-sum", Description: "売上の集計", ContentSHA256: HashBytes([]byte("content")),
		Source: SkillObjectSource{Type: "skill-object-v1", StoreID: "test-skills", RevisionID: id, ManifestKey: "workspaces/" + id + "/skills/" + id + "/revisions/" + id + "/manifest.json", ManifestSHA256: HashBytes([]byte("manifest")), ManifestBytes: 1, TotalBytes: 3},
		Files:  []SkillObjectFile{{Path: "SKILL.md", SizeBytes: 1, MediaType: "text/plain; charset=utf-8", SHA256: HashBytes([]byte("x"))}, {Path: "references/a.md", SizeBytes: 1, MediaType: "text/plain; charset=utf-8", SHA256: HashBytes([]byte("y"))}}, LoadedPaths: []string{"SKILL.md"}}
}
func TestSkillObjectContextPreservesInlineBytesAndBindsSources(t *testing.T) {
	c := skillContextFixture()
	old, _ := CanonicalJSON(c)
	var roundtrip WorkbenchSkillContext
	if DecodeStrict(old, &roundtrip) != nil {
		t.Fatal("old context rejected")
	}
	got, _ := CanonicalJSON(roundtrip)
	if !bytes.Equal(old, got) || bytes.Contains(got, []byte("objects")) {
		t.Fatal("old context bytes changed")
	}
	c.Version = 2
	c.LoadedSkills = []WorkbenchLoadedSkill{}
	c.LoadedFiles = []WorkbenchLoadedSkillFile{}
	objects := []WorkbenchSkillObject{objectSkillFixture()}
	c.Objects = &objects
	if c.Validate() != nil {
		t.Fatal("valid object context rejected")
	}
	raw, _ := CanonicalJSON(c)
	if DecodeStrict(raw, &roundtrip) != nil || roundtrip.Validate() != nil {
		t.Fatal("object context did not roundtrip")
	}
	for _, mutate := range []func(*WorkbenchSkillContext){
		func(c *WorkbenchSkillContext) { c.Version = 1 },
		func(c *WorkbenchSkillContext) { c.Objects = nil },
		func(c *WorkbenchSkillContext) { (*c.Objects)[0].Source.ManifestKey = "https://other/secret" },
		func(c *WorkbenchSkillContext) {
			(*c.Objects)[0].Source.RevisionID = "11111111-1111-4111-8111-111111111111"
		},
		func(c *WorkbenchSkillContext) { (*c.Objects)[0].Source.TotalBytes++ },
		func(c *WorkbenchSkillContext) { (*c.Objects)[0].LoadedPaths = []string{} },
		func(c *WorkbenchSkillContext) {
			(*c.Objects)[0].LoadedPaths = append((*c.Objects)[0].LoadedPaths, "../secret")
		},
		func(c *WorkbenchSkillContext) { (*c.Objects)[0].Files[1].Path = "scripts/../secret" },
		func(c *WorkbenchSkillContext) {
			o := &(*c.Objects)[0]
			o.Files[1].Path = "references/a"
			child := o.Files[1]
			child.Path = "references/a/b"
			o.Files = append(o.Files, child)
			o.Source.TotalBytes += child.SizeBytes
		},
		func(c *WorkbenchSkillContext) { *c.Objects = append(*c.Objects, (*c.Objects)[0]) },
	} {
		var bad WorkbenchSkillContext
		if DecodeStrict(raw, &bad) != nil {
			t.Fatal("fixture")
		}
		mutate(&bad)
		if bad.Validate() == nil {
			t.Fatal("invalid object context accepted")
		}
	}
	p := WorkbenchProposal{Kind: "read_skill_file", SkillID: testSkillID, Path: "references/a.md"}
	if p.ValidateSkillBinding(c) != nil {
		t.Fatal("unread reference denied")
	}
	(*c.Objects)[0].LoadedPaths = append((*c.Objects)[0].LoadedPaths, p.Path)
	if p.ValidateSkillBinding(c) == nil {
		t.Fatal("repeat read accepted")
	}
}
