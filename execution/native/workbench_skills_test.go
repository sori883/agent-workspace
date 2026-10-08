package native

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const testSkillID = "01925adc-a00f-4000-8000-000000000002"

func skillContextFixture() *WorkbenchSkillContext {
	content := "参照資料です。"
	ref := WorkbenchSkillFileRef{Path: "references/rules.md", SizeBytes: len(content), SHA256: HashBytes([]byte(content))}
	return &WorkbenchSkillContext{Version: 1, Catalog: []WorkbenchSkillSummary{{ID: testSkillID, Name: "sales-sum", Description: "売上の集計"}}, OmittedCount: 3,
		LoadedSkills: []WorkbenchLoadedSkill{{ID: testSkillID, Name: "sales-sum", Description: "売上の集計", Instructions: "部署別に集計してください。", Files: []WorkbenchSkillFileRef{ref}}},
		LoadedFiles:  []WorkbenchLoadedSkillFile{{SkillID: testSkillID, Path: ref.Path, Content: content, SizeBytes: ref.SizeBytes, SHA256: ref.SHA256}}, BuiltinSkillIDs: []string{}}
}

func TestWorkbenchSkillContextPreservesOldBytesAndChecksNewBinding(t *testing.T) {
	r, w := workbenchFixture(t)
	old, _ := CanonicalJSON(w.Descriptor)
	if bytes.Contains(old, []byte("skill_context")) {
		t.Fatal("old descriptor bytes changed")
	}
	var roundtrip WorkbenchDescriptor
	if DecodeStrict(old, &roundtrip) != nil {
		t.Fatal("legacy descriptor no longer decodes")
	}
	newBytes, _ := CanonicalJSON(roundtrip)
	if !bytes.Equal(old, newBytes) {
		t.Fatal("legacy descriptor hash changed")
	}
	w.Descriptor.SkillContext = skillContextFixture()
	bind := func() { raw, _ := CanonicalJSON(w.Descriptor); r.DescriptorSHA256 = HashBytes(raw) }
	bind()
	if err := w.Validate(r); err != nil {
		t.Fatal(err)
	}
	raw, _ := CanonicalJSON(w.Descriptor)
	if err := DecodeStrict(raw, &roundtrip); err != nil {
		t.Fatal("new descriptor rejected", err)
	}
	if roundtrip.SkillContext.Validate() != nil {
		t.Fatal("context did not round-trip")
	}
	for _, bad := range [][]byte{bytes.Replace(old, []byte(`"code":null`), []byte(`"skill_context":null,"code":null`), 1),
		bytes.Replace(raw, []byte(`"omitted_count":3`), []byte(`"omitted_count":3,"extra":1`), 1),
		bytes.Replace(raw, []byte(`"omitted_count":3,`), []byte{}, 1)} {
		if DecodeStrict(bad, &roundtrip) == nil {
			t.Fatal("invalid optional/context fields accepted")
		}
	}
	w.AttemptKind = "python"
	bind()
	if w.Validate(r) == nil {
		t.Fatal("skill body entered code task")
	}
}

func TestWorkbenchSkillContextRejectsMutationAndOversizedCatalog(t *testing.T) {
	mutations := []func(*WorkbenchSkillContext){
		func(c *WorkbenchSkillContext) { c.LoadedFiles[0].Content = "changed" },
		func(c *WorkbenchSkillContext) { c.LoadedFiles[0].SizeBytes++ },
		func(c *WorkbenchSkillContext) { c.LoadedSkills = nil },
		func(c *WorkbenchSkillContext) { c.LoadedSkills[0].Files[0].Path = "../outside" },
		func(c *WorkbenchSkillContext) { c.LoadedSkills[0].Name = "different" },
		func(c *WorkbenchSkillContext) { c.Catalog = append(c.Catalog, c.Catalog[0]) },
		func(c *WorkbenchSkillContext) { c.LoadedFiles = append(c.LoadedFiles, c.LoadedFiles[0]) },
		func(c *WorkbenchSkillContext) { c.BuiltinSkillIDs = []string{"unknown"} },
		func(c *WorkbenchSkillContext) { c.OmittedCount = -1 },
		func(c *WorkbenchSkillContext) { c.LoadedSkills[0].Instructions = strings.Repeat("x", 16385) },
	}
	for _, mutate := range mutations {
		c := skillContextFixture()
		mutate(c)
		if c.Validate() == nil {
			t.Fatal("invalid context accepted")
		}
	}
}

func TestWorkbenchSkillReadProposalOnlyAcceptsBoundUnreadContent(t *testing.T) {
	c := skillContextFixture()
	valid := `{"kind":"read_skill_file","skill_id":"` + testSkillID + `","path":"references/rules.md"}`
	p, err := ParseWorkbenchProposal([]byte(valid))
	if err != nil || p.ValidateSkillBinding(c) == nil {
		t.Fatal("already-read file was accepted", err)
	}
	c.LoadedFiles = []WorkbenchLoadedSkillFile{}
	if p.ValidateSkillBinding(c) != nil {
		t.Fatal("bound unread file was rejected")
	}
	for _, bad := range []string{strings.Replace(valid, "references/rules.md", "../secret", 1), strings.Replace(valid, `"path":`, `"extra":true,"path":`, 1),
		`{"kind":"read_skills","skill_ids":[]}`, `{"kind":"read_skills","skill_ids":["tabular-v1","tabular-v1"]}`, `{"kind":"read_skills","skill_ids":["unknown"]}`} {
		if _, err = ParseWorkbenchProposal([]byte(bad)); err == nil {
			t.Fatal("invalid read proposal accepted", bad)
		}
	}
	for _, id := range []string{testSkillID, "general-v1", "01925adc-a00f-4000-8000-000000000009"} {
		raw, _ := json.Marshal(map[string]any{"kind": "read_skills", "skill_ids": []string{id}})
		p, err = ParseWorkbenchProposal(raw)
		if err != nil || p.ValidateSkillBinding(c) == nil {
			t.Fatal("read must be unread and catalog-bound", id)
		}
	}
	p, err = ParseWorkbenchProposal([]byte(`{"kind":"read_skills","skill_ids":["tabular-v1"]}`))
	if err != nil || p.ValidateSkillBinding(c) != nil || p.ValidateSkillBinding(nil) == nil {
		t.Fatal("new/legacy skill boundary failed")
	}
}
