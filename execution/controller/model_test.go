package controller

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

type modelProvider struct {
	count, counts, generations int
	countError, generateError  error
	afterCount                 func()
	afterGenerate              func()
	failed                     bool
}

func (p *modelProvider) Count(context.Context, gateway.Prepared) (int, error) {
	p.counts++
	if p.afterCount != nil {
		p.afterCount()
	}
	return p.count, p.countError
}
func (p *modelProvider) Generate(_ context.Context, prepared gateway.Prepared, _ gateway.Limits) (gateway.Generated, error) {
	p.generations++
	if p.afterGenerate != nil {
		p.afterGenerate()
	}
	if p.generateError != nil {
		return gateway.Generated{}, p.generateError
	}
	usage := map[string]float64{"prompt_token_count": 100, "candidates_token_count": 20, "thoughts_token_count": 0, "total_token_count": 120, "model_call_count": 1}
	status := 200
	reason := "STOP"
	hash := strings.Repeat("b", 64)
	e := gateway.Evidence{Outcome: "ok", Code: "ok", PayloadSHA256: &prepared.SHA256, HTTPStatus: &status, FinishReason: &reason, ResponseSHA256: &hash}
	if p.failed {
		e.Outcome = "failed"
		e.Code = "model_response_invalid"
	}
	return gateway.Generated{Response: json.RawMessage(`{"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"{\"kind\":\"question\",\"text\":\"What?\"}"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":0,"totalTokenCount":120},"modelVersion":"gemini-3.1-flash-lite"}`), Usage: usage, Evidence: e}, nil
}
func modelFixture(t *testing.T) (*Controller, *agentStore, *interactiveExecutor, *modelProvider) {
	c, s, e := interactiveFixture(t)
	s.claim.Agent = &gateway.Agent{Mode: "model", ProfileID: gateway.ProfileID}
	json.Unmarshal([]byte(`{"contents":[{"role":"user","parts":[{"text":"request"}]}],"systemInstruction":{"role":"user","parts":[{"text":"system"}]}}`), &e.mailbox.Request.Body)
	p := &modelProvider{count: 100}
	c.ModelProvider = p
	return c, s, e, p
}
func TestModelSettlementReadbackAndNoDuplicateGeneration(t *testing.T) {
	c, s, e, p := modelFixture(t)
	e.replyError = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p.counts != 1 || p.generations != 1 || s.authorizations != 1 || s.settlements != 1 || e.replies != 2 || s.evidence.CountAttempt != 1 {
		t.Fatal("provider retried or evidence absent")
	}
}
func TestModelNeverGeneratesAfterCountRevocationOrUnknownAuthorization(t *testing.T) {
	for _, err := range []error{ErrAuthorizationRevoked, ErrGatewayDenied, errors.New("database_authorization_unknown")} {
		c, s, e, p := modelFixture(t)
		p.afterCount = func() { s.authorizeError = err }
		_, result := c.RunOnce(context.Background())
		known := errors.Is(err, ErrAuthorizationRevoked) || errors.Is(err, ErrGatewayDenied)
		if p.counts != 1 || p.generations != 0 || s.authorizations != 1 || e.replies != 0 || (result == nil) != known {
			t.Fatal("authorization boundary lost", result)
		}
		if known && (s.settlements != 1 || s.evidence.Outcome != "no_send" || s.usage["model_call_count"] != 0) {
			t.Fatal("no-send lost")
		}
		if !known && s.settlements != 0 {
			t.Fatal("unknown permission released")
		}
	}
}
func TestModelCountFailureLimitAndClosedGateSettleWithoutGenerating(t *testing.T) {
	for _, name := range []string{"count-failure", "input-limit", "closed"} {
		c, s, e, p := modelFixture(t)
		switch name {
		case "count-failure":
			p.countError = errors.New("count_failed")
		case "input-limit":
			p.count = 5873
		case "closed":
			c.ModelProvider = nil
		}
		if _, err := c.RunOnce(context.Background()); err != nil {
			t.Fatal(name, err)
		}
		if p.generations != 0 || s.authorizations != 0 || s.settlements != 1 || s.evidence.Outcome != "no_send" || e.replies != 0 || !s.finished {
			t.Fatal(name, "unsafe no-send")
		}
	}
}
func TestModelUnknownGenerationAndSettleLossHold(t *testing.T) {
	for _, settle := range []bool{false, true} {
		c, s, e, p := modelFixture(t)
		if settle {
			s.settleError = true
		} else {
			p.generateError = errors.New("model_usage_unknown")
			s.holdOnFinish = true
		}
		if _, err := c.RunOnce(context.Background()); err == nil {
			t.Fatal("unknown finished")
		}
		if p.generations != 1 || e.replies != 0 || s.finished {
			t.Fatal("unknown resent or delivered")
		}
	}
}
func TestKnownFailureAndDatabaseDeniedNeverDeliverOriginalSuccess(t *testing.T) {
	for _, databaseDenies := range []bool{false, true} {
		c, s, e, p := modelFixture(t)
		p.failed = !databaseDenies
		s.denySettlement = databaseDenies
		if _, err := c.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		if s.settlements != 1 || s.usage["model_call_count"] != 1 || e.replies != 0 || !s.finished {
			t.Fatal("known failure lost cost or delivered")
		}
	}
}
func TestCountCancellationNeverAuthorizesGeneration(t *testing.T) {
	c, s, e, p := modelFixture(t)
	c.Executor = e
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.afterCount = cancel
	_ = c.processMailbox(ctx, s.claim)
	if p.generations != 0 || s.authorizations != 0 || s.settlements != 1 || s.evidence.Outcome != "no_send" {
		t.Fatal("canceled count proceeded")
	}
}
func TestClaimModeCannotFallbackToPreview(t *testing.T) {
	for _, agent := range []*gateway.Agent{nil, {Mode: "model", ProfileID: gateway.PreviewProfileID}, {Mode: "unknown", ProfileID: gateway.ProfileID}} {
		c, s, _, p := modelFixture(t)
		s.claim.Agent = agent
		if _, err := c.RunOnce(context.Background()); err == nil {
			t.Fatal("bad mode accepted")
		}
		if p.counts != 0 || len(s.intents) != 0 {
			t.Fatal("bad mode started")
		}
	}
}

func TestUnknownCompletedHTTPStopsConfirmedActorButRetainsHold(t *testing.T) {
	c, s, _, p := modelFixture(t)
	p.generateError = errors.New("model_usage_unknown")
	s.holdOnFinish = true
	_, err := c.RunOnce(context.Background())
	if !errors.Is(err, ErrHeld) || s.intents[native.DenyOperation] == "" || s.intents[native.SuspendOperation] == "" || s.settlements != 0 || s.finished || p.generations != 1 {
		t.Fatal("unknown HTTP left actor running or released usage", err)
	}
}
func TestUnknownHTTPDoesNotCleanupWithCanceledAuthority(t *testing.T) {
	c, s, _, p := modelFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.afterGenerate = cancel
	p.generateError = errors.New("model_usage_unknown")
	if _, err := c.RunOnce(ctx); err == nil {
		t.Fatal("canceled authority finished")
	}
	if s.intents[native.DenyOperation] != "" || s.intents[native.SuspendOperation] != "" || s.settlements != 0 || s.finished || p.generations != 1 {
		t.Fatal("cleanup exceeded canceled authority")
	}
}
