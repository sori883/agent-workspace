package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/native"
)

func copyFixture(name string) fixture {
	f := sampleFixture()
	f.Scenario = name
	spec, _ := scenario(name)
	f.Inputs = spec.inputs
	for i := range f.Inputs {
		f.Inputs[i].FileID = fmt.Sprintf("77777777-7777-4777-8777-%012d", i+1)
	}
	return f
}

func copyBytes(i, size int) []byte {
	block := make([]byte, 256)
	for j := range block {
		block[j] = byte(j + 17*i)
	}
	return bytes.Repeat(block, (size+255)/256)[:size]
}

func TestCopyScenariosPinEightMiBInputAndOutputManifests(t *testing.T) {
	for _, name := range []string{"copy-8m-1", "copy-8m-4"} {
		t.Run(name, func(t *testing.T) {
			f := copyFixture(name)
			if err := f.validate(); err != nil {
				t.Fatal(err)
			}
			spec, _ := scenario(name)
			total, output := 0, 0
			for i, file := range spec.inputs {
				total += file.SizeBytes
				output += spec.outputs[i].SizeLimitBytes
				if native.HashBytes(copyBytes(i+1, file.SizeBytes)) != file.SHA256 {
					t.Fatal("fixture hash not reproducible")
				}
				if name == "copy-8m-4" && file.SizeBytes%32768 == 0 {
					t.Fatal("four-file case must cross partial chunk boundaries")
				}
			}
			if total != 8388608 || output != total {
				t.Fatal("copy quota changed")
			}
			proposal, _ := native.CanonicalJSON(spec.proposal())
			if _, err := native.ParseWorkbenchProposal(proposal); err != nil {
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
			bad := sampleClaim(f, 3)
			bad.Workbench.Descriptor.Inputs[len(f.Inputs)].SHA256 = strings.Repeat("f", 64)
			rebind(bad.Workbench, bad.WorkbenchRequest)
			if f.validateClaim(bad) == nil {
				t.Fatal("copied output with different bytes admitted")
			}
			bad = sampleClaim(f, 3)
			bad.Workbench.Descriptor.Inputs[len(f.Inputs)].SizeBytes--
			rebind(bad.Workbench, bad.WorkbenchRequest)
			if f.validateClaim(bad) == nil {
				t.Fatal("truncated copy admitted")
			}
			f.Inputs[0].SHA256 = strings.Repeat("f", 64)
			if f.validate() == nil {
				t.Fatal("arbitrary binary fixture admitted")
			}
		})
	}
}

func TestCopyScenarioReservationKeepsFixedSourceAndCompletion(t *testing.T) {
	for _, name := range []string{"copy-8m-1", "copy-8m-4"} {
		f := copyFixture(name)
		spec, _ := scenario(name)
		for _, revision := range []int{1, 3} {
			c := sampleClaim(f, revision)
			b := &fakeBackend{}
			p := &probeStore{backend: b, fixture: f}
			r, err := p.Reserve(context.Background(), c, mailbox(t, c, false))
			if err != nil || r.Send || b.settlements != 1 || b.reserves != 2 {
				t.Fatalf("%s revision %d: %v", name, revision, err)
			}
			want := "copy-output-1.csv"
			if revision == 3 {
				want = spec.complete
			}
			if !bytes.Contains(r.Response, []byte(want)) {
				t.Fatal("response scenario changed")
			}
		}
	}
}

func TestCopyPythonSourceProducesIdenticalEightMiBLocally(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is needed for the local fixed-source byte-copy check")
	}
	for _, name := range []string{"copy-8m-1", "copy-8m-4"} {
		t.Run(name, func(t *testing.T) {
			spec, _ := scenario(name)
			root := t.TempDir()
			input, output := filepath.Join(root, "input"), filepath.Join(root, "output")
			for _, dir := range []string{input, output} {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
			}
			for i, f := range spec.inputs {
				if err := os.WriteFile(filepath.Join(input, f.Alias), copyBytes(i+1, f.SizeBytes), 0600); err != nil {
					t.Fatal(err)
				}
			}
			in, _ := json.Marshal(input)
			out, _ := json.Marshal(output)
			local := strings.ReplaceAll(strings.ReplaceAll(spec.source, "Path('/input')", "Path("+string(in)+")"), "Path('/output')", "Path("+string(out)+")")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if result, err := exec.CommandContext(ctx, python, "-I", "-c", local).CombinedOutput(); err != nil {
				t.Fatalf("fixed source failed: %v: %s", err, result)
			}
			for i, file := range spec.outputs {
				got, err := os.ReadFile(filepath.Join(output, file.Name))
				if err != nil || len(got) != spec.inputs[i].SizeBytes || !bytes.Equal(got, copyBytes(i+1, len(got))) {
					t.Fatal("output bytes changed")
				}
			}
		})
	}
}
