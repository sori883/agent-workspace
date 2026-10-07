package gateway

import (
	"encoding/json"
	"errors"

	"github.com/sori883/agent-workspace/execution/native"
)

func Respond(request native.Request, mailbox *native.Mailbox) ([]byte, map[string]float64, error) {
	runtime, err := request.Runtime()
	if err != nil || mailbox == nil || mailbox.Request.RunID != request.RunID {
		return nil, nil, errors.New("invalid_gateway_request")
	}
	reply := native.MailboxReply{Version: 1, RunID: request.RunID, Sequence: mailbox.Request.Sequence, RequestSHA256: mailbox.SHA256, Status: "ok", Body: map[string]json.RawMessage{}}
	usage := map[string]float64{}
	if mailbox.Request.Kind == "model" {
		proposal := native.Proposal{Kind: "question", Text: "成果物に含めたい内容を教えてください。"}
		if runtime.Phase == "answer" {
			proposal = native.Proposal{Kind: "output", Text: request.Instruction}
		}
		text, _ := json.Marshal(proposal)
		response := map[string]any{
			"candidates":    []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]string{"text": string(text)}}}, "finishReason": "STOP"}},
			"usageMetadata": map[string]int{"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 0, "totalTokenCount": 120},
			"modelVersion":  "gemini-3.1-flash-lite",
		}
		reply.Body["response"], _ = json.Marshal(response)
		usage = map[string]float64{"prompt_token_count": 100, "candidates_token_count": 20, "thoughts_token_count": 0, "total_token_count": 120, "model_call_count": 1}
	} else if mailbox.Request.Kind == "tool" {
		raw, _ := json.Marshal(mailbox.Request.Body)
		proposal, err := native.ParseProposal(raw)
		if err != nil || runtime.Phase == "answer" && proposal.Kind == "question" {
			return nil, nil, errors.New("invalid_gateway_proposal")
		}
		reply.Body["accepted"] = json.RawMessage("true")
	} else {
		return nil, nil, errors.New("invalid_gateway_request")
	}
	data, err := json.Marshal(reply)
	if err != nil || len(data) > native.MaxMailboxBytes {
		return nil, nil, errors.New("gateway_response_limit")
	}
	return data, usage, nil
}
