package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/native"
)

const runID = "ax-run-0123456789abcdef"
const image = "localhost:5000/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeStore struct {
	mu                sync.Mutex
	claim             *Claim
	intentError       native.Operation
	evidenceError     bool
	heartbeatError    bool
	finished          bool
	failed            bool
	collected         bool
	intents           map[native.Operation]string
	cancelAfterIntent context.CancelFunc
	blockedHeartbeat  chan struct{}
}

func (s *fakeStore) Claim(context.Context) (*Claim, error) { return s.claim, nil }
func (s *fakeStore) Heartbeat(ctx context.Context, _ *Claim) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.blockedHeartbeat != nil {
		close(s.blockedHeartbeat)
		<-ctx.Done()
		return errors.New("database_operation_unconfirmed")
	}
	if s.heartbeatError {
		return errors.New("heartbeat_failed")
	}
	return nil
}
func (s *fakeStore) Intent(_ context.Context, _ *Claim, operation native.Operation) (string, error) {
	if s.intentError == operation {
		return "", errors.New("intent_response_lost")
	}
	if _, ok := s.intents[operation]; ok {
		return "", errors.New("duplicate_intent")
	}
	id := "id-" + string(operation)
	s.intents[operation] = id
	if s.cancelAfterIntent != nil {
		s.cancelAfterIntent()
	}
	return id, nil
}
func (s *fakeStore) Evidence(_ context.Context, _ *Claim, _ string, evidence map[string]any) error {
	if evidence["phase"] == "SUSPENDED" && s.blockedHeartbeat != nil {
		<-s.blockedHeartbeat
	}
	if s.evidenceError {
		return errors.New("evidence_response_lost")
	}
	return nil
}
func (s *fakeStore) Collect(context.Context, *Claim, native.Collection) error {
	s.collected = true
	return nil
}
func (s *fakeStore) Finish(context.Context, *Claim) error       { s.finished = true; return nil }
func (s *fakeStore) Fail(context.Context, *Claim, string) error { s.failed = true; return nil }

type fakeExecutor struct {
	store          *fakeStore
	calls          []native.Operation
	errorOperation native.Operation
	missingIntent  bool
	stop           bool
	blockResume    bool
	result         native.Result
}

func (e *fakeExecutor) invoke(operation native.Operation) error {
	e.calls = append(e.calls, operation)
	if _, ok := e.store.intents[operation]; !ok {
		e.missingIntent = true
	}
	if e.errorOperation == operation {
		return &native.Error{Operation: operation, Kind: "unknown", Code: "response_lost"}
	}
	return nil
}
func (e *fakeExecutor) Create(context.Context, string) (native.TaskObservation, error) {
	return native.TaskObservation{}, e.invoke(native.CreateOperation)
}
func (e *fakeExecutor) Resume(ctx context.Context, _ string) (native.TaskObservation, error) {
	err := e.invoke(native.ResumeOperation)
	if e.blockResume {
		<-ctx.Done()
		err = ctx.Err()
	}
	return native.TaskObservation{}, err
}
func (e *fakeExecutor) ObserveTask(context.Context, string) (native.TaskObservation, error) {
	return native.TaskObservation{RunID: runID, Phase: "Running"}, nil
}
func (e *fakeExecutor) Stage(context.Context, native.Request) error {
	return e.invoke(native.StageOperation)
}
func (e *fakeExecutor) Start(context.Context, string) error { return e.invoke(native.StartOperation) }
func (e *fakeExecutor) Status(context.Context, native.Request) (native.RunnerStatus, error) {
	return native.RunnerStatus{RunID: runID, State: "finished", Attempted: true, Result: &e.result}, nil
}
func (e *fakeExecutor) Collect(context.Context, native.Request) (native.Collection, error) {
	return native.Collection{Result: e.result, Bytes: []byte("ok")}, nil
}
func (e *fakeExecutor) SetEgress(_ context.Context, _ string, allow bool) (native.EgressObservation, error) {
	op := native.DenyOperation
	if allow {
		op = native.AllowOperation
	} else if _, exists := e.store.intents[native.DenyOperation]; !exists {
		op = native.PrepareEgressOperation
	}
	return native.EgressObservation{RunID: runID, Matches: true, Denied: !allow}, e.invoke(op)
}
func (e *fakeExecutor) ObserveEgress(context.Context, string, bool) (native.EgressObservation, error) {
	e.calls = append(e.calls, "observe_egress")
	return native.EgressObservation{RunID: runID, Matches: true, Denied: true}, nil
}
func (e *fakeExecutor) Suspend(context.Context, string) (native.TaskObservation, error) {
	return native.TaskObservation{}, e.invoke(native.SuspendOperation)
}
func (e *fakeExecutor) ObserveStop(context.Context, string) (native.StopObservation, error) {
	e.calls = append(e.calls, "observe_stop")
	return native.StopObservation{RunID: runID, Stopped: e.stop, HasWorker: !e.stop}, nil
}

func setup(t *testing.T) (*Controller, *fakeStore, *fakeExecutor) {
	t.Helper()
	zero := float64(0)
	stop := "OFFLINE"
	hash := sha256.Sum256([]byte("ok"))
	result := native.Result{SchemaVersion: 1, RunID: runID, Adapter: "offline", Status: "succeeded", StopReason: &stop, Usage: map[string]float64{"total_token_count": 0}, EstimatedUSD: &zero, Artifact: &native.Artifact{Name: "out.txt", SizeBytes: 2, SHA256: hex.EncodeToString(hash[:])}}
	store := &fakeStore{claim: &Claim{RunID: runID, Generation: 1, Kind: "execute", Image: image, Request: native.Request{SchemaVersion: 1, RunID: runID, Adapter: "offline", Instruction: "test", Inputs: map[string]string{}, OutputName: "out.txt"}}, intents: map[native.Operation]string{}}
	executor := &fakeExecutor{store: store, stop: true, result: result}
	c := New(store, executor, image)
	c.PollInterval = time.Millisecond
	c.StopTimeout = 5 * time.Millisecond
	c.HeartbeatInterval = time.Millisecond
	return c, store, executor
}

func TestRunPersistsIntentBeforeEachEffect(t *testing.T) {
	c, s, e := setup(t)
	worked, err := c.RunOnce(context.Background())
	if !worked || err != nil || !s.finished || !s.collected || s.failed || e.missingIntent {
		t.Fatalf("bad execution: worked=%v err=%v finished=%v collected=%v missing=%v", worked, err, s.finished, s.collected, e.missingIntent)
	}
	if len(s.intents) != 7 {
		t.Fatalf("unexpected effects %v", s.intents)
	}
	if s.intents[native.AllowOperation] != "" {
		t.Fatal("offline allowed network")
	}
}

func TestUnknownEffectHoldsWithoutFurtherMutation(t *testing.T) {
	for _, op := range []native.Operation{native.CreateOperation, native.ResumeOperation, native.StageOperation, native.PrepareEgressOperation, native.DenyOperation, native.StartOperation, native.SuspendOperation} {
		t.Run(string(op), func(t *testing.T) {
			c, s, e := setup(t)
			e.errorOperation = op
			_, err := c.RunOnce(context.Background())
			if err == nil || !s.failed || s.finished {
				t.Fatal("unknown resolved")
			}
			if e.calls[len(e.calls)-1] != op {
				t.Fatalf("continued after unknown: %v", e.calls)
			}
		})
	}
}

func TestUnconfirmedIntentNeverDispatches(t *testing.T) {
	c, s, e := setup(t)
	s.intentError = native.ResumeOperation
	_, err := c.RunOnce(context.Background())
	if err == nil || len(e.calls) != 1 || e.calls[0] != native.CreateOperation {
		t.Fatalf("dispatched without confirmed intent: %v", e.calls)
	}
}

func TestExistingIntentNeverReplaysExecute(t *testing.T) {
	c, s, e := setup(t)
	s.claim.Effects = map[native.Operation]Effect{native.CreateOperation: {OperationID: "already-sent"}}
	_, err := c.RunOnce(context.Background())
	if err == nil || len(e.calls) != 0 || !s.failed {
		t.Fatal("replayed existing intent")
	}
}

func TestEvidenceLossStopsBeforeNextOperation(t *testing.T) {
	c, s, e := setup(t)
	s.evidenceError = true
	_, err := c.RunOnce(context.Background())
	if err == nil || len(e.calls) != 1 || !s.failed {
		t.Fatal("continued after evidence write lost")
	}
}

func TestHeartbeatLossCancelsInflightAndDoesNotCleanup(t *testing.T) {
	c, s, e := setup(t)
	s.heartbeatError = true
	e.blockResume = true
	_, err := c.RunOnce(context.Background())
	if err == nil || len(e.calls) != 2 || e.calls[1] != native.ResumeOperation || !s.failed {
		t.Fatalf("heartbeat loss continued: %v %v", e.calls, err)
	}
}

func TestRecoveryUsesReadbackAndNeverRestarts(t *testing.T) {
	c, s, e := setup(t)
	s.claim.Kind = "recovery"
	s.claim.Result = &e.result
	s.claim.Effects = map[native.Operation]Effect{native.StartOperation: {OperationID: "old-start"}, native.DenyOperation: {OperationID: "old-deny"}, native.SuspendOperation: {OperationID: "old-suspend"}}
	_, err := c.RunOnce(context.Background())
	if err != nil || !s.finished || len(s.intents) != 0 {
		t.Fatalf("recovery result %v intents %v", err, s.intents)
	}
	for _, op := range e.calls {
		if op != "observe_egress" && op != "observe_stop" {
			t.Fatalf("recovery mutation %v", e.calls)
		}
	}
}

func TestActualWorkerPreventsFinish(t *testing.T) {
	c, s, e := setup(t)
	e.stop = false
	_, err := c.RunOnce(context.Background())
	if err == nil || s.finished || !s.failed {
		t.Fatal("false stop proof accepted")
	}
}

func TestCancellationAfterIntentCannotDispatch(t *testing.T) {
	c, s, e := setup(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.cancelAfterIntent = cancel
	_, err := c.RunOnce(ctx)
	if err == nil || len(e.calls) != 0 || len(s.intents) != 1 || !s.failed {
		t.Fatal("canceled intent dispatched")
	}
}

func TestNormalCompletionCancelsBlockedHeartbeatWithoutHoldingRun(t *testing.T) {
	c, store, _ := setup(t)
	store.blockedHeartbeat = make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	worked, err := c.RunOnce(ctx)
	if !worked || err != nil || !store.finished || store.failed {
		t.Fatalf("normal completion became hold: worked=%v err=%v finished=%v failed=%v", worked, err, store.finished, store.failed)
	}
}
