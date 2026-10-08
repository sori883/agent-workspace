package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/sori883/agent-workspace/execution/native"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func workbenchPreparedFixture(t *testing.T, discovery ...bool) Prepared {
	t.Helper()
	root := "11111111-1111-4111-8111-111111111111"
	w := native.Workbench{Version: 2, AttemptKind: "runtime", ExecutionPolicy: native.WorkbenchPolicy, Mode: "model", ProfileID: ProfileID, RemainingMS: 300000,
		Descriptor: native.WorkbenchDescriptor{Version: 2, RootID: root, Instruction: "sum", DefinitionManifest: []native.DefinitionRef{}, Inputs: []native.WorkbenchFile{}, Outputs: []native.WorkbenchOutput{}, History: []native.WorkbenchHistory{}}}
	if len(discovery) > 0 && discovery[0] {
		w.Descriptor.SkillContext = &native.WorkbenchSkillContext{Version: 1, Catalog: []native.WorkbenchSkillSummary{}, LoadedSkills: []native.WorkbenchLoadedSkill{}, LoadedFiles: []native.WorkbenchLoadedSkillFile{}, BuiltinSkillIDs: []string{}}
	}
	descriptor, err := native.CanonicalJSON(w.Descriptor)
	if err != nil {
		t.Fatal(err)
	}
	r := native.WorkbenchRequest{SchemaVersion: 2, RunID: "ax-run-0123456789abcdef", RootID: root, Adapter: "interactive", DescriptorSHA256: native.HashBytes(descriptor)}
	m := &native.Mailbox{Request: native.MailboxRequest{Version: 2, RunID: r.RunID, Kind: "model", Sequence: 1, Body: map[string]json.RawMessage{"contents": json.RawMessage(`[{"role":"user","parts":[{"text":"sum"}]}]`), "systemInstruction": json.RawMessage(`{"parts":[{"text":"fixed"}]}`)}}}
	p, err := PrepareWorkbench(r, w, m, Limits{6000, 512})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWorkbenchSkillSchemaAddsOnlyReadBranchesWithKindFirst(t *testing.T) {
	p := workbenchPreparedFixture(t, true)
	var payload struct {
		Config struct {
			Schema struct {
				AnyOf []struct {
					Properties json.RawMessage `json:"properties"`
					Required   []string        `json:"required"`
					Additional bool            `json:"additionalProperties"`
				} `json:"anyOf"`
			} `json:"responseJsonSchema"`
		} `json:"generationConfig"`
	}
	if json.Unmarshal(p.Payload, &payload) != nil || len(payload.Config.Schema.AnyOf) != 4 {
		t.Fatal("missing skill read schema")
	}
	for index, want := range [][]string{{"kind", "skill_ids"}, {"kind", "skill_id", "path"}} {
		branch := payload.Config.Schema.AnyOf[index+2]
		decoder := json.NewDecoder(bytes.NewReader(branch.Properties))
		decoder.Token()
		var keys []string
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				t.Fatal(err)
			}
			keys = append(keys, token.(string))
			var value any
			if decoder.Decode(&value) != nil {
				t.Fatal("invalid property")
			}
		}
		if !reflect.DeepEqual(keys, want) || !reflect.DeepEqual(branch.Required, want) || branch.Additional {
			t.Fatal("read schema order/shape changed", keys)
		}
	}
}

func TestWorkbenchPreviewIsGenericAndSkillReadsNeedContext(t *testing.T) {
	root := "11111111-1111-4111-8111-111111111111"
	w := native.Workbench{Version: 2, AttemptKind: "runtime", ExecutionPolicy: native.WorkbenchPolicy, Mode: "preview", ProfileID: PreviewProfileID, RemainingMS: 300000,
		Descriptor: native.WorkbenchDescriptor{Version: 2, RootID: root, Instruction: "こんにちは", DefinitionManifest: []native.DefinitionRef{}, Inputs: []native.WorkbenchFile{}, Outputs: []native.WorkbenchOutput{}, History: []native.WorkbenchHistory{}}}
	raw, _ := native.CanonicalJSON(w.Descriptor)
	r := native.WorkbenchRequest{SchemaVersion: 2, RunID: "ax-run-0123456789abcdef", RootID: root, Adapter: "interactive", DescriptorSHA256: native.HashBytes(raw)}
	m := &native.Mailbox{Request: native.MailboxRequest{Version: 2, RunID: r.RunID, Sequence: 1, Kind: "model"}}
	reply, _, err := RespondWorkbench(r, w, m)
	if err != nil || bytes.Contains(reply, []byte("集計したい列")) || !bytes.Contains(reply, []byte("操作確認")) {
		t.Fatal("preview still assumes file aggregation", err)
	}
	m.Request.Kind = "tool"
	m.Request.Sequence = 2
	m.Request.Body = map[string]json.RawMessage{"kind": json.RawMessage(`"read_skills"`), "skill_ids": json.RawMessage(`["tabular-v1"]`)}
	if _, _, err = RespondWorkbench(r, w, m); err == nil {
		t.Fatal("legacy runtime obtained skill read capability")
	}
}

func TestWorkbenchWireSchemaChoosesKindBeforeBranchSpecificFields(t *testing.T) {
	p := workbenchPreparedFixture(t)
	var payload struct {
		Config struct {
			Schema struct {
				AnyOf []struct {
					Properties json.RawMessage `json:"properties"`
				} `json:"anyOf"`
			} `json:"responseJsonSchema"`
		} `json:"generationConfig"`
	}
	if json.Unmarshal(p.Payload, &payload) != nil || len(payload.Config.Schema.AnyOf) != 2 {
		t.Fatal("missing workbench branches in serialized provider payload")
	}
	want := [][]string{{"kind", "text"}, {"kind", "source", "input_aliases", "outputs", "purpose"}}
	for i, branch := range payload.Config.Schema.AnyOf {
		decoder := json.NewDecoder(bytes.NewReader(branch.Properties))
		if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
			t.Fatal("properties is not an object")
		}
		var keys []string
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				t.Fatal(err)
			}
			keys = append(keys, key.(string))
			var value json.RawMessage
			if err = decoder.Decode(&value); err != nil {
				t.Fatal(err)
			}
		}
		if !reflect.DeepEqual(keys, want[i]) {
			t.Errorf("branch %d provider property order: got %v want %v", i, keys, want[i])
		}
	}
}

func TestWorkbenchSchemaOrderChangePreservesAllowedShapesAndLimits(t *testing.T) {
	const previous = `{"anyOf":[{"type":"object","properties":{"kind":{"type":"string","enum":["question","output","unsupported"]},"text":{"type":"string","minLength":1,"maxLength":2048}},"required":["kind","text"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","enum":["python"]},"source":{"type":"string","minLength":1,"maxLength":4096},"input_aliases":{"type":"array","items":{"type":"string"},"maxItems":4},"outputs":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","properties":{"name":{"type":"string"},"size_limit_bytes":{"type":"integer","minimum":1,"maximum":8388608}},"required":["name","size_limit_bytes"],"additionalProperties":false}},"purpose":{"type":"string","minLength":1,"maxLength":2048}},"required":["kind","source","input_aliases","outputs","purpose"],"additionalProperties":false}]}`
	p := workbenchPreparedFixture(t)
	var payload struct {
		Config struct {
			Schema json.RawMessage `json:"responseJsonSchema"`
		} `json:"generationConfig"`
	}
	var before, after any
	if json.Unmarshal(p.Payload, &payload) != nil || json.Unmarshal([]byte(previous), &before) != nil || json.Unmarshal(payload.Config.Schema, &after) != nil {
		t.Fatal("schema could not be decoded")
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("ordered schema changed the accepted shapes, required fields, or limits")
	}
}

func TestWorkbenchOrderedPayloadIsIdenticalForCountAndGenerate(t *testing.T) {
	p := workbenchPreparedFixture(t)
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		switch r.URL.Path {
		case modelPath + ":countTokens":
			var wrapper struct {
				Request map[string]json.RawMessage `json:"generateContentRequest"`
			}
			if json.Unmarshal(body, &wrapper) != nil {
				t.Error("invalid count wrapper")
			}
			delete(wrapper.Request, "model")
			counted, err := json.Marshal(wrapper.Request)
			if err != nil || !bytes.Equal(counted, p.Payload) || native.HashBytes(counted) != p.SHA256 {
				t.Error("count reordered or changed the prepared schema")
			}
			io.WriteString(w, `{"totalTokens":100}`)
		case modelPath + ":generateContent":
			if !bytes.Equal(body, p.Payload) || native.HashBytes(body) != p.SHA256 {
				t.Error("generate reordered or changed the prepared schema")
			}
			io.WriteString(w, validResponse())
		default:
			t.Error("unexpected provider request")
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	g := NewGemini(func() (string, error) { return "synthetic-test-key", nil })
	g.base = server.URL
	count, err := g.Count(context.Background(), p)
	if err != nil || count != 100 {
		t.Fatal("count failed", err)
	}
	result, err := g.Generate(context.Background(), p, Limits{6000, 512})
	if err != nil || result.Evidence.Outcome != "ok" || result.Evidence.PayloadSHA256 == nil || *result.Evidence.PayloadSHA256 != p.SHA256 {
		t.Fatal("generate or payload evidence failed", err)
	}
	if !reflect.DeepEqual(calls, []string{modelPath + ":countTokens", modelPath + ":generateContent"}) {
		t.Fatal("count or generate was retried")
	}
}

func TestWorkbenchLimitsAreSeparateFromLegacy(t *testing.T) {
	m := &native.Mailbox{Request: native.MailboxRequest{Version: 2, RunID: "ax-run-0123456789abcdef", Kind: "model", Sequence: 1, Body: map[string]json.RawMessage{"contents": json.RawMessage(`[{"role":"user","parts":[{"text":"sum"}]}]`), "systemInstruction": json.RawMessage(`{"parts":[{"text":"fixed"}]}`)}}}
	p, e := prepareMailbox(m, Limits{6000, 512}, "workbench", 2)
	if e != nil || p.Version != 2 {
		t.Fatal(e)
	}
	var payload map[string]any
	json.Unmarshal(p.Payload, &payload)
	config := payload["generationConfig"].(map[string]any)
	if config["maxOutputTokens"] != float64(512) || config["responseJsonSchema"].(map[string]any)["anyOf"] == nil {
		t.Fatal("v2 proposal missing")
	}
	if _, e = prepareMailbox(m, Limits{6000, 512}, "request", 1); e == nil {
		t.Fatal("v1 output cap widened")
	}
	if _, e = prepareMailbox(m, Limits{6001, 512}, "workbench", 2); e == nil {
		t.Fatal("input cap widened")
	}
	m.Request.Body["tools"] = json.RawMessage(`[{"functionDeclarations":[]}]`)
	if _, e = prepareMailbox(m, Limits{6000, 512}, "workbench", 2); e == nil {
		t.Fatal("unapproved SDK tools enabled")
	}
}
