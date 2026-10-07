package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/sori883/agent-workspace/execution/native"
)

type scenarioSpec struct {
	instruction, purpose, complete, source string
	inputs                                 []native.WorkbenchFile
	outputs                                []native.PythonOutput
	byteCopy                               bool
	fixedOutputs                           []string
}

func scenario(name string) (scenarioSpec, error) {
	if name == "isolation-boundary" {
		return boundaryScenario(), nil
	}
	if name == "csv-xlsx" {
		return scenarioSpec{instruction: instruction, purpose: purpose, complete: complete, source: source,
			inputs: []native.WorkbenchFile{
				{Alias: "input_1", Name: "sales.csv", SizeBytes: 15, SHA256: "ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b"},
				{Alias: "input_2", Name: "sample.xlsx", SizeBytes: 4995, SHA256: "57fc8b3217b18140278226478ecb3ee1ebef5b27c8ad5f15cbb7a6aa15b8a8d6"},
			}, outputs: []native.PythonOutput{{Name: "summary.csv", SizeLimitBytes: 16384}, {Name: "summary.xlsx", SizeLimitBytes: 16384}}}, nil
	}
	var sizes []int
	var hashes []string
	var label, completion string
	switch name {
	case "copy-8m-1":
		sizes = []int{8388608}
		hashes = []string{"3480e36fd09a0e1fb7fc22645b44a0332ee0c2fd9cd6f62ef44fd76522b708fe"}
		label, completion = "single", "8 MiB byte copy (1 file) complete"
	case "copy-8m-4":
		sizes = []int{1048577, 2097155, 3145733, 2097143}
		hashes = []string{"e3888e3f3a005c89dfc8b9ace9330602fc2ddc0b7ea37f777b1c3a58d3c7bd57", "9dccddd4b541c44b1a02bb92152155d0cc64435925bb1e126b2d70495f655edb", "c2f3640378220cf9790b5ca0ad29ba5dcf36e3e246b80f9b298654be3f8c1542", "55e281daef11c8c13845a4f8825613a8eaf8eab5eaf680443a20109feb585c06"}
		label, completion = "four", "8 MiB byte copy (4 files) complete"
	default:
		return scenarioSpec{}, errors.New("probe_scenario_invalid")
	}
	s := scenarioSpec{instruction: "AX workbench isolated 8MiB " + label + "-copy probe v1", purpose: "probe:" + name + ":copy", complete: completion, byteCopy: true}
	rows := make([][]any, len(sizes))
	for i, size := range sizes {
		alias, input, output := fmt.Sprintf("input_%d", i+1), fmt.Sprintf("copy-input-%d.csv", i+1), fmt.Sprintf("copy-output-%d.csv", i+1)
		s.inputs = append(s.inputs, native.WorkbenchFile{Alias: alias, Name: input, SizeBytes: size, SHA256: hashes[i]})
		s.outputs = append(s.outputs, native.PythonOutput{Name: output, SizeLimitBytes: size})
		rows[i] = []any{alias, output, size, hashes[i]}
	}
	raw, _ := json.Marshal(rows)
	s.source = `from pathlib import Path
import hashlib
spec = ` + string(raw) + `
total = 0
for alias, name, size, digest in spec:
    original = Path('/input') / alias
    assert original.stat().st_size == size
    hasher = hashlib.sha256()
    copied = 0
    with original.open('rb') as src, (Path('/output') / name).open('xb') as dst:
        while chunk := src.read(32768):
            hasher.update(chunk)
            copied += len(chunk)
            assert copied <= size
            assert dst.write(chunk) == len(chunk)
    assert copied == size and hasher.hexdigest() == digest
    total += copied
assert total == 8388608
print('copy verified:', total, 'bytes;', len(spec), 'files')
`
	return s, nil
}

func (s scenarioSpec) proposal() map[string]any {
	aliases := make([]string, len(s.inputs))
	for i, file := range s.inputs {
		aliases[i] = file.Alias
	}
	return map[string]any{"kind": "python", "source": s.source, "input_aliases": aliases, "outputs": s.outputs, "purpose": s.purpose}
}

func (s scenarioSpec) descriptorOutputs() []native.WorkbenchOutput {
	result := make([]native.WorkbenchOutput, len(s.outputs))
	for i, output := range s.outputs {
		result[i] = native.WorkbenchOutput{Alias: fmt.Sprintf("output_2_%d", i+1), Name: output.Name, SizeLimitBytes: output.SizeLimitBytes}
	}
	return result
}
