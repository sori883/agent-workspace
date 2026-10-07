package gateway

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sori883/agent-workspace/execution/native"
)

const ProfileID = "gemini-3.1-flash-lite-standard-2026-10-07-v1"
const PreviewProfileID = "preview-v1"
const Model = "gemini-3.1-flash-lite"
const origin = "https://generativelanguage.googleapis.com"
const modelPath = "/v1beta/models/" + Model
const InputMargin = 128

type Agent struct {
	Mode      string `json:"mode"`
	ProfileID string `json:"profile_id"`
}

func (a Agent) Valid() bool {
	return a.Mode == "preview" && a.ProfileID == PreviewProfileID || a.Mode == "model" && a.ProfileID == ProfileID
}

type Limits struct{ Input, Output int }

func (l Limits) Valid() bool {
	return l.Input > InputMargin && l.Input <= 6000 && l.Output > 0 && l.Output <= 256
}

type Evidence struct {
	Outcome            string  `json:"outcome"`
	Code               string  `json:"code"`
	PayloadSHA256      *string `json:"payload_sha256"`
	CountedInputTokens *int    `json:"counted_input_tokens"`
	CountAttempt       int     `json:"count_attempt"`
	HTTPStatus         *int    `json:"http_status"`
	FinishReason       *string `json:"finish_reason"`
	ResponseSHA256     *string `json:"response_sha256"`
}
type Prepared struct {
	Payload       []byte
	SHA256, Phase string
	Version       int
}
type Generated struct {
	Response json.RawMessage
	Usage    map[string]float64
	Evidence Evidence
}
type Provider interface {
	Count(context.Context, Prepared) (int, error)
	Generate(context.Context, Prepared, Limits) (Generated, error)
}
type Gemini struct {
	client *http.Client
	key    func() (string, error)
	base   string
}

func NewGemini(key func() (string, error)) *Gemini {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 5 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second, DisableKeepAlives: true, DisableCompression: true, ForceAttemptHTTP2: false}
	return &Gemini{client: &http.Client{Transport: transport, Timeout: 25 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, key: key, base: origin}
}

func Prepare(request native.Request, mailbox *native.Mailbox, limits Limits) (Prepared, error) {
	runtime, err := request.Runtime()
	if err != nil || !limits.Valid() || mailbox == nil || mailbox.Request.Kind != "model" || mailbox.Request.RunID != request.RunID {
		return Prepared{}, errors.New("model_request_invalid")
	}
	return prepareMailbox(mailbox, limits, runtime.Phase, 1)
}
func prepareMailbox(mailbox *native.Mailbox, limits Limits, phase string, version int) (Prepared, error) {
	if version == 1 && !limits.Valid() || version == 2 && (limits.Input != 6000 || limits.Output != 512) {
		return Prepared{}, errors.New("model_request_invalid")
	}
	body := mailbox.Request.Body
	for key := range body {
		if key != "contents" && key != "systemInstruction" && key != "generationConfig" && key != "tools" && key != "toolConfig" && key != "sessionId" {
			return Prepared{}, errors.New("model_request_invalid")
		}
	}
	if raw, ok := body["tools"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("[]")) {
		return Prepared{}, errors.New("model_request_invalid")
	}
	if raw, ok := body["toolConfig"]; ok {
		var config struct {
			FunctionCallingConfig struct {
				Mode string `json:"mode"`
			} `json:"functionCallingConfig"`
		}
		if native.DecodeStrict(raw, &config) != nil || config.FunctionCallingConfig.Mode != "NONE" {
			return Prepared{}, errors.New("model_request_invalid")
		}
	}
	if raw, ok := body["sessionId"]; ok {
		var session string
		if json.Unmarshal(raw, &session) != nil || len(session) == 0 || len(session) > 128 || strings.ContainsAny(session, "\r\n\x00") {
			return Prepared{}, errors.New("model_request_invalid")
		}
	}
	var contents []json.RawMessage
	if native.DecodeStrict(body["contents"], &contents) != nil || len(contents) != 1 {
		return Prepared{}, errors.New("model_request_invalid")
	}
	for _, raw := range contents {
		if !textContent(raw, false) {
			return Prepared{}, errors.New("model_request_invalid")
		}
	}
	if !textContent(body["systemInstruction"], true) {
		return Prepared{}, errors.New("model_request_invalid")
	}
	if raw, ok := body["generationConfig"]; ok {
		var config map[string]json.RawMessage
		if native.DecodeStrict(raw, &config) != nil || config == nil {
			return Prepared{}, errors.New("model_request_invalid")
		}
		for key := range config {
			switch key {
			case "temperature", "topP", "topK", "maxOutputTokens", "candidateCount", "thinkingConfig":
			default:
				return Prepared{}, errors.New("model_request_invalid")
			}
		}
	}
	kinds := []string{"question", "output", "unsupported"}
	if phase == "answer" {
		kinds = []string{"output", "unsupported"}
	}
	config := map[string]any{"candidateCount": 1, "maxOutputTokens": limits.Output, "thinkingConfig": map[string]any{"thinkingLevel": "minimal", "includeThoughts": false},
		"responseMimeType": "application/json", "responseJsonSchema": map[string]any{"type": "object", "properties": map[string]any{
			"kind": map[string]any{"type": "string", "enum": kinds}, "text": map[string]any{"type": "string", "minLength": 1, "maxLength": 2048}},
			"required": []string{"kind", "text"}, "additionalProperties": false}}
	if version == 2 {
		config["responseJsonSchema"] = workbenchResponseSchema()
	}
	payload, err := json.Marshal(map[string]any{"contents": contents, "systemInstruction": body["systemInstruction"], "generationConfig": config})
	if err != nil || len(payload) > native.MaxMailboxBytes {
		return Prepared{}, errors.New("model_request_invalid")
	}
	return Prepared{Payload: payload, SHA256: digest(payload), Phase: phase, Version: version}, nil
}

func textContent(raw []byte, system bool) bool {
	var content map[string]json.RawMessage
	if native.DecodeStrict(raw, &content) != nil || content == nil {
		return false
	}
	for key := range content {
		if key != "role" && key != "parts" {
			return false
		}
	}
	var role string
	if r, ok := content["role"]; ok && (json.Unmarshal(r, &role) != nil || role != "user" && !(system && role == "system")) {
		return false
	}
	var parts []map[string]json.RawMessage
	if native.DecodeStrict(content["parts"], &parts) != nil || len(parts) == 0 || len(parts) > 16 {
		return false
	}
	for _, part := range parts {
		var text string
		if len(part) != 1 || json.Unmarshal(part["text"], &text) != nil || text == "" || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return false
		}
	}
	return true
}

func (g *Gemini) post(ctx context.Context, method string, body []byte) ([]byte, int, error) {
	if g == nil || g.key == nil {
		return nil, 0, errors.New("model_not_configured")
	}
	key, err := g.key()
	if err != nil || key == "" || strings.ContainsAny(key, "\r\n\x00") {
		return nil, 0, errors.New("model_credential_unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.base+modelPath+":"+method, bytes.NewReader(body))
	if err != nil {
		return nil, 0, errors.New("model_request_invalid")
	}
	req.GetBody = nil
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-goog-api-key", key)
	response, err := g.client.Do(req)
	if err != nil {
		return nil, 0, errors.New("model_transport_unknown")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, native.MaxMailboxBytes+1))
	if err != nil || len(data) > native.MaxMailboxBytes {
		return nil, response.StatusCode, errors.New("model_response_unknown")
	}
	return data, response.StatusCode, nil
}
func (g *Gemini) Count(ctx context.Context, p Prepared) (int, error) {
	var request map[string]json.RawMessage
	if native.DecodeStrict(p.Payload, &request) != nil || p.SHA256 != digest(p.Payload) {
		return 0, errors.New("model_request_invalid")
	}
	request["model"], _ = json.Marshal("models/" + Model)
	body, _ := json.Marshal(map[string]any{"generateContentRequest": request})
	raw, status, err := g.post(ctx, "countTokens", body)
	if err != nil || status != 200 {
		return 0, errors.New("model_count_failed")
	}
	var response map[string]json.RawMessage
	if native.DecodeJSON(raw, &response) != nil {
		return 0, errors.New("model_count_failed")
	}
	count, ok := token(response, "totalTokens", true)
	if !ok || count == 0 {
		return 0, errors.New("model_count_failed")
	}
	return count, nil
}
func (g *Gemini) Generate(ctx context.Context, p Prepared, limits Limits) (Generated, error) {
	if ((p.Version != 2 && !limits.Valid()) || (p.Version == 2 && (limits.Input != 6000 || limits.Output != 512))) || p.SHA256 != digest(p.Payload) {
		return Generated{}, errors.New("model_request_invalid")
	}
	raw, status, err := g.post(ctx, "generateContent", p.Payload)
	if err != nil {
		return Generated{}, err
	}
	var response map[string]json.RawMessage
	if native.DecodeJSON(raw, &response) != nil {
		return Generated{}, errors.New("model_usage_unknown")
	}
	usage, ok := usageFrom(response["usageMetadata"])
	if !ok {
		return Generated{}, errors.New("model_usage_unknown")
	}
	hash := digest(raw)
	result := Generated{Usage: usage, Evidence: Evidence{Outcome: "failed", Code: "model_response_invalid", PayloadSHA256: &p.SHA256, HTTPStatus: &status, ResponseSHA256: &hash}}
	if usage["prompt_token_count"] > float64(limits.Input) || usage["candidates_token_count"]+usage["thoughts_token_count"] > float64(limits.Output) {
		result.Evidence.Code = "model_budget_exceeded"
		return result, nil
	}
	if status != 200 {
		result.Evidence.Code = "model_http_failed"
		return result, nil
	}
	var candidates []map[string]json.RawMessage
	if json.Unmarshal(response["candidates"], &candidates) != nil || len(candidates) != 1 {
		return result, nil
	}
	var reason string
	if json.Unmarshal(candidates[0]["finishReason"], &reason) != nil {
		return result, nil
	}
	if safeReason(reason) {
		result.Evidence.FinishReason = &reason
	}
	if reason != "STOP" {
		result.Evidence.Code = "model_generation_incomplete"
		return result, nil
	}
	var content map[string]json.RawMessage
	var parts []map[string]json.RawMessage
	if json.Unmarshal(candidates[0]["content"], &content) != nil || json.Unmarshal(content["parts"], &parts) != nil || len(parts) != 1 {
		return result, nil
	}
	for k, v := range parts[0] {
		switch k {
		case "text":
		case "thoughtSignature":
			var signature string
			if json.Unmarshal(v, &signature) != nil {
				return result, nil
			}
		case "thought":
			var thought bool
			if json.Unmarshal(v, &thought) != nil || thought {
				return result, nil
			}
		default:
			return result, nil
		}
	}
	var text string
	if json.Unmarshal(parts[0]["text"], &text) != nil {
		return result, nil
	}
	if p.Version == 2 {
		if _, err := native.ParseWorkbenchProposal([]byte(text)); err != nil {
			return result, nil
		}
	} else {
		proposal, err := native.ParseProposal([]byte(text))
		if err != nil || p.Phase == "answer" && proposal.Kind == "question" {
			return result, nil
		}
	}
	result.Response, _ = json.Marshal(map[string]any{"candidates": []any{map[string]any{"index": 0, "content": map[string]any{"role": "model", "parts": []any{map[string]string{"text": text}}}, "finishReason": "STOP"}},
		"usageMetadata": map[string]float64{"promptTokenCount": usage["prompt_token_count"], "candidatesTokenCount": usage["candidates_token_count"], "thoughtsTokenCount": usage["thoughts_token_count"], "totalTokenCount": usage["total_token_count"]}, "modelVersion": Model})
	result.Evidence.Outcome = "ok"
	result.Evidence.Code = "ok"
	return result, nil
}
func usageFrom(raw []byte) (map[string]float64, bool) {
	var m map[string]json.RawMessage
	if native.DecodeJSON(raw, &m) != nil || m == nil {
		return nil, false
	}
	usage := map[string]float64{"model_call_count": 1}
	fields := map[string]string{"promptTokenCount": "prompt_token_count", "candidatesTokenCount": "candidates_token_count", "thoughtsTokenCount": "thoughts_token_count", "totalTokenCount": "total_token_count"}
	for key, name := range fields {
		n, ok := token(m, key, key == "promptTokenCount" || key == "totalTokenCount")
		if !ok {
			return nil, false
		}
		usage[name] = float64(n)
	}
	cache, ok := token(m, "cachedContentTokenCount", false)
	if !ok || float64(cache) > usage["prompt_token_count"] {
		return nil, false
	}
	tools, ok := token(m, "toolUsePromptTokenCount", false)
	if !ok || tools != 0 {
		return nil, false
	}
	if usage["prompt_token_count"] <= 0 || usage["total_token_count"] != usage["prompt_token_count"]+usage["candidates_token_count"]+usage["thoughts_token_count"] {
		return nil, false
	}
	return usage, true
}
func token(m map[string]json.RawMessage, key string, required bool) (int, bool) {
	raw, ok := m[key]
	if !ok {
		return 0, !required
	}
	var n int
	if bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &n) != nil || n < 0 || n > 1000000 {
		return 0, false
	}
	return n, true
}
func safeReason(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if c != '_' && (c < 'A' || c > 'Z') {
			return false
		}
	}
	return true
}
func digest(data []byte) string { hash := sha256.Sum256(data); return hex.EncodeToString(hash[:]) }
func Cost(usage map[string]float64) float64 {
	return (usage["prompt_token_count"]*0.25 + (usage["candidates_token_count"]+usage["thoughts_token_count"])*1.5) / 1000000
}
func ZeroUsage() map[string]float64 {
	return map[string]float64{"prompt_token_count": 0, "candidates_token_count": 0, "thoughts_token_count": 0, "total_token_count": 0, "model_call_count": 0}
}
func ModelReply(mailbox *native.Mailbox, result Generated) ([]byte, error) {
	body := map[string]json.RawMessage{}
	status := "denied"
	if result.Evidence.Outcome == "ok" {
		status = "ok"
		body["response"] = result.Response
		body["billing"], _ = json.Marshal(map[string]any{"profile_id": ProfileID, "estimated_usd": Cost(result.Usage)})
	} else {
		body["code"], _ = json.Marshal(result.Evidence.Code)
	}
	return json.Marshal(native.MailboxReply{Version: mailbox.Request.Version, RunID: mailbox.Request.RunID, Sequence: mailbox.Request.Sequence, RequestSHA256: mailbox.SHA256, Status: status, Body: body})
}
