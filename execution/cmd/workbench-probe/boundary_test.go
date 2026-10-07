package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/native"
)

func TestBoundaryScenarioPinsSourceInputAndOutput(t *testing.T) {
	f := copyFixture("isolation-boundary")
	spec, err := scenario(f.Scenario)
	if err != nil || f.validate() != nil || len(spec.source) > 4096 || len(spec.inputs) != 1 || spec.outputs[0].Name != "boundary.csv" {
		t.Fatal("invalid boundary scenario")
	}
	raw, _ := native.CanonicalJSON(spec.proposal())
	if _, err = native.ParseWorkbenchProposal(raw); err != nil {
		t.Fatal(err)
	}
	b := &fakeBackend{}
	p := &probeStore{backend: b, fixture: f}
	for revision := 1; revision <= 3; revision++ {
		b.claim = sampleClaim(f, revision)
		if _, err := p.Claim(context.Background()); err != nil {
			t.Fatalf("revision %d: %v", revision, err)
		}
	}
	for _, size := range []bool{false, true} {
		c := sampleClaim(f, 3)
		if size {
			c.Workbench.Descriptor.Inputs[1].SizeBytes--
		} else {
			c.Workbench.Descriptor.Inputs[1].SHA256 = strings.Repeat("f", 64)
		}
		rebind(c.Workbench, c.WorkbenchRequest)
		if f.validateClaim(c) == nil {
			t.Fatal("nonmatching boundary output accepted")
		}
	}
	c := sampleClaim(f, 2)
	changed := bytes.Replace(*c.Workbench.Descriptor.Code, []byte("65532"), []byte("0"), 1)
	c.Workbench.Descriptor.Code = (*json.RawMessage)(&changed)
	rebind(c.Workbench, c.WorkbenchRequest)
	if f.validateClaim(c) == nil {
		t.Fatal("modified boundary source accepted")
	}
}

func TestBoundaryReservationIsFixedAndLostSettlementNotRetried(t *testing.T) {
	f := copyFixture("isolation-boundary")
	for _, lost := range []bool{false, true} {
		for _, revision := range []int{1, 3} {
			b := &fakeBackend{settleLost: lost}
			p := &probeStore{backend: b, fixture: f}
			c := sampleClaim(f, revision)
			r, err := p.Reserve(context.Background(), c, mailbox(t, c, false))
			if lost {
				if err == nil || b.reserves != 1 || b.settlements != 1 {
					t.Fatal("unknown settlement resent")
				}
				continue
			}
			want := "boundary.csv"
			if revision == 3 {
				want = "Isolation boundary checks complete"
			}
			if err != nil || r.Send || b.reserves != 2 || b.settlements != 1 || !bytes.Contains(r.Response, []byte(want)) {
				t.Fatal("boundary response changed")
			}
		}
	}
}

func TestBoundaryPythonOnlyCompilesAndPinsOutputLiteral(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is needed for syntax-only validation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	program := `import ast,json,sys
source=sys.stdin.read()
assert len(source.encode())<=4096
tree=ast.parse(source)
compile(tree,'boundary-source','exec')
values=[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,bytes) and n.value.startswith(b'check,result\n')]
assert len(values)==1
print(json.dumps(values[0].decode('ascii')))
`
	cmd := exec.CommandContext(ctx, python, "-I", "-c", program)
	cmd.Stdin = strings.NewReader(boundarySource)
	output, err := cmd.CombinedOutput()
	var value string
	if err != nil || json.Unmarshal(output, &value) != nil || value != boundaryOutput {
		t.Fatalf("boundary syntax or output mismatch: %v %s", err, output)
	}
	t.Logf("source_bytes=%d output_bytes=%d output_sha256=%s", len(boundarySource), len(boundaryOutput), native.HashBytes([]byte(boundaryOutput)))
}
