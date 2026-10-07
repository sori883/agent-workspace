package gateway

import (
	"encoding/json"
	"errors"
	"github.com/sori883/agent-workspace/execution/native"
)

func PrepareWorkbench(r native.WorkbenchRequest, w native.Workbench, m *native.Mailbox, l Limits) (Prepared, error) {
	if w.Validate(r) != nil || m == nil || m.Request.Version != 2 || m.Request.Kind != "model" || m.Request.RunID != r.RunID {
		return Prepared{}, errors.New("model_request_invalid")
	}
	return prepareMailbox(m, l, "workbench", 2)
}
func workbenchResponseSchema() map[string]any {
	textProperties := struct {
		Kind map[string]any `json:"kind"`
		Text map[string]any `json:"text"`
	}{
		Kind: map[string]any{"type": "string", "enum": []string{"question", "output", "unsupported"}},
		Text: map[string]any{"type": "string", "minLength": 1, "maxLength": 2048},
	}
	pythonProperties := struct {
		Kind         map[string]any `json:"kind"`
		Source       map[string]any `json:"source"`
		InputAliases map[string]any `json:"input_aliases"`
		Outputs      map[string]any `json:"outputs"`
		Purpose      map[string]any `json:"purpose"`
	}{
		Kind:         map[string]any{"type": "string", "enum": []string{"python"}},
		Source:       map[string]any{"type": "string", "minLength": 1, "maxLength": 4096},
		InputAliases: map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 4},
		Outputs: map[string]any{"type": "array", "minItems": 1, "maxItems": 4, "items": map[string]any{
			"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}, "size_limit_bytes": map[string]any{"type": "integer", "minimum": 1, "maximum": 8388608}},
			"required": []string{"name", "size_limit_bytes"}, "additionalProperties": false}},
		Purpose: map[string]any{"type": "string", "minLength": 1, "maxLength": 2048},
	}
	return map[string]any{"anyOf": []any{
		map[string]any{"type": "object", "properties": textProperties, "required": []string{"kind", "text"}, "additionalProperties": false},
		map[string]any{"type": "object", "properties": pythonProperties, "required": []string{"kind", "source", "input_aliases", "outputs", "purpose"}, "additionalProperties": false},
	}}
}
func RespondWorkbench(r native.WorkbenchRequest, w native.Workbench, m *native.Mailbox) ([]byte, map[string]float64, error) {
	if w.Validate(r) != nil || m == nil || m.Request.Version != 2 || m.Request.RunID != r.RunID {
		return nil, nil, errors.New("invalid_gateway_request")
	}
	reply := native.MailboxReply{Version: 2, RunID: r.RunID, Sequence: m.Request.Sequence, RequestSHA256: m.SHA256, Status: "ok", Body: map[string]json.RawMessage{}}
	usage := map[string]float64{}
	if m.Request.Kind == "tool" {
		raw, _ := json.Marshal(m.Request.Body)
		if _, e := native.ParseWorkbenchProposal(raw); e != nil {
			return nil, nil, e
		}
		reply.Body["accepted"] = json.RawMessage("true")
	} else if m.Request.Kind == "model" {
		proposal := map[string]any{"kind": "question", "text": "集計したい列と出力形式を教えてください。"}
		if len(w.Descriptor.History) > 0 {
			proposal = map[string]any{"kind": "output", "text": "無料の固定応答です。登録内容とファイル参照を確認しました。"}
		}
		text, _ := json.Marshal(proposal)
		reply.Body["response"], _ = json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]string{"text": string(text)}}}, "finishReason": "STOP"}}, "usageMetadata": map[string]int{"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120}, "modelVersion": Model})
		usage = map[string]float64{"prompt_token_count": 100, "candidates_token_count": 20, "thoughts_token_count": 0, "total_token_count": 120, "model_call_count": 1}
	} else {
		return nil, nil, errors.New("invalid_gateway_request")
	}
	raw, e := json.Marshal(reply)
	return raw, usage, e
}
