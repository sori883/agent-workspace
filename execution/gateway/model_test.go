package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/native"
)

func wire(t *testing.T) (native.Request, *native.Mailbox) {
	t.Helper()
	r := native.Request{SchemaVersion: 1, RunID: "ax-run-0123456789abcdef", Adapter: "interactive", Instruction: "test", OutputName: "reply.txt", Inputs: map[string]string{"conversation.json": "[]", "runtime.json": `{"version":1,"root_id":"12345678-1234-1234-1234-123456789abc","phase":"request","question_id":null,"skill_id":"brief-v1","remaining_ms":90000}`}}
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{"contents":[{"role":"user","parts":[{"text":"fixed test"}]}],"systemInstruction":{"role":"user","parts":[{"text":"Return JSON"}]},"generationConfig":{"maxOutputTokens":65535},"sessionId":"sdk-local-session","toolConfig":{"functionCallingConfig":{"mode":"NONE"}}}`), &body); err != nil {
		t.Fatal(err)
	}
	return r, &native.Mailbox{Request: native.MailboxRequest{Version: 1, RunID: r.RunID, Sequence: 1, Kind: "model", Body: body}, SHA256: strings.Repeat("a", 64)}
}
func prepared(t *testing.T) Prepared {
	t.Helper()
	r, m := wire(t)
	p, err := Prepare(r, m, Limits{6000, 256})
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func validResponse() string {
	return `{"candidates":[{"content":{"role":"model","parts":[{"text":"{\"kind\":\"question\",\"text\":\"What should I include?\"}","thoughtSignature":"synthetic-signature"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":101,"candidatesTokenCount":20,"thoughtsTokenCount":3,"totalTokenCount":124}}`
}

func TestPrepareReplacesSDKDefaultsAndRejectsUnapprovedFeatures(t *testing.T) {
	p := prepared(t)
	var body map[string]json.RawMessage
	json.Unmarshal(p.Payload, &body)
	if len(body) != 3 || bytes.Contains(p.Payload, []byte("sessionId")) || bytes.Contains(p.Payload, []byte("65535")) || !bytes.Contains(p.Payload, []byte(`"maxOutputTokens":256`)) || !bytes.Contains(p.Payload, []byte(`"thinkingLevel":"minimal"`)) {
		t.Fatal("unbounded SDK request forwarded")
	}
	for _, change := range []map[string]json.RawMessage{
		{"tools": json.RawMessage(`[{"googleSearch":{}}]`)}, {"cachedContent": json.RawMessage(`"cachedContents/one"`)}, {"contents": json.RawMessage(`[{"parts":[{"fileData":{"fileUri":"https://example.test"}}]}]`)},
		{"toolConfig": json.RawMessage(`{"functionCallingConfig":{"mode":"AUTO"}}`)}, {"generationConfig": json.RawMessage(`{"responseModalities":["AUDIO"]}`)},
		{"systemInstruction": json.RawMessage(`{"role":"system","parts":[{"text":"a","text":"b"}]}`)},
	} {
		r, m := wire(t)
		for k, v := range change {
			m.Request.Body[k] = v
		}
		if _, err := Prepare(r, m, Limits{6000, 256}); err == nil {
			t.Fatal("unsupported payload accepted", change)
		}
	}
}
func TestHTTPUsesOneFixedGenerationAndSameCountPayload(t *testing.T) {
	p := prepared(t)
	requests := []string{}
	var counted map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		if r.Method != "POST" || r.URL.RawQuery != "" || r.Header.Get("x-goog-api-key") != "synthetic-test-key" {
			t.Error("unexpected wire")
		}
		body, _ := io.ReadAll(r.Body)
		if bytes.Contains(body, []byte("synthetic-test-key")) {
			t.Error("key entered payload")
		}
		if strings.HasSuffix(r.URL.Path, ":countTokens") {
			var wrapper map[string]map[string]json.RawMessage
			json.Unmarshal(body, &wrapper)
			counted = wrapper["generateContentRequest"]
			delete(counted, "model")
			io.WriteString(w, `{"totalTokens":100}`)
		} else {
			var generated map[string]json.RawMessage
			json.Unmarshal(body, &generated)
			a, _ := json.Marshal(counted)
			b, _ := json.Marshal(generated)
			if !bytes.Equal(a, b) {
				t.Error("count and generation differed")
			}
			io.WriteString(w, validResponse())
		}
	}))
	defer server.Close()
	g := NewGemini(func() (string, error) { return "synthetic-test-key", nil })
	g.base = server.URL
	count, err := g.Count(context.Background(), p)
	if err != nil || count != 100 {
		t.Fatal(count, err)
	}
	result, err := g.Generate(context.Background(), p, Limits{6000, 256})
	if err != nil || result.Evidence.Outcome != "ok" || result.Usage["thoughts_token_count"] != 3 {
		t.Fatal(result, err)
	}
	if len(requests) != 2 || requests[0] != modelPath+":countTokens" || requests[1] != modelPath+":generateContent" {
		t.Fatal(requests)
	}
	if bytes.Contains(result.Response, []byte("thoughtSignature")) {
		t.Fatal("signature forwarded")
	}
	_, m := wire(t)
	reply, err := ModelReply(m, result)
	if err != nil || !bytes.Contains(reply, []byte(`"billing"`)) {
		t.Fatal("billing missing")
	}
}
func TestUsageSurvivesKnownGenerationFailures(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"max-tokens", strings.Replace(validResponse(), `"STOP"`, `"MAX_TOKENS"`, 1), "model_generation_incomplete"},
		{"proposal", strings.Replace(validResponse(), `\"question\"`, `\"shell\"`, 1), "model_response_invalid"},
		{"budget", strings.Replace(strings.Replace(validResponse(), `"candidatesTokenCount":20`, `"candidatesTokenCount":260`, 1), `"totalTokenCount":124`, `"totalTokenCount":364`, 1), "model_budget_exceeded"},
		{"duplicate-proposal", strings.Replace(validResponse(), `\"kind\":\"question\"`, `\"kind\":\"question\",\"kind\":\"output\"`, 1), "model_response_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, tc.body) }))
			defer s.Close()
			g := NewGemini(func() (string, error) { return "synthetic", nil })
			g.base = s.URL
			result, err := g.Generate(context.Background(), prepared(t), Limits{6000, 256})
			if err != nil || result.Evidence.Outcome != "failed" || result.Evidence.Code != tc.code || result.Usage["model_call_count"] != 1 || Cost(result.Usage) <= 0 {
				t.Fatal(result, err)
			}
		})
	}
}
func TestNullableProviderMetadataDoesNotEraseKnownUsage(t *testing.T) {
	body := strings.Replace(validResponse(), `"usageMetadata":{`, `"promptFeedback":null,"usageMetadata":{"promptTokensDetails":null,`, 1)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
	defer s.Close()
	g := NewGemini(func() (string, error) { return "synthetic", nil })
	g.base = s.URL
	result, err := g.Generate(context.Background(), prepared(t), Limits{6000, 256})
	if err != nil || result.Evidence.Outcome != "ok" || result.Usage["total_token_count"] != 124 {
		t.Fatal("optional metadata erased usage", result, err)
	}
}
func TestUnknownUsageIsNotZeroAndNeverRetriesOrRedirects(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"missing", `{"candidates":[]}`, 200}, {"duplicate", `{"usageMetadata":{"promptTokenCount":1,"promptTokenCount":2}}`, 200},
		{"http-secret", `{"error":"synthetic-secret-input"}`, 503}, {"large", strings.Repeat("a", native.MaxMailboxBytes+1), 200},
		{"redirect", `{}`, 307},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Location", "/retry")
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			defer s.Close()
			g := NewGemini(func() (string, error) { return "synthetic", nil })
			g.base = s.URL
			result, err := g.Generate(context.Background(), prepared(t), Limits{6000, 256})
			if err == nil || result.Usage != nil || calls != 1 || strings.Contains(err.Error(), "synthetic-secret-input") {
				t.Fatal("unknown was released or retried", result, err, calls)
			}
		})
	}
}
func TestProductionTransportHasNoProxyRedirectRetryOrInsecureTLS(t *testing.T) {
	g := NewGemini(nil)
	transport := g.client.Transport.(*http.Transport)
	if g.base != origin || transport.Proxy != nil || !transport.DisableKeepAlives || transport.TLSClientConfig.InsecureSkipVerify || g.client.Timeout != 25*time.Second || g.client.CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
		t.Fatal("unsafe transport")
	}
}
func TestDeadlinePreventsCountAndGenerate(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; io.WriteString(w, validResponse()) }))
	defer s.Close()
	g := NewGemini(func() (string, error) { return "synthetic", nil })
	g.base = s.URL
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.Count(ctx, prepared(t)); err == nil {
		t.Fatal("count ignored cancellation")
	}
	if _, err := g.Generate(ctx, prepared(t), Limits{6000, 256}); err == nil {
		t.Fatal("generate ignored cancellation")
	}
	if calls != 0 {
		t.Fatal("sent after cancellation")
	}
}
