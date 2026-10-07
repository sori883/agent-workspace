package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"regexp"
	"time"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

const instruction = "AX workbench isolated tabular probe v1"
const purpose = "probe:csv-xlsx:calculate"
const complete = "CSV total=300; Excel total=30; probe complete"
const source = `import csv
import io
from pathlib import Path
from openpyxl import load_workbook, Workbook
rows = list(csv.reader(io.StringIO(Path('/input/input_1').read_text())))
assert rows == [['amount'], ['100'], ['200']]
book = load_workbook(io.BytesIO(Path('/input/input_2').read_bytes()), read_only=True, data_only=True)
values = list(book.active.values)
assert values == [('amount',), (10,), (20,)]
csv_total = sum(int(row[0]) for row in rows[1:])
excel_total = sum(row[0] for row in values[1:])
book.close()
assert (csv_total, excel_total) == (300, 30)
Path('/output/summary.csv').write_text(f'source,total\nsales.csv,{csv_total}\nsample.xlsx,{excel_total}\n')
result = Workbook()
for row in [('source', 'total'), ('sales.csv', csv_total), ('sample.xlsx', excel_total)]:
    result.active.append(row)
result.save('/output/summary.xlsx')
print('CSV total=300; Excel total=30')
`

var schemaPattern = regexp.MustCompile(`^ax_workbench_probe_[a-z0-9_]{1,44}$`)
var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type fixture struct {
	Version  int                    `json:"version"`
	Schema   string                 `json:"schema"`
	RootID   string                 `json:"root_id"`
	Scenario string                 `json:"scenario"`
	Inputs   []native.WorkbenchFile `json:"inputs"`
}

func loadFixture(path string) (fixture, error) {
	var f fixture
	file, err := os.Open(path)
	if err != nil {
		return f, errors.New("probe_fixture_invalid")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
		return f, errors.New("probe_fixture_invalid")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(raw) > 65536 || native.DecodeStrict(raw, &f) != nil || f.validate() != nil {
		return f, errors.New("probe_fixture_invalid")
	}
	return f, nil
}

func (f fixture) validate() error {
	spec, err := scenario(f.Scenario)
	if err != nil || f.Version != 1 || !schemaPattern.MatchString(f.Schema) || !uuidPattern.MatchString(f.RootID) || len(f.Inputs) != len(spec.inputs) {
		return errors.New("probe_fixture_invalid")
	}
	want, seen := spec.inputs, map[string]bool{}
	for i, input := range f.Inputs {
		want[i].FileID = input.FileID
		if !uuidPattern.MatchString(input.FileID) || seen[input.FileID] || input != want[i] {
			return errors.New("probe_fixture_invalid")
		}
		seen[input.FileID] = true
	}
	return nil
}

func validateConfig(config settings.File, f fixture) error {
	if f.validate() != nil || config.Database == nil || config.Database.Schema != f.Schema || config.Workbench == nil || !config.Workbench.Enabled || !config.Workbench.PythonEnabled || config.Workbench.ModelEnabled || config.ModelGateway != nil && config.ModelGateway.Enabled || config.Interactive == nil {
		return errors.New("probe_config_invalid")
	}
	return nil
}

func pythonProposal() map[string]any {
	spec, _ := scenario("csv-xlsx")
	return spec.proposal()
}

func (f fixture) validateClaim(c *controller.Claim) error {
	if c == nil || c.Kind != "execute" || c.Workbench == nil || c.WorkbenchRequest == nil || c.Workbench.Mode != "preview" || c.Workbench.ProfileID != gateway.PreviewProfileID || c.Workbench.Validate(*c.WorkbenchRequest) != nil || c.WorkbenchRequest.RootID != f.RootID || c.RunID != c.WorkbenchRequest.RunID {
		return errors.New("probe_claim_invalid")
	}
	w, r := c.Workbench, c.WorkbenchRequest
	d := w.Descriptor
	spec, err := scenario(f.Scenario)
	if err != nil {
		return err
	}
	n := len(f.Inputs)
	if d.Instruction != spec.instruction || len(d.DefinitionManifest) != 0 || len(d.Inputs) < n || !reflect.DeepEqual(d.Inputs[:n], f.Inputs) {
		return errors.New("probe_claim_invalid")
	}
	switch r.CheckpointRevision {
	case 1:
		if w.AttemptKind != "runtime" || len(d.Inputs) != n || len(d.History) > 1 || len(d.History) == 1 && d.History[0] != (native.WorkbenchHistory{Kind: "user_start", Text: spec.instruction}) {
			return errors.New("probe_claim_invalid")
		}
	case 2:
		want, _ := native.CanonicalJSON(spec.proposal())
		if w.AttemptKind != "python" || len(d.Inputs) != n || d.Code == nil || !sameJSON(*d.Code, want) || !reflect.DeepEqual(d.Outputs, spec.descriptorOutputs()) || len(d.History) != 2 {
			return errors.New("probe_claim_invalid")
		}
	case 3:
		if w.AttemptKind != "runtime" || len(d.Inputs) != n+len(spec.outputs) || len(d.History) != 3 || d.History[2].Kind != "python_result" {
			return errors.New("probe_claim_invalid")
		}
		for i, output := range spec.descriptorOutputs() {
			actual := d.Inputs[n+i]
			if actual.Alias != output.Alias || actual.Name != output.Name || actual.SizeBytes > output.SizeLimitBytes || spec.byteCopy && (actual.SizeBytes != f.Inputs[i].SizeBytes || actual.SHA256 != f.Inputs[i].SHA256) {
				return errors.New("probe_claim_invalid")
			}
			if i < len(spec.fixedOutputs) && (actual.SizeBytes != len(spec.fixedOutputs[i]) || actual.SHA256 != native.HashBytes([]byte(spec.fixedOutputs[i]))) {
				return errors.New("probe_claim_invalid")
			}
		}
	default:
		return errors.New("probe_claim_invalid")
	}
	if r.CheckpointRevision > 1 && (d.History[0] != (native.WorkbenchHistory{Kind: "user_start", Text: spec.instruction}) || d.History[1] != (native.WorkbenchHistory{Kind: "python", Text: spec.purpose})) {
		return errors.New("probe_claim_invalid")
	}
	return nil
}

func sameJSON(a, b []byte) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

type backend interface {
	controller.Store
	controller.WorkbenchStore
}

type probeStore struct {
	backend
	fixture fixture
	claims  int
	observe func(string, string, int)
}

func (p *probeStore) event(stage string, revision int, err error) {
	if p.observe == nil {
		return
	}
	code := "unconfirmed"
	switch {
	case err == nil:
		code = "ok"
	case errors.Is(err, controller.ErrGatewayDenied):
		code = "gateway_denied"
	case errors.Is(err, controller.ErrAuthorizationRevoked):
		code = "authorization_revoked"
	case errors.Is(err, controller.ErrHeld):
		code = "held"
	case errors.Is(err, context.Canceled):
		code = "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		code = "deadline"
	}
	p.observe(stage, code, revision)
}

func (p *probeStore) Claim(ctx context.Context) (*controller.Claim, error) {
	c, err := p.backend.Claim(ctx)
	if err != nil || c == nil {
		p.event("claim", 0, err)
		return c, err
	}
	if p.fixture.validateClaim(c) != nil || c.WorkbenchRequest.CheckpointRevision != p.claims+1 || len(c.Effects) != 0 || c.WorkbenchResult != nil {
		p.event("claim", 0, errors.New("probe_claim_invalid"))
		return nil, errors.New("probe_claim_invalid")
	}
	p.claims++
	p.event("claim", p.claims, nil)
	return c, nil
}

func (p *probeStore) Reserve(ctx context.Context, c *controller.Claim, m *native.Mailbox) (controller.Reservation, error) {
	if p.fixture.validateClaim(c) != nil || m == nil || m.Request.Version != 2 || m.Request.RunID != c.RunID {
		return controller.Reservation{}, errors.New("probe_mailbox_invalid")
	}
	spec, _ := scenario(p.fixture.Scenario)
	if m.Request.Kind == "tool" && m.Request.Sequence == 2 {
		want := spec.proposal()
		if c.WorkbenchRequest.CheckpointRevision == 3 {
			want = map[string]any{"kind": "output", "text": spec.complete}
		}
		raw, _ := native.CanonicalJSON(m.Request.Body)
		expected, _ := native.CanonicalJSON(want)
		if !bytes.Equal(raw, expected) {
			return controller.Reservation{}, errors.New("probe_proposal_invalid")
		}
	} else if m.Request.Kind != "model" || m.Request.Sequence != 1 {
		return controller.Reservation{}, errors.New("probe_mailbox_invalid")
	}
	r, err := p.backend.Reserve(ctx, c, m)
	p.event(m.Request.Kind+"_reserve", c.WorkbenchRequest.CheckpointRevision, err)
	if err != nil || !r.Send || m.Request.Kind != "model" {
		return r, err
	}
	if m.Request.Sequence != 1 || c.Workbench.AttemptKind != "runtime" {
		return controller.Reservation{}, errors.New("probe_mailbox_invalid")
	}
	raw, usage, err := gateway.RespondWorkbench(*c.WorkbenchRequest, *c.Workbench, m)
	if err != nil {
		return controller.Reservation{}, err
	}
	var reply native.MailboxReply
	if native.DecodeStrict(raw, &reply) != nil {
		return controller.Reservation{}, errors.New("probe_response_invalid")
	}
	proposal := spec.proposal()
	if c.WorkbenchRequest.CheckpointRevision == 3 {
		proposal = map[string]any{"kind": "output", "text": spec.complete}
	}
	text, _ := json.Marshal(proposal)
	reply.Body["response"], _ = json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]string{"text": string(text)}}}, "finishReason": "STOP"}}, "usageMetadata": map[string]int{"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120}, "modelVersion": gateway.Model})
	raw, err = json.Marshal(reply)
	if err != nil {
		return controller.Reservation{}, err
	}
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	err = p.backend.Settle(settle, c, m, raw, usage, 0, gateway.Evidence{Outcome: "ok", Code: "ok"})
	cancel()
	p.event("model_settle", c.WorkbenchRequest.CheckpointRevision, err)
	if err != nil {
		return controller.Reservation{}, err
	}
	result, err := p.backend.Reserve(ctx, c, m)
	if err != nil || result.Send || !sameJSON(result.Response, raw) {
		p.event("model_readback", c.WorkbenchRequest.CheckpointRevision, errors.New("probe_settlement_unconfirmed"))
		return controller.Reservation{}, errors.New("probe_settlement_unconfirmed")
	}
	p.event("model_readback", c.WorkbenchRequest.CheckpointRevision, nil)
	return result, nil
}
