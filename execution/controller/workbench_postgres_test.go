package controller

import (
	"encoding/json"
	"github.com/sori883/agent-workspace/execution/native"
	"os"
	"strings"
	"testing"
)

func TestWorkbenchClaimFromPostgresCanonicalFixture(t *testing.T) {
	raw, e := os.ReadFile("testdata/workbench-claim.json")
	if e != nil {
		t.Fatal(e)
	}
	claim, e := parseClaim(raw)
	if e != nil || claim.Workbench == nil || claim.Workbench.Descriptor.Instruction != "集計" {
		t.Fatal(e)
	}
	for _, bad := range []string{strings.Replace(string(raw), "集計", "変更", 1), strings.Replace(string(raw), `"atespace":"ax-runtime"`, `"atespace":"ax-code"`, 1), strings.Replace(string(raw), `"mode":"preview"`, `"mode":"preview","extra":1`, 1), strings.Replace(string(raw), `"schema_version":2`, `"schema_version":1`, 1)} {
		if _, e := parseClaim([]byte(bad)); e == nil {
			t.Fatal("invalid claim accepted")
		}
	}
}
func TestWorkbenchReservationKeeps512SeparateFromV1(t *testing.T) {
	c, _, _ := setupWorkbench(t, false)
	m := &native.Mailbox{Request: native.MailboxRequest{Version: 2, RunID: runID, Sequence: 1, Kind: "model"}}
	raw := []byte(`{"send":true,"response":null,"input_limit":6000,"output_limit":512,"profile_id":"preview-v1"}`)
	if _, e := parseReservation(raw, c.Store.(*workStore).claim, m); e != nil {
		t.Fatal(e)
	}
	old := &Claim{}
	if _, e := parseReservation(raw, old, m); e == nil {
		t.Fatal("old claim accepted v2 budget")
	}
}
func TestPublishedDefinitionsFromPostgresKeepByteHashes(t *testing.T) {
	raw, e := os.ReadFile("testdata/workbench-definitions.json")
	if e != nil {
		t.Fatal(e)
	}
	var data struct {
		Claim            json.RawMessage          `json:"claim"`
		DefinitionChunks []native.DefinitionChunk `json:"definition_chunks"`
	}
	if e = json.Unmarshal(raw, &data); e != nil {
		t.Fatal(e)
	}
	claim, e := parseClaim(data.Claim)
	if e != nil {
		t.Fatal(e)
	}
	if len(claim.Workbench.Descriptor.DefinitionManifest) != 2 || len(data.DefinitionChunks) != 2 {
		t.Fatal("manifest missing")
	}
	for i, part := range data.DefinitionChunks {
		ref := claim.Workbench.Descriptor.DefinitionManifest[i]
		b, e := native.DecodeChunk(part.ContentBase64, ref.SizeBytes)
		if e != nil || native.HashBytes(b) != ref.SHA256 || part.VersionID != ref.ID || part.Kind != ref.Kind {
			t.Fatal("published content identity changed")
		}
	}
}

func TestWorkbenchClaimAcceptsBoundSkillContextWithoutDefinitionTransfer(t *testing.T) {
	raw, err := os.ReadFile("testdata/workbench-claim.json")
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if json.Unmarshal(raw, &wire) != nil {
		t.Fatal("fixture malformed")
	}
	var workbench native.Workbench
	var request native.WorkbenchRequest
	if native.DecodeStrict(wire["workbench"], &workbench) != nil || native.DecodeStrict(wire["request"], &request) != nil {
		t.Fatal("fixture did not decode")
	}
	workbench.Descriptor.SkillContext = &native.WorkbenchSkillContext{Version: 1,
		Catalog:      []native.WorkbenchSkillSummary{{ID: "01925adc-a00f-4000-8000-000000000002", Name: "sales-sum", Description: "集計"}},
		LoadedSkills: []native.WorkbenchLoadedSkill{}, LoadedFiles: []native.WorkbenchLoadedSkillFile{}, BuiltinSkillIDs: []string{}}
	descriptor, err := native.CanonicalJSON(workbench.Descriptor)
	if err != nil {
		t.Fatal(err)
	}
	request.DescriptorSHA256 = native.HashBytes(descriptor)
	wire["workbench"], _ = json.Marshal(workbench)
	wire["request"], _ = json.Marshal(request)
	raw, _ = json.Marshal(wire)
	claim, err := parseClaim(raw)
	if err != nil || claim.Workbench.Descriptor.SkillContext == nil || len(claim.Workbench.Descriptor.DefinitionManifest) != 0 {
		t.Fatal("new catalog claim lost its binding", err)
	}
	if _, err = parseClaim([]byte(strings.Replace(string(raw), "sales-sum", "changed", 1))); err == nil {
		t.Fatal("catalog mutation bypassed descriptor hash")
	}
}
