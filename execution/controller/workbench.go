package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/sori883/agent-workspace/execution/native"
	"time"
)

type WorkbenchExecutor interface {
	StageWorkbench(context.Context, native.WorkbenchRequest, native.Workbench) error
	DefinitionChunk(context.Context, string, native.DefinitionChunk) error
	SealWorkbench(context.Context, native.WorkbenchRequest) error
	StartWorkbench(context.Context, native.WorkbenchRequest) error
	StatusWorkbench(context.Context, native.WorkbenchRequest) (native.WorkbenchStatus, error)
	CollectWorkbench(context.Context, native.WorkbenchRequest) (native.WorkbenchResult, error)
	MailboxWorkbench(context.Context, string) (*native.Mailbox, error)
	ReplyWorkbench(context.Context, *native.Mailbox, []byte) error
}
type CodeExecutor interface {
	WorkbenchExecutor
	ObserveCodeProcessService(context.Context, string) error
	PrepareCodeRunner(context.Context, string, time.Duration) error
	InputChunk(context.Context, native.WorkbenchRequest, native.WorkbenchFile, int, []byte) error
	OutputManifest(context.Context, native.WorkbenchRequest) (native.OutputManifest, error)
	OutputChunk(context.Context, native.WorkbenchRequest, native.OutputManifest, native.OutputFile, int) ([]byte, error)
	ObserveCodeCleanup(context.Context, string) (native.CodeCleanup, error)
}

func (c *Controller) selectWorkbench(claim *Claim) (*Controller, error) {
	selected := *c
	if claim.Workbench.AttemptKind == "runtime" {
		selected.Executor = c.WorkbenchRuntime
		selected.Image = c.WorkbenchRuntimeImage
	} else {
		selected.Executor = c.WorkbenchCode
		selected.Image = c.WorkbenchCodeImage
	}
	if selected.Executor == nil || selected.Image == "" || claim.WorkbenchRequest == nil || claim.Workbench.Validate(*claim.WorkbenchRequest) != nil || claimAgent(claim).Valid() == false || claim.Image != selected.Image {
		return nil, errors.New("invalid_workbench_configuration")
	}
	return &selected, nil
}
func (c *Controller) processWorkbench(ctx context.Context, claim *Claim) error {
	w, r := claim.Workbench, claim.WorkbenchRequest
	executor, ok := c.Executor.(WorkbenchExecutor)
	store, okStore := c.Store.(WorkbenchStore)
	if !ok || !okStore || r == nil || w.Validate(*r) != nil || r.RunID != claim.RunID || claim.Image != c.Image || claim.Generation < 1 || (claim.Kind != "execute" && claim.Kind != "recovery") {
		return errors.New("invalid_workbench_claim")
	}
	if claim.Effects == nil {
		claim.Effects = map[native.Operation]Effect{}
	}
	if claim.WorkbenchResult != nil && claim.WorkbenchResult.Validate(*r) != nil {
		return errors.New("invalid_saved_result")
	}
	if claim.Kind == "execute" && (len(claim.Effects) > 0 || claim.WorkbenchResult != nil) {
		return errors.New("ambiguous_existing_execution")
	}
	if claim.Kind == "execute" && (w.RemainingMS == 0 || w.Mode == "model" && !c.WorkbenchModelEnabled || w.AttemptKind == "python" && !c.WorkbenchPythonEnabled) {
		return ErrGatewayDenied
	}
	deadline := time.Now().Add(time.Duration(w.RemainingMS) * time.Millisecond)
	active, stop := context.WithDeadline(ctx, deadline)
	defer stop()
	if claim.Kind == "execute" {
		if err := c.effect(active, claim, native.CreateOperation, func() error { _, e := c.Executor.Create(active, claim.RunID); return e }); err != nil {
			return err
		}
		if err := c.effect(active, claim, native.ResumeOperation, func() error {
			if _, e := c.Executor.Resume(active, claim.RunID); e != nil {
				return e
			}
			if w.AttemptKind != "python" {
				return nil
			}
			code, ok := executor.(CodeExecutor)
			if !ok {
				return errors.New("code_execution_unavailable")
			}
			if e := c.wait(active, c.ReadyTimeout, func() (bool, error) {
				state, err := c.Executor.ObserveTask(active, claim.RunID)
				if err != nil || state.Phase != "Running" {
					return false, err
				}
				return code.ObserveCodeProcessService(active, claim.RunID) == nil, nil
			}); e != nil {
				return e
			}
			return code.PrepareCodeRunner(active, claim.RunID, time.Until(deadline))
		}); err != nil {
			return err
		}
		if err := c.wait(active, c.ReadyTimeout, func() (bool, error) {
			s, e := executor.StatusWorkbench(active, *r)
			if e != nil && w.AttemptKind == "python" {
				return false, nil
			}
			return e == nil && (s.State == "waiting" || s.State == "staged"), e
		}); err != nil {
			return err
		}
		if err := c.effect(active, claim, native.StageOperation, func() error { return c.stageWorkbench(active, claim, executor, store) }); err != nil {
			return err
		}
		if err := c.effect(active, claim, native.PrepareEgressOperation, func() error {
			o, e := c.Executor.SetEgress(active, claim.RunID, false)
			if e == nil && (!o.Matches || !o.Denied) {
				return errors.New("egress_deny_unconfirmed")
			}
			return e
		}); err != nil {
			return err
		}
		if err := c.effect(active, claim, native.StartOperation, func() error { return executor.StartWorkbench(active, *r) }); err != nil {
			return err
		}
	}
	if claim.Kind == "recovery" {
		stopped, e := c.Executor.ObserveStop(ctx, claim.RunID)
		if e != nil {
			return e
		}
		if stopped.Stopped && !stopped.HasWorker {
			return c.cleanupWorkbench(ctx, claim)
		}
	}
	if claim.WorkbenchResult == nil && claim.Effects[native.StartOperation].OperationID != "" {
		if claim.Kind == "recovery" {
			observed, e := c.Executor.ObserveTask(ctx, claim.RunID)
			if e != nil {
				return e
			}
			if observed.Phase != "Running" {
				return c.cleanupWorkbench(ctx, claim)
			}
		}
		for {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !time.Now().Before(deadline) {
				return ErrGatewayDenied
			}
			if w.AttemptKind == "runtime" && claim.Kind == "execute" {
				if e := c.processMailbox(active, claim); e != nil {
					return e
				}
			}
			state, e := executor.StatusWorkbench(active, *r)
			if e != nil {
				return e
			}
			if state.State == "finished" {
				break
			}
			select {
			case <-active.Done():
				if ctx.Err() == nil {
					return ErrGatewayDenied
				}
				return ctx.Err()
			case <-time.After(c.PollInterval):
			}
		}
		result, e := executor.CollectWorkbench(ctx, *r)
		if e != nil {
			return e
		}
		if result.Validate(*r) != nil {
			return errors.New("invalid_runner_result")
		}
		if e = store.CollectWorkbench(ctx, claim, result); e != nil {
			return e
		}
		claim.WorkbenchResult = &result
	}
	if w.AttemptKind == "python" && claim.WorkbenchResult != nil && claim.WorkbenchResult.Status == "succeeded" {
		if e := c.importOutputs(ctx, claim, store); e != nil {
			return e
		}
	}
	return c.cleanupWorkbench(ctx, claim)
}
func (c *Controller) stageWorkbench(ctx context.Context, claim *Claim, executor WorkbenchExecutor, store WorkbenchStore) error {
	r, w := *claim.WorkbenchRequest, *claim.Workbench
	if err := executor.StageWorkbench(ctx, r, w); err != nil {
		return err
	}
	if w.AttemptKind == "runtime" {
		for _, f := range w.Descriptor.DefinitionManifest {
			hash := sha256.New()
			for i := 0; i < (f.SizeBytes+native.WorkbenchChunkBytes-1)/native.WorkbenchChunkBytes; i++ {
				part, e := store.DefinitionChunk(ctx, claim, f, i)
				if e != nil {
					return e
				}
				data, e := native.DecodeChunk(part.ContentBase64, min(native.WorkbenchChunkBytes, f.SizeBytes-i*native.WorkbenchChunkBytes))
				if e != nil {
					return e
				}
				hash.Write(data)
				if e = executor.DefinitionChunk(ctx, r.RunID, part); e != nil {
					return e
				}
			}
			if hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
				return errors.New("definition_hash_mismatch")
			}
		}
	} else {
		code, ok := executor.(CodeExecutor)
		if !ok {
			return errors.New("code_execution_unavailable")
		}
		for _, f := range w.Descriptor.Inputs {
			hash := sha256.New()
			for i := 0; i < (f.SizeBytes+native.WorkbenchChunkBytes-1)/native.WorkbenchChunkBytes; i++ {
				data, e := store.InputChunk(ctx, claim, f, i)
				if e != nil {
					return e
				}
				if len(data) != min(native.WorkbenchChunkBytes, f.SizeBytes-i*native.WorkbenchChunkBytes) {
					return errors.New("invalid_file_chunk")
				}
				hash.Write(data)
				if e = code.InputChunk(ctx, r, f, i, data); e != nil {
					return e
				}
			}
			if hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
				return errors.New("input_hash_mismatch")
			}
		}
	}
	return executor.SealWorkbench(ctx, r)
}
func (c *Controller) importOutputs(ctx context.Context, claim *Claim, store WorkbenchStore) error {
	code, ok := c.Executor.(CodeExecutor)
	if !ok {
		return errors.New("code_execution_unavailable")
	}
	r, w := *claim.WorkbenchRequest, *claim.Workbench
	manifest, e := code.OutputManifest(ctx, r)
	if e != nil {
		return e
	}
	if manifest.Validate(r, w) != nil {
		return errors.New("invalid_output_manifest")
	}
	for _, f := range manifest.Outputs {
		if e = store.OutputBegin(ctx, claim, f.Alias, f.SizeBytes, f.SHA256); e != nil {
			return e
		}
		hash := sha256.New()
		for i := 0; i < (f.SizeBytes+native.WorkbenchChunkBytes-1)/native.WorkbenchChunkBytes; i++ {
			data, e := code.OutputChunk(ctx, r, manifest, f, i)
			if e != nil {
				return e
			}
			if len(data) != min(native.WorkbenchChunkBytes, f.SizeBytes-i*native.WorkbenchChunkBytes) {
				return errors.New("invalid_file_chunk")
			}
			hash.Write(data)
			if e = store.OutputChunk(ctx, claim, f.Alias, i, data); e != nil {
				return e
			}
		}
		if hex.EncodeToString(hash.Sum(nil)) != f.SHA256 {
			return errors.New("output_hash_mismatch")
		}
		if e = store.OutputSeal(ctx, claim, f.Alias); e != nil {
			return e
		}
	}
	return nil
}
func (c *Controller) cleanupWorkbench(ctx context.Context, claim *Claim) error {
	if err := c.cleanupAndFinish(ctx, claim); err != nil {
		return err
	}
	if claim.Workbench.AttemptKind != "python" {
		return nil
	}
	code, ok := c.Executor.(CodeExecutor)
	store, okStore := c.Store.(WorkbenchStore)
	if !ok || !okStore {
		return errors.New("code_cleanup_unavailable")
	}
	return c.wait(ctx, c.StopTimeout, func() (bool, error) {
		proof, e := code.ObserveCodeCleanup(ctx, claim.RunID)
		if e != nil {
			return false, e
		}
		if proof.Validate(claim.RunID, claim.Image) != nil {
			return false, nil
		}
		e = store.CodeCleanup(ctx, claim, proof)
		return e == nil, e
	})
}

type workbenchMailbox struct{ executor WorkbenchExecutor }

func (e workbenchMailbox) Mailbox(ctx context.Context, run string) (*native.Mailbox, error) {
	return e.executor.MailboxWorkbench(ctx, run)
}
func (e workbenchMailbox) Reply(ctx context.Context, m *native.Mailbox, b []byte) error {
	return e.executor.ReplyWorkbench(ctx, m, b)
}
func (c *Controller) mailboxExecutor(claim *Claim) (MailboxExecutor, bool) {
	if claim.Workbench != nil {
		e, ok := c.Executor.(WorkbenchExecutor)
		return workbenchMailbox{e}, ok
	}
	e, ok := c.Executor.(MailboxExecutor)
	return e, ok
}
