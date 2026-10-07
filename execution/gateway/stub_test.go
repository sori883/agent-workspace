package gateway

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/sori883/agent-workspace/execution/native"
)

func TestStubProducesBoundedProposalWithoutNetworkConfiguration(t *testing.T) {
	for _, phase := range []string{"request", "answer"} {
		r := native.Request{SchemaVersion: 1, RunID: "ax-run-0123456789abcdef", Adapter: "interactive", Instruction: "確認用の文章", OutputName: "reply.txt", Inputs: map[string]string{"conversation.json": "[]"}}
		question := "null"
		if phase == "answer" {
			question = `"12345678-1234-1234-1234-123456789abc"`
		}
		r.Inputs["runtime.json"] = `{"version":1,"root_id":"12345678-1234-1234-1234-123456789abc","phase":"` + phase + `","question_id":` + question + `,"skill_id":"brief-v1","remaining_ms":90000}`
		raw := []byte(`{"version":1,"run_id":"` + r.RunID + `","sequence":1,"kind":"model","body":{"contents":[]}}`)
		hash := sha256.Sum256(raw)
		envelope, _ := json.Marshal(map[string]string{"request_base64": base64.StdEncoding.EncodeToString(raw), "sha256": hex.EncodeToString(hash[:])})
		m, err := native.ParseMailbox(envelope, r.RunID)
		if err != nil {
			t.Fatal(err)
		}
		data, usage, err := Respond(r, m)
		if err != nil {
			t.Fatal(err)
		}
		reply, err := native.ParseReply(data, m)
		if err != nil || usage["total_token_count"] != 120 || usage["model_call_count"] != 1 {
			t.Fatal("usage missing")
		}
		var response struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if json.Unmarshal(reply.Body["response"], &response) != nil || len(response.Candidates) != 1 {
			t.Fatal("response invalid")
		}
		p, err := native.ParseProposal([]byte(response.Candidates[0].Content.Parts[0].Text))
		if err != nil {
			t.Fatal(err)
		}
		if phase == "request" && p.Kind != "question" || phase == "answer" && (p.Kind != "output" || p.Text != r.Instruction) {
			t.Fatal("wrong proposal")
		}
	}
}
