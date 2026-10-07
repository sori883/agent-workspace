package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

func sampleFixture() fixture {
	return fixture{Version: 1, Schema: "ax_workbench_probe_test", RootID: "11111111-1111-4111-8111-111111111111", Scenario: "csv-xlsx", Inputs: []native.WorkbenchFile{
		{Alias: "input_1", FileID: "22222222-2222-4222-8222-222222222222", Name: "sales.csv", SizeBytes: 15, SHA256: "ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b"},
		{Alias: "input_2", FileID: "33333333-3333-4333-8333-333333333333", Name: "sample.xlsx", SizeBytes: 4995, SHA256: "57fc8b3217b18140278226478ecb3ee1ebef5b27c8ad5f15cbb7a6aa15b8a8d6"},
	}}
}

func sampleClaim(f fixture, revision int) *controller.Claim {
	spec, _ := scenario(f.Scenario)
	d := native.WorkbenchDescriptor{Version: 2, RootID: f.RootID, Instruction: spec.instruction, DefinitionManifest: []native.DefinitionRef{}, Inputs: append([]native.WorkbenchFile{}, f.Inputs...), Outputs: []native.WorkbenchOutput{}, History: []native.WorkbenchHistory{}}
	w := &native.Workbench{Version: 2, AttemptKind: "runtime", Mode: "preview", ProfileID: gateway.PreviewProfileID, ExecutionPolicy: native.WorkbenchPolicy, RemainingMS: 300000}
	r := &native.WorkbenchRequest{SchemaVersion: 2, RunID: "ax-run-0123456789abcdef", RootID: f.RootID, Adapter: "interactive", CheckpointRevision: revision}
	if revision >= 2 {
		d.History = []native.WorkbenchHistory{{Kind: "user_start", Text: spec.instruction}, {Kind: "python", Text: spec.purpose}}
	}
	if revision == 2 {
		w.AttemptKind, r.Adapter = "python", "python"
		profile := native.CodeProfile
		d.CodeProfile = &profile
		raw, _ := native.CanonicalJSON(spec.proposal())
		code := json.RawMessage(raw)
		d.Code = &code
		d.Outputs = spec.descriptorOutputs()
	}
	if revision == 3 {
		d.History = append(d.History, native.WorkbenchHistory{Kind: "python_result", Text: "CSV total=300; Excel total=30"})
		for i, output := range spec.descriptorOutputs() {
			size, hash := 40, strings.Repeat("a", 64)
			if spec.byteCopy {
				size, hash = spec.inputs[i].SizeBytes, spec.inputs[i].SHA256
			}
			if i < len(spec.fixedOutputs) {
				size, hash = len(spec.fixedOutputs[i]), native.HashBytes([]byte(spec.fixedOutputs[i]))
			}
			d.Inputs = append(d.Inputs, native.WorkbenchFile{Alias: output.Alias, FileID: fmt.Sprintf("99999999-9999-4999-8999-%012d", i+1), Name: output.Name, SizeBytes: size, SHA256: hash})
		}
	}
	w.Descriptor = d
	rebind(w, r)
	return &controller.Claim{RunID: r.RunID, Generation: 1, Kind: "execute", Workbench: w, WorkbenchRequest: r, Effects: map[native.Operation]controller.Effect{}}
}

func rebind(w *native.Workbench, r *native.WorkbenchRequest) {
	raw, _ := native.CanonicalJSON(w.Descriptor)
	r.DescriptorSHA256 = native.HashBytes(raw)
}

func mailbox(t *testing.T, c *controller.Claim, tool bool) *native.Mailbox {
	t.Helper()
	kind, seq, body := "model", 1, map[string]any{"contents": []any{}}
	if tool {
		kind, seq, body = "tool", 2, pythonProposal()
	}
	raw, _ := json.Marshal(map[string]any{"version": 2, "run_id": c.RunID, "sequence": seq, "kind": kind, "body": body})
	wire, _ := json.Marshal(map[string]any{"request_base64": base64.StdEncoding.EncodeToString(raw), "sha256": native.HashBytes(raw)})
	m, err := native.ParseWorkbenchMailbox(wire, c.RunID)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

type fakeBackend struct {
	backend
	claim                   *controller.Claim
	reserves, settlements   int
	reserveLost, settleLost bool
	saved                   []byte
}

func (b *fakeBackend) Claim(context.Context) (*controller.Claim, error) { return b.claim, nil }
func (b *fakeBackend) Reserve(context.Context, *controller.Claim, *native.Mailbox) (controller.Reservation, error) {
	b.reserves++
	if b.reserveLost {
		return controller.Reservation{}, errors.New("unknown_reserve")
	}
	return controller.Reservation{Send: b.saved == nil, Response: b.saved, ProfileID: gateway.PreviewProfileID, InputLimit: 6000, OutputLimit: 512}, nil
}
func (b *fakeBackend) Settle(_ context.Context, _ *controller.Claim, _ *native.Mailbox, raw []byte, usage map[string]float64, _ int, _ gateway.Evidence) error {
	b.settlements++
	b.saved = raw
	if usage["model_call_count"] != 1 || usage["total_token_count"] != 120 {
		return errors.New("invalid_synthetic_usage")
	}
	if b.settleLost {
		return errors.New("unknown_settlement")
	}
	return nil
}

func TestProbeFixturePinsOnlyApprovedBinaryInputs(t *testing.T) {
	f := sampleFixture()
	if err := f.validate(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*fixture){func(f *fixture) { f.Schema = "public" }, func(f *fixture) { f.Scenario = "arbitrary-code" }, func(f *fixture) { f.Inputs[1].SHA256 = strings.Repeat("f", 64) }, func(f *fixture) { f.Inputs[1].SizeBytes++ }, func(f *fixture) { f.Inputs[0].Name = "other.csv" }, func(f *fixture) { f.Inputs[0].Alias = "input_9" }} {
		f = sampleFixture()
		change(&f)
		if f.validate() == nil {
			t.Fatal("unexpected fixture accepted")
		}
	}
}

func TestProbeRejectsPublicAndEnabledModelBeforeReadingCredentials(t *testing.T) {
	f := sampleFixture()
	config := `{"database":{"schema":"` + f.Schema + `"},"workbench":{"enabled":true,"python_enabled":true,"model_enabled":false},"interactive":{},"model_gateway":{"enabled":false}}`
	var value settings.File
	if json.Unmarshal([]byte(config), &value) != nil || validateConfig(value, f) != nil {
		t.Fatal("probe config rejected")
	}
	dir := t.TempDir()
	fixturePath, configPath := filepath.Join(dir, "fixture.json"), filepath.Join(dir, "config.json")
	raw, _ := json.Marshal(f)
	os.WriteFile(fixturePath, raw, 0600)
	for _, bad := range []string{strings.Replace(config, f.Schema, "public", 1), strings.Replace(config, `"model_enabled":false`, `"model_enabled":true`, 1), strings.Replace(config, `"model_gateway":{"enabled":false}`, `"model_gateway":{"enabled":true,"api_key_path":"/must-not-read"}`, 1)} {
		os.WriteFile(configPath, []byte(bad), 0600)
		var output bytes.Buffer
		if result := run([]string{"-config", configPath, "-fixture", fixturePath}, &output); result != 2 || output.String() != "{\"event\":\"probe_config_invalid\"}\n" {
			t.Fatalf("unsafe startup continued: %d %q", result, output.String())
		}
	}
}

func TestProbeIdleValidatesThenWaitsWithoutDatabaseOrNativeCredentials(t *testing.T) {
	f := sampleFixture()
	dir := t.TempDir()
	fixturePath, configPath := filepath.Join(dir, "fixture.json"), filepath.Join(dir, "config.json")
	raw, _ := json.Marshal(f)
	os.WriteFile(fixturePath, raw, 0600)
	os.WriteFile(configPath, []byte(`{"database":{"schema":"`+f.Schema+`","password_path":"/must-not-read"},"workbench":{"enabled":true,"python_enabled":true,"model_enabled":false},"interactive":{}}`), 0600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var output bytes.Buffer
	if code := runContext(ctx, []string{"-config", configPath, "-fixture", fixturePath, "-idle"}, &output); code != 0 || output.String() != "{\"event\":\"probe_idle_no_claim\"}\n" {
		t.Fatalf("idle contacted dependencies: %d %q", code, output.String())
	}
	f.Schema = "public"
	raw, _ = json.Marshal(f)
	os.WriteFile(fixturePath, raw, 0600)
	output.Reset()
	if code := runContext(ctx, []string{"-config", configPath, "-fixture", fixturePath, "-idle"}, &output); code != 2 {
		t.Fatal("idle bypassed static fixture checks")
	}
}

func TestProbeClaimAdmitsOnlyOnePinnedThreeAttemptRoot(t *testing.T) {
	f := sampleFixture()
	b := &fakeBackend{}
	p := &probeStore{backend: b, fixture: f}
	for revision := 1; revision <= 3; revision++ {
		b.claim = sampleClaim(f, revision)
		if _, err := p.Claim(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.Claim(context.Background()); err == nil {
		t.Fatal("fourth or repeated claim admitted")
	}
	for _, mutate := range []func(*controller.Claim){func(c *controller.Claim) { c.WorkbenchRequest.RootID = "99999999-9999-4999-8999-999999999999" }, func(c *controller.Claim) { c.Workbench.Mode = "model" }, func(c *controller.Claim) { c.Kind = "recovery" }, func(c *controller.Claim) { c.Workbench.Descriptor.Inputs[0].Name = "unexpected.csv" }, func(c *controller.Claim) { c.Effects[native.ResumeOperation] = controller.Effect{OperationID: "old"} }} {
		c := sampleClaim(f, 1)
		mutate(c)
		rebind(c.Workbench, c.WorkbenchRequest)
		b.claim, p.claims = c, 0
		if _, err := p.Claim(context.Background()); err == nil || b.reserves != 0 {
			t.Fatal("unexpected claim reached side effects")
		}
	}
}

func TestProbeSettlesSyntheticReplyBeforeNormalControllerReadback(t *testing.T) {
	for _, revision := range []int{1, 3} {
		f := sampleFixture()
		c := sampleClaim(f, revision)
		b := &fakeBackend{}
		p := &probeStore{backend: b, fixture: f}
		m := mailbox(t, c, false)
		r, err := p.Reserve(context.Background(), c, m)
		if err != nil || r.Send || b.reserves != 2 || b.settlements != 1 {
			t.Fatalf("settlement not read back: %v", err)
		}
		if _, err := native.ParseReply(r.Response, m); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(r.Response, []byte("STOP")) || revision == 1 && !bytes.Contains(r.Response, []byte("summary.xlsx")) || revision == 3 && !bytes.Contains(r.Response, []byte(complete)) {
			t.Fatal("unexpected proposal")
		}
		if _, err := p.Reserve(context.Background(), c, m); err != nil || b.settlements != 1 {
			t.Fatal("saved settlement was replaced")
		}
	}
}

func TestProbeUnknownReservationOrSettlementIsNeverRetried(t *testing.T) {
	for _, point := range []string{"reserve", "settle"} {
		f := sampleFixture()
		c := sampleClaim(f, 1)
		b := &fakeBackend{reserveLost: point == "reserve", settleLost: point == "settle"}
		p := &probeStore{backend: b, fixture: f}
		if _, err := p.Reserve(context.Background(), c, mailbox(t, c, false)); err == nil || b.reserves != 1 {
			t.Fatal("unknown response was retried")
		}
	}
}

func TestProbeToolProposalCannotChangeFixedSource(t *testing.T) {
	f := sampleFixture()
	c := sampleClaim(f, 1)
	b := &fakeBackend{}
	p := &probeStore{backend: b, fixture: f}
	m := mailbox(t, c, true)
	if _, err := p.Reserve(context.Background(), c, m); err != nil || b.settlements != 0 {
		t.Fatal("ordinary tool reservation changed")
	}
	m.Request.Body["source"] = json.RawMessage(`"print('unexpected')"`)
	if _, err := p.Reserve(context.Background(), c, m); err == nil || b.reserves != 1 {
		t.Fatal("modified tool reached PG")
	}
}

type fakeJobs struct{ calls, failAt, emptyAt int }

func (j *fakeJobs) RunOnce(context.Context) (bool, error) {
	j.calls++
	if j.calls == j.failAt {
		return true, errors.New("unknown")
	}
	return j.calls != j.emptyAt, nil
}

func TestProbeJobLoopNeverRetriesFailureOrMissingJob(t *testing.T) {
	for _, j := range []*fakeJobs{{failAt: 2}, {emptyAt: 2}} {
		if runJobs(context.Background(), j) == nil || j.calls != 2 {
			t.Fatal("job failure was retried")
		}
	}
	j := &fakeJobs{}
	if err := runJobs(context.Background(), j); err != nil || j.calls != 3 {
		t.Fatal("probe did not stop after three attempts")
	}
}

func TestProbeStageDiagnosticsDoNotExposeRawErrors(t *testing.T) {
	var got []string
	p := &probeStore{observe: func(stage, code string, revision int) {
		got = append(got, fmt.Sprintf("%s:%s:%d", stage, code, revision))
	}}
	p.event("tool_reserve", 1, controller.ErrGatewayDenied)
	p.event("model_settle", 1, errors.New("secret=must-not-appear"))
	if strings.Join(got, ",") != "tool_reserve:gateway_denied:1,model_settle:unconfirmed:1" {
		t.Fatal("unsafe or uninformative diagnostics")
	}
}
