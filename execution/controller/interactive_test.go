package controller

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

type agentStore struct {
	*fakeStore
	responses      map[int][]byte
	reserveError   error
	settleError    bool
	sends          int
	settlements    int
	authorizations int
	authorizeError error
	evidence       gateway.Evidence
	usage          map[string]float64
	denySettlement bool
	holdOnFinish   bool
}

func (s *agentStore) Finish(ctx context.Context, c *Claim) error {
	if s.holdOnFinish {
		return ErrHeld
	}
	return s.fakeStore.Finish(ctx, c)
}

func (s *agentStore) Reserve(_ context.Context, _ *Claim, m *native.Mailbox) (Reservation, error) {
	if s.reserveError != nil {
		return Reservation{}, s.reserveError
	}
	if response, ok := s.responses[m.Request.Sequence]; ok {
		return Reservation{Response: response, ProfileID: s.claim.Agent.ProfileID}, nil
	}
	s.sends++
	return Reservation{Send: true, InputLimit: 6000, OutputLimit: 256, ProfileID: s.claim.Agent.ProfileID}, nil
}
func (s *agentStore) AuthorizeGeneration(context.Context, *Claim, *native.Mailbox, string, int) error {
	s.authorizations++
	return s.authorizeError
}
func (s *agentStore) Settle(_ context.Context, _ *Claim, m *native.Mailbox, r []byte, usage map[string]float64, _ int, evidence gateway.Evidence) error {
	s.settlements++
	s.evidence = evidence
	s.usage = usage
	if s.settleError {
		return errors.New("settle_ack_lost")
	}
	if s.denySettlement {
		parsed, _ := native.ParseReply(r, m)
		parsed.Status = "denied"
		parsed.Body = map[string]json.RawMessage{"code": json.RawMessage(`"model_budget_exceeded"`)}
		r, _ = json.Marshal(parsed)
	}
	s.responses[m.Request.Sequence] = r
	return nil
}

type interactiveExecutor struct {
	*fakeExecutor
	mailbox    *native.Mailbox
	replies    int
	replyError bool
	waiting    bool
}

func (e *interactiveExecutor) Mailbox(context.Context, string) (*native.Mailbox, error) {
	if e.replies > 0 {
		return nil, nil
	}
	return e.mailbox, nil
}
func (e *interactiveExecutor) Reply(_ context.Context, _ *native.Mailbox, _ []byte) error {
	e.replies++
	if e.replyError && e.replies == 1 {
		return errors.New("reply_ack_lost")
	}
	return nil
}
func (e *interactiveExecutor) Status(ctx context.Context, r native.Request) (native.RunnerStatus, error) {
	if e.waiting {
		return native.RunnerStatus{RunID: runID, State: "running", Attempted: true}, nil
	}
	return e.fakeExecutor.Status(ctx, r)
}
func interactiveFixture(t *testing.T) (*Controller, *agentStore, *interactiveExecutor) {
	c, s, e := setup(t)
	s.claim.Request = native.Request{SchemaVersion: 1, RunID: runID, Adapter: "interactive", Instruction: "test", OutputName: "reply.txt", Inputs: map[string]string{"conversation.json": "[]", "runtime.json": `{"version":1,"root_id":"12345678-1234-1234-1234-123456789abc","phase":"request","question_id":null,"skill_id":"brief-v1","remaining_ms":90000}`}}
	s.claim.Agent = &gateway.Agent{Mode: "preview", ProfileID: gateway.PreviewProfileID}
	e.result.Adapter = "interactive"
	e.result.Artifact.Name = "reply.txt"
	stop := "UNSPECIFIED"
	e.result.StopReason = &stop
	e.result.Usage = map[string]float64{"prompt_token_count": 100, "total_token_count": 120}
	store := &agentStore{fakeStore: s, responses: map[int][]byte{}}
	raw := []byte(`{"version":1,"run_id":"` + runID + `","sequence":1,"kind":"model","body":{"contents":[]}}`)
	hash := sha256.Sum256(raw)
	wire, _ := json.Marshal(map[string]string{"request_base64": base64.StdEncoding.EncodeToString(raw), "sha256": hex.EncodeToString(hash[:])})
	mailbox, err := native.ParseMailbox(wire, runID)
	if err != nil {
		t.Fatal(err)
	}
	executor := &interactiveExecutor{fakeExecutor: e, mailbox: mailbox}
	c.Store = store
	c.InteractiveExecutor = executor
	c.InteractiveImage = image
	return c, store, executor
}
func TestInteractiveUsesDenyAndSettlesBeforeReply(t *testing.T) {
	c, s, e := interactiveFixture(t)
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.sends != 1 || s.settlements != 1 || e.replies != 1 || !s.finished || !s.collected || s.intents[native.AllowOperation] != "" {
		t.Fatal("gateway protocol incomplete")
	}
}
func TestInteractiveReservationAndSettleLossNeverDeliver(t *testing.T) {
	for _, reserve := range []bool{true, false} {
		c, s, e := interactiveFixture(t)
		if reserve {
			s.reserveError = errors.New("reservation_unknown")
		} else {
			s.settleError = true
		}
		if _, err := c.RunOnce(context.Background()); err == nil {
			t.Fatal("unknown resolved")
		}
		if e.replies != 0 || s.finished || !s.failed {
			t.Fatal("unsettled response delivered")
		}
	}
}
func TestInteractiveReplyLossOnlyReplaysSettledResponse(t *testing.T) {
	c, s, e := interactiveFixture(t)
	e.replyError = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.sends != 1 || s.settlements != 1 || e.replies != 2 {
		t.Fatal("provider sent again")
	}
}
func TestInteractiveKnownDenialStopsAndUnknownHolds(t *testing.T) {
	for _, denial := range []error{ErrGatewayDenied, ErrAuthorizationRevoked, errors.New("agent_operation_unknown")} {
		c, s, e := interactiveFixture(t)
		s.reserveError = denial
		_, err := c.RunOnce(context.Background())
		known := errors.Is(denial, ErrGatewayDenied) || errors.Is(denial, ErrAuthorizationRevoked)
		if (err == nil) != known || s.finished != known || e.replies != 0 || s.sends != 0 {
			t.Fatal("denial and unknown conflated")
		}
	}
}
func TestInteractiveDeadlineStopsWithoutExtraSend(t *testing.T) {
	c, s, e := interactiveFixture(t)
	e.mailbox = nil
	e.waiting = true
	c.PollInterval = time.Millisecond
	r, _ := s.claim.Request.Runtime()
	r.RemainingMS = 2
	data, _ := json.Marshal(r)
	s.claim.Request.Inputs["runtime.json"] = string(data)
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.sends != 0 || !s.finished || s.intents[native.SuspendOperation] == "" {
		t.Fatal("deadline not stopped")
	}
}
func TestInteractiveRecoveryNeverProcessesMailbox(t *testing.T) {
	c, s, e := interactiveFixture(t)
	s.claim.Kind = "recovery"
	s.claim.Effects = map[native.Operation]Effect{native.StartOperation: {OperationID: "prior"}}
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.sends != 0 || s.settlements != 0 || e.replies != 0 {
		t.Fatal("recovery resent model")
	}
}
