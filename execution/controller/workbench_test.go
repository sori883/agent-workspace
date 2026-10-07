package controller

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
	"strings"
	"testing"
	"time"
)

const rootID = "11111111-1111-4111-8111-111111111111"

type workStore struct {
	*fakeStore
	input, output                        []byte
	parts                                int
	sealed, cleanup                      bool
	outputLost, inputRevoked, finishLost bool
	saved                                map[int][]byte
}

func (s *workStore) Reserve(_ context.Context, _ *Claim, m *native.Mailbox) (Reservation, error) {
	if p, ok := s.saved[m.Request.Sequence]; ok {
		return Reservation{Response: p, ProfileID: gateway.PreviewProfileID}, nil
	}
	limit, out := 6000, 512
	if m.Request.Sequence == 2 {
		limit, out = 0, 0
	}
	return Reservation{Send: true, Response: json.RawMessage("null"), InputLimit: limit, OutputLimit: out, ProfileID: gateway.PreviewProfileID}, nil
}
func (s *workStore) AuthorizeGeneration(context.Context, *Claim, *native.Mailbox, string, int) error {
	return nil
}
func (s *workStore) Settle(_ context.Context, _ *Claim, m *native.Mailbox, r []byte, _ map[string]float64, _ int, _ gateway.Evidence) error {
	s.saved[m.Request.Sequence] = r
	return nil
}
func (s *workStore) DefinitionChunk(context.Context, *Claim, native.DefinitionRef, int) (native.DefinitionChunk, error) {
	return native.DefinitionChunk{}, errors.New("unexpected_definition")
}
func (s *workStore) InputChunk(_ context.Context, _ *Claim, _ native.WorkbenchFile, index int) ([]byte, error) {
	if s.inputRevoked {
		return nil, ErrAuthorizationRevoked
	}
	start := index * native.WorkbenchChunkBytes
	return s.input[start:min(len(s.input), start+native.WorkbenchChunkBytes)], nil
}
func (s *workStore) CollectWorkbench(_ context.Context, c *Claim, r native.WorkbenchResult) error {
	s.collected = true
	c.WorkbenchResult = &r
	return nil
}
func (s *workStore) OutputBegin(context.Context, *Claim, string, int, string) error { return nil }
func (s *workStore) OutputChunk(_ context.Context, _ *Claim, _ string, _ int, b []byte) error {
	s.parts++
	s.output = append(s.output, b...)
	if s.outputLost {
		return errors.New("output_import_unconfirmed")
	}
	return nil
}
func (s *workStore) OutputSeal(context.Context, *Claim, string) error { s.sealed = true; return nil }
func (s *workStore) CodeCleanup(context.Context, *Claim, native.CodeCleanup) error {
	s.cleanup = true
	return nil
}
func (s *workStore) Finish(ctx context.Context, c *Claim) error {
	if c.Workbench.AttemptKind == "python" && len(c.Effects) > 0 && !s.cleanup {
		return errors.New("missing_host_cleanup")
	}
	s.finished = true
	if s.finishLost {
		s.finishLost = false
		return errors.New("finish_ack_lost")
	}
	return nil
}

type workExecutor struct {
	*fakeExecutor
	store                                                     *workStore
	claim                                                     *Claim
	replies                                                   int
	replyLost                                                 bool
	started                                                   bool
	output                                                    []byte
	inputParts                                                int
	cleanupMissing                                            bool
	malformedOutput                                           bool
	needsRunner, runnerReady, prepareLost, stopped, guestGone bool
	prepareCalls, outputReads                                 int
	readinessFailures                                         int
	taskNotReady, processUnavailable                          bool
	processReadFailures, processObservations                  int
}

func (e *workExecutor) PrepareCodeRunner(ctx context.Context, _ string, _ time.Duration) error {
	e.prepareCalls++
	if e.store.intents[native.ResumeOperation] == "" {
		return errors.New("missing_resume_intent")
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	e.runnerReady = true
	if e.prepareLost {
		return &native.Error{Operation: native.ResumeOperation, Kind: "unknown", Code: "response_lost"}
	}
	return nil
}
func (e *workExecutor) ObserveStop(ctx context.Context, run string) (native.StopObservation, error) {
	e.calls = append(e.calls, "observe_stop")
	return native.StopObservation{RunID: run, Stopped: e.stopped, HasWorker: !e.stopped}, nil
}
func (e *workExecutor) ObserveTask(context.Context, string) (native.TaskObservation, error) {
	return native.TaskObservation{RunID: runID, Phase: "Running", Ready: !e.taskNotReady}, nil
}
func (e *workExecutor) ObserveCodeProcessService(context.Context, string) error {
	e.processObservations++
	if e.processUnavailable || e.processReadFailures > 0 {
		if e.processReadFailures > 0 {
			e.processReadFailures--
		}
		return errors.New("process_not_ready")
	}
	return nil
}
func (e *workExecutor) Suspend(ctx context.Context, run string) (native.TaskObservation, error) {
	result, err := e.fakeExecutor.Suspend(ctx, run)
	if err == nil {
		e.stopped = true
	}
	return result, err
}
func (e *workExecutor) StageWorkbench(context.Context, native.WorkbenchRequest, native.Workbench) error {
	return e.invoke(native.StageOperation)
}
func (e *workExecutor) DefinitionChunk(context.Context, string, native.DefinitionChunk) error {
	return nil
}
func (e *workExecutor) SealWorkbench(context.Context, native.WorkbenchRequest) error { return nil }
func (e *workExecutor) StartWorkbench(context.Context, native.WorkbenchRequest) error {
	e.started = true
	return e.invoke(native.StartOperation)
}
func (e *workExecutor) StatusWorkbench(context.Context, native.WorkbenchRequest) (native.WorkbenchStatus, error) {
	if e.readinessFailures > 0 {
		e.readinessFailures--
		return native.WorkbenchStatus{}, errors.New("ready_file_missing")
	}
	if e.needsRunner && !e.runnerReady {
		return native.WorkbenchStatus{}, errors.New("runner_not_ready")
	}
	state := "waiting"
	attempted := false
	var result *native.WorkbenchResult
	if e.started {
		state = "running"
		attempted = true
		if e.claim.Workbench.AttemptKind == "python" || e.replies >= 2 {
			state = "finished"
			r := e.resultV2()
			result = &r
		}
	}
	return native.WorkbenchStatus{RunID: runID, State: state, Attempted: attempted, Result: result}, nil
}
func (e *workExecutor) resultV2() native.WorkbenchResult {
	zero := 0.0
	return native.WorkbenchResult{SchemaVersion: 2, RunID: runID, Adapter: e.claim.WorkbenchRequest.Adapter, Status: "succeeded", Summary: "ok", Usage: gateway.ZeroUsage(), EstimatedUSD: &zero}
}
func (e *workExecutor) CollectWorkbench(context.Context, native.WorkbenchRequest) (native.WorkbenchResult, error) {
	return e.resultV2(), nil
}
func (e *workExecutor) MailboxWorkbench(context.Context, string) (*native.Mailbox, error) {
	if e.replies >= 2 {
		return nil, nil
	}
	seq := e.replies + 1
	kind := "model"
	body := map[string]any{"contents": []any{}}
	if seq == 2 {
		kind = "tool"
		body = map[string]any{"kind": "question", "text": "列を指定してください。"}
	}
	raw, _ := json.Marshal(map[string]any{"version": 2, "run_id": runID, "sequence": seq, "kind": kind, "body": body})
	wire, _ := json.Marshal(map[string]string{"request_base64": base64.StdEncoding.EncodeToString(raw), "sha256": native.HashBytes(raw)})
	return native.ParseWorkbenchMailbox(wire, runID)
}
func (e *workExecutor) ReplyWorkbench(_ context.Context, m *native.Mailbox, _ []byte) error {
	if m.Request.Sequence > e.replies {
		e.replies = m.Request.Sequence
	}
	if e.replyLost {
		e.replyLost = false
		return errors.New("reply_ack_lost")
	}
	return nil
}
func (e *workExecutor) InputChunk(context.Context, native.WorkbenchRequest, native.WorkbenchFile, int, []byte) error {
	e.inputParts++
	return nil
}
func (e *workExecutor) OutputManifest(_ context.Context, r native.WorkbenchRequest) (native.OutputManifest, error) {
	e.outputReads++
	if e.guestGone {
		return native.OutputManifest{}, errors.New("guest_stopped")
	}
	want := e.claim.Workbench.Descriptor.Outputs[0]
	m := native.OutputManifest{RunID: runID, DescriptorSHA256: r.DescriptorSHA256, Outputs: []native.OutputFile{{Alias: want.Alias, Name: want.Name, SizeBytes: len(e.output), SHA256: native.HashBytes(e.output)}}}
	raw, _ := native.CanonicalJSON(struct {
		RunID            string              `json:"run_id"`
		DescriptorSHA256 string              `json:"descriptor_sha256"`
		Outputs          []native.OutputFile `json:"outputs"`
	}{m.RunID, m.DescriptorSHA256, m.Outputs})
	m.ManifestSHA256 = native.HashBytes(raw)
	if e.malformedOutput {
		m.Outputs[0].Name = "other.csv"
	}
	return m, nil
}
func (e *workExecutor) OutputChunk(_ context.Context, _ native.WorkbenchRequest, _ native.OutputManifest, _ native.OutputFile, index int) ([]byte, error) {
	start := index * native.WorkbenchChunkBytes
	return e.output[start:min(len(e.output), start+native.WorkbenchChunkBytes)], nil
}
func (e *workExecutor) ObserveCodeCleanup(context.Context, string) (native.CodeCleanup, error) {
	if e.cleanupMissing {
		return native.CodeCleanup{}, nil
	}
	return native.CodeCleanup{Actor: runID, ActorUID: "actor-uid", WorkerUID: "worker-uid", Generation: rootID, Image: image, Profile: native.CodeProfile, Cleaned: true}, nil
}
func setupWorkbench(t *testing.T, python bool) (*Controller, *workStore, *workExecutor) {
	t.Helper()
	w := native.Workbench{Version: 2, AttemptKind: "runtime", ExecutionPolicy: native.WorkbenchPolicy, Mode: "preview", ProfileID: gateway.PreviewProfileID, RemainingMS: 300000, Descriptor: native.WorkbenchDescriptor{Version: 2, RootID: rootID, Instruction: "sum", DefinitionManifest: []native.DefinitionRef{}, Inputs: []native.WorkbenchFile{}, Outputs: []native.WorkbenchOutput{}, History: []native.WorkbenchHistory{}, Code: nil}}
	r := native.WorkbenchRequest{SchemaVersion: 2, RunID: runID, RootID: rootID, Adapter: "interactive"}
	if python {
		w.AttemptKind = "python"
		r.Adapter = "python"
		profile := native.CodeProfile
		w.Descriptor.CodeProfile = &profile
		w.Descriptor.Inputs = []native.WorkbenchFile{{Alias: "input_1", FileID: rootID, Name: "in.csv", SizeBytes: native.WorkbenchFileBytes, SHA256: native.HashBytes([]byte(strings.Repeat("x", native.WorkbenchFileBytes)))}}
		w.Descriptor.Outputs = []native.WorkbenchOutput{{Alias: "output_2_1", Name: "result.csv", SizeLimitBytes: native.WorkbenchFileBytes}}
		codeRaw := json.RawMessage(`{"kind":"python","source":"print('ok')","input_aliases":["input_1"],"outputs":[{"name":"result.csv","size_limit_bytes":8388608}],"purpose":"sum"}`)
		w.Descriptor.Code = &codeRaw
	}
	raw, _ := native.CanonicalJSON(w.Descriptor)
	r.DescriptorSHA256 = native.HashBytes(raw)
	claim := &Claim{RunID: runID, Generation: 1, Kind: "execute", Image: image, Effects: map[native.Operation]Effect{}, Workbench: &w, WorkbenchRequest: &r}
	base := &fakeStore{claim: claim, intents: map[native.Operation]string{}}
	store := &workStore{fakeStore: base, saved: map[int][]byte{}}
	exe := &workExecutor{fakeExecutor: &fakeExecutor{store: base, stop: true}, store: store, claim: claim}
	if python {
		store.input = []byte(strings.Repeat("x", native.WorkbenchFileBytes))
		exe.output = []byte(strings.Repeat("y", native.WorkbenchFileBytes))
	}
	c := New(store, exe, image)
	c.WorkbenchRuntime = exe
	c.WorkbenchRuntimeImage = image
	c.WorkbenchCode = exe
	c.WorkbenchCodeImage = image
	c.WorkbenchPythonEnabled = true
	c.PollInterval = time.Millisecond
	c.StopTimeout = 3 * time.Millisecond
	c.HeartbeatInterval = time.Hour
	return c, store, exe
}
func TestWorkbenchRuntimeCompletesAfterTwoMailboxes(t *testing.T) {
	c, s, e := setupWorkbench(t, false)
	e.replyLost = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.finished || s.failed || len(s.saved) != 2 || e.replies != 2 || !s.collected {
		t.Fatal("runtime did not complete")
	}
}
func TestWorkbenchEightMiBStreamsAndSealsBeforeHostCleanup(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.finished || !s.sealed || !s.cleanup || s.parts != 256 || e.inputParts != 256 || len(s.output) != native.WorkbenchFileBytes || native.HashBytes(s.output) != native.HashBytes(e.output) {
		t.Fatal("binary transfer or ordering incomplete")
	}
}
func TestWorkbenchKnownRevocationCleansButCannotStart(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	s.inputRevoked = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.started || !s.finished || !s.cleanup {
		t.Fatal("revocation restarted or skipped cleanup")
	}
}
func TestWorkbenchUnknownStartNeverResends(t *testing.T) {
	c, s, e := setupWorkbench(t, false)
	e.errorOperation = native.StartOperation
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("unknown accepted")
	}
	if !s.failed || s.finished {
		t.Fatal("unknown did not hold")
	}
	count := 0
	for _, op := range e.calls {
		if op == native.StartOperation {
			count++
		}
	}
	if count != 1 {
		t.Fatal("start resend")
	}
}
func TestWorkbenchPythonGateClosedCreatesNothing(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	c.WorkbenchPythonEnabled = false
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(e.calls) != 0 || !s.finished {
		t.Fatal("closed gate sent side effect")
	}
}
func TestWorkbenchMissingCleanupCannotReleaseSlot(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.cleanupMissing = true
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("missing cleanup accepted")
	}
	if s.finished || !s.sealed || !s.failed {
		t.Fatal("cleanup uncertainty not held")
	}
}
func TestWorkbenchOutputACKLossRetainsHold(t *testing.T) {
	c, s, _ := setupWorkbench(t, true)
	s.outputLost = true
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("lost output ack accepted")
	}
	if s.finished || s.sealed || !s.failed || s.parts != 1 {
		t.Fatal("unknown output auto retried")
	}
}
func TestWorkbenchRecoveryOnlyCollectsAndStops(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	s.claim.Kind = "recovery"
	e.started = true
	for _, op := range []native.Operation{native.CreateOperation, native.ResumeOperation, native.StageOperation, native.PrepareEgressOperation, native.StartOperation} {
		s.claim.Effects[op] = Effect{OperationID: string(op), Evidence: map[string]any{"confirmed": true, "actor": runID}}
	}
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, op := range e.calls {
		if op != native.DenyOperation && op != native.SuspendOperation && op != "observe_stop" {
			t.Fatalf("recovery side effect %s", op)
		}
	}
	if !s.finished {
		t.Fatal("recovery incomplete")
	}
}

func TestWorkbenchFinishACKLossReadsSameCompletion(t *testing.T) {
	c, s, e := setupWorkbench(t, false)
	s.finishLost = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.finished || s.failed {
		t.Fatal("completion readback failed")
	}
	n := 0
	for _, op := range e.calls {
		if op == native.StartOperation {
			n++
		}
	}
	if n != 1 {
		t.Fatal("finish readback repeated Start")
	}
}
func TestWorkbenchLeaseHeartbeatLossCannotDispatchStartOrCleanup(t *testing.T) {
	c, s, e := setupWorkbench(t, false)
	s.heartbeatError = true
	e.blockResume = true
	c.HeartbeatInterval = time.Millisecond
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("lease uncertainty accepted")
	}
	if e.started || s.finished || !s.failed {
		t.Fatal("lease failure did not hold")
	}
	for _, op := range e.calls {
		if op == native.StartOperation || op == native.DenyOperation || op == native.SuspendOperation {
			t.Fatalf("effect after lost authority %s", op)
		}
	}
}

func TestWorkbenchCodeStartsTrustedWaitOnceBeforeStaging(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.needsRunner = true
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.prepareCalls != 1 || !e.runnerReady || !e.started || !s.finished {
		t.Fatal("trusted wait was not prepared exactly once")
	}
	if s.claim.Effects[native.ResumeOperation].Evidence["confirmed"] != true {
		t.Fatal("resume evidence missing")
	}
}
func TestWorkbenchTrustedWaitACKBeforeReadyOnlyRepollsStatus(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.needsRunner = true
	e.readinessFailures = 2
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.prepareCalls != 1 || e.readinessFailures != 0 || !s.finished {
		t.Fatal("ready observation restarted trusted wait")
	}
}

func TestWorkbenchTrustedWaitACKLossHoldsAndRecoveryNeverRestarts(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.prepareLost = true
	e.needsRunner = true
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("lost trusted wait ACK was accepted")
	}
	if e.prepareCalls != 1 || e.started || s.finished || !s.failed || s.claim.Effects[native.ResumeOperation].Evidence != nil {
		t.Fatal("uncertain preparation was not held")
	}
	s.claim.Kind = "recovery"
	s.failed = false
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.prepareCalls != 1 || e.started || !s.finished {
		t.Fatal("recovery resent trusted wait")
	}
}
func TestWorkbenchExistingResumeCannotStartTrustedWait(t *testing.T) {
	for _, kind := range []string{"execute", "recovery"} {
		t.Run(kind, func(t *testing.T) {
			c, s, e := setupWorkbench(t, true)
			s.claim.Kind = kind
			s.claim.Effects[native.ResumeOperation] = Effect{OperationID: "already-resumed", Evidence: map[string]any{"actor": runID, "confirmed": true}}
			_, err := c.RunOnce(context.Background())
			if kind == "execute" && err == nil {
				t.Fatal("existing execution accepted")
			}
			if kind == "recovery" && err != nil {
				t.Fatal(err)
			}
			if e.prepareCalls != 0 || e.started {
				t.Fatal("existing resume caused another start")
			}
		})
	}
}
func TestWorkbenchStoppedRecoveryKeepsSealedOutputsWithoutGuestReads(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	s.claim.Kind = "recovery"
	e.stopped = true
	e.guestGone = true
	s.sealed = true
	result := e.resultV2()
	s.claim.WorkbenchResult = &result
	for _, op := range []native.Operation{native.CreateOperation, native.ResumeOperation, native.StageOperation, native.PrepareEgressOperation, native.StartOperation, native.DenyOperation, native.SuspendOperation} {
		s.claim.Effects[op] = Effect{OperationID: string(op), Evidence: map[string]any{"confirmed": true, "actor": runID}}
	}
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.outputReads != 0 || s.parts != 0 || !s.sealed || !s.cleanup || !s.finished {
		t.Fatal("stopped recovery reread guest or lost saved outputs")
	}
	for _, op := range e.calls {
		if op != "observe_stop" && op != "observe_egress" {
			t.Fatalf("unexpected recovery side effect %s", op)
		}
	}
}

func TestWorkbenchCodeUsesDirectProcessReadinessWithoutAXHTTPReady(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.taskNotReady, e.needsRunner = true, true
	c.ReadyTimeout = 15 * time.Millisecond
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.finished || e.processObservations != 1 || e.prepareCalls != 1 {
		t.Fatal("direct process readiness did not permit one trusted start")
	}
}
func TestWorkbenchCodeCannotStartWithoutDirectProcessReadiness(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.processUnavailable = true
	c.ReadyTimeout = 15 * time.Millisecond
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("missing process service accepted")
	}
	if e.prepareCalls != 0 || e.started || s.finished || !s.failed {
		t.Fatal("unavailable process service still started work")
	}
}
func TestWorkbenchCodeOnlyRepollsReadinessBeforeOneTrustedStart(t *testing.T) {
	c, s, e := setupWorkbench(t, true)
	e.processReadFailures = 2
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if e.processObservations != 3 || e.prepareCalls != 1 || !s.finished {
		t.Fatal("readiness retry did not stay read-only")
	}
}
