package controller

import (
	"context"
	"errors"
	"time"

	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

type Effect struct {
	OperationID string         `json:"operation_id"`
	Evidence    map[string]any `json:"evidence"`
}

type Claim struct {
	Workbench        *native.Workbench           `json:"-"`
	WorkbenchRequest *native.WorkbenchRequest    `json:"-"`
	WorkbenchResult  *native.WorkbenchResult     `json:"-"`
	Manifest         *native.TaskManifest        `json:"-"`
	RunID            string                      `json:"run_id"`
	Generation       int64                       `json:"generation"`
	Kind             string                      `json:"kind"`
	Request          native.Request              `json:"request"`
	Image            string                      `json:"image"`
	Result           *native.Result              `json:"result"`
	Effects          map[native.Operation]Effect `json:"effects"`
	Agent            *gateway.Agent              `json:"agent"`
}

type Store interface {
	Claim(context.Context) (*Claim, error)
	Heartbeat(context.Context, *Claim) error
	Intent(context.Context, *Claim, native.Operation) (string, error)
	Evidence(context.Context, *Claim, string, map[string]any) error
	Collect(context.Context, *Claim, native.Collection) error
	Finish(context.Context, *Claim) error
	Fail(context.Context, *Claim, string) error
}

type Executor interface {
	Create(context.Context, string) (native.TaskObservation, error)
	Resume(context.Context, string) (native.TaskObservation, error)
	ObserveTask(context.Context, string) (native.TaskObservation, error)
	Stage(context.Context, native.Request) error
	Start(context.Context, string) error
	Status(context.Context, native.Request) (native.RunnerStatus, error)
	Collect(context.Context, native.Request) (native.Collection, error)
	SetEgress(context.Context, string, bool) (native.EgressObservation, error)
	ObserveEgress(context.Context, string, bool) (native.EgressObservation, error)
	Suspend(context.Context, string) (native.TaskObservation, error)
	ObserveStop(context.Context, string) (native.StopObservation, error)
}

type Controller struct {
	WorkbenchRuntime       Executor
	WorkbenchCode          Executor
	WorkbenchRuntimeImage  string
	WorkbenchCodeImage     string
	WorkbenchModelEnabled  bool
	WorkbenchPythonEnabled bool
	Store                  Store
	Executor               Executor
	InteractiveExecutor    Executor
	InteractiveImage       string
	ModelProvider          gateway.Provider
	Image                  string
	PollInterval           time.Duration
	HeartbeatInterval      time.Duration
	ReadyTimeout           time.Duration
	ResultTimeout          time.Duration
	StopTimeout            time.Duration
}

var ErrHeld = errors.New("execution_held")
var ErrAuthorizationRevoked = errors.New("workspace_access_revoked")

func New(store Store, executor Executor, image string) *Controller {
	return &Controller{Store: store, Executor: executor, Image: image, PollInterval: time.Second, HeartbeatInterval: 10 * time.Second, ReadyTimeout: 45 * time.Second, ResultTimeout: 120 * time.Second, StopTimeout: 60 * time.Second}
}

func (c *Controller) RunOnce(ctx context.Context) (bool, error) {
	claim, err := c.Store.Claim(ctx)
	if err != nil || claim == nil {
		return false, err
	}
	if claim.Workbench != nil {
		selected, e := c.selectWorkbench(claim)
		if e != nil {
			failedCtx, stop := context.WithTimeout(ctx, 5*time.Second)
			defer stop()
			_ = c.Store.Fail(failedCtx, claim, "invalid_workbench_configuration")
			return true, e
		}
		c = selected
	} else if claim.Request.Adapter == "interactive" {
		if c.InteractiveExecutor == nil || c.InteractiveImage == "" || claim.Agent == nil || !claim.Agent.Valid() {
			return true, errors.New("interactive_executor_unavailable")
		}
		selected := *c
		selected.Executor, selected.Image = c.InteractiveExecutor, c.InteractiveImage
		c = &selected
	}
	work, cancel := context.WithCancel(ctx)
	beatDone := make(chan struct{})
	beatError := make(chan error, 1)
	go func() {
		defer close(beatDone)
		ticker := time.NewTicker(c.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-work.Done():
				return
			case <-ticker.C:
				if err := c.Store.Heartbeat(work, claim); err != nil {
					if work.Err() != nil {
						return
					}
					beatError <- err
					cancel()
					return
				}
			}
		}
	}()
	err = c.process(work, claim)
	start := claim.Effects[native.StartOperation]
	unknownCompletedModel := errors.Is(err, ErrModelUsageUnknown) && (claim.Request.Adapter == "interactive" || claim.Workbench != nil && claim.Workbench.AttemptKind == "runtime") && claim.Kind == "execute" && start.Evidence["confirmed"] == true && start.Evidence["actor"] == claim.RunID
	if (errors.Is(err, ErrAuthorizationRevoked) || errors.Is(err, ErrGatewayDenied) || unknownCompletedModel) && work.Err() == nil {
		if len(claim.Effects) == 0 {
			err = nil
		} else {
			if claim.Workbench != nil {
				err = c.cleanupWorkbench(work, claim)
			} else {
				err = c.cleanupAndFinish(work, claim)
			}
		}
	}
	cancel()
	<-beatDone
	select {
	case beatErr := <-beatError:
		if err == nil {
			err = beatErr
		}
	default:
	}
	if err == nil {
		err = c.Store.Finish(ctx, claim)
		if err != nil && claim.Workbench != nil && !errors.Is(err, ErrHeld) && ctx.Err() == nil {
			readback, stop := context.WithTimeout(ctx, 5*time.Second)
			err = c.Store.Finish(readback, claim)
			stop()
		}
	}
	if errors.Is(err, ErrHeld) {
		return true, err
	}
	if err != nil {
		failedCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if c.Store.Fail(failedCtx, claim, safeCode(err)) != nil {
			return true, errors.New("execution_failed_record_unconfirmed")
		}
	}
	return true, err
}

func (c *Controller) process(ctx context.Context, claim *Claim) error {
	if claim.Workbench != nil {
		return c.processWorkbench(ctx, claim)
	}
	activeStarted := time.Now()
	if claim.Request.Validate() != nil || claim.RunID != claim.Request.RunID || claim.Image != c.Image || claim.Generation <= 0 || (claim.Kind != "execute" && claim.Kind != "recovery") {
		return errors.New("invalid_claim")
	}
	if claim.Effects == nil {
		claim.Effects = map[native.Operation]Effect{}
	}
	if claim.Result != nil && claim.Result.Validate(claim.Request) != nil {
		return errors.New("invalid_saved_result")
	}
	if claim.Kind == "execute" {
		if len(claim.Effects) != 0 || claim.Result != nil {
			return errors.New("existing_execution_intent")
		}
		if err := c.effect(ctx, claim, native.CreateOperation, func() error { _, err := c.Executor.Create(ctx, claim.RunID); return err }); err != nil {
			return err
		}
		if err := c.effect(ctx, claim, native.ResumeOperation, func() error { _, err := c.Executor.Resume(ctx, claim.RunID); return err }); err != nil {
			return err
		}
		if err := c.wait(ctx, c.ReadyTimeout, func() (bool, error) { _, err := c.Executor.Status(ctx, claim.Request); return err == nil, nil }); err != nil {
			return err
		}
		if err := c.effect(ctx, claim, native.StageOperation, func() error { return c.Executor.Stage(ctx, claim.Request) }); err != nil {
			return err
		}
		if claim.Request.Adapter == "antigravity" {
			if err := c.effect(ctx, claim, native.AllowOperation, func() error {
				observation, err := c.Executor.SetEgress(ctx, claim.RunID, true)
				if err == nil && !observation.Matches {
					return errors.New("egress_unconfirmed")
				}
				return err
			}); err != nil {
				return err
			}
		} else {
			if err := c.effect(ctx, claim, native.PrepareEgressOperation, func() error {
				observation, err := c.Executor.SetEgress(ctx, claim.RunID, false)
				if err == nil && (!observation.Matches || !observation.Denied) {
					return errors.New("egress_unconfirmed")
				}
				return err
			}); err != nil {
				return err
			}
		}
		activeStarted = time.Now()
		if err := c.effect(ctx, claim, native.StartOperation, func() error { return c.Executor.Start(ctx, claim.RunID) }); err != nil {
			return err
		}
	}
	if claim.Result == nil {
		_, started := claim.Effects[native.StartOperation]
		if started {
			if claim.Kind == "recovery" {
				task, err := c.Executor.ObserveTask(ctx, claim.RunID)
				if err != nil {
					return err
				}
				if task.Phase != "Running" {
					return c.cleanupAndFinish(ctx, claim)
				}
			}
			var waitError error
			if claim.Request.Adapter == "interactive" && claim.Kind == "execute" {
				waitError = c.waitInteractive(ctx, claim, activeStarted)
			} else {
				waitError = c.wait(ctx, c.ResultTimeout, func() (bool, error) {
					state, err := c.Executor.Status(ctx, claim.Request)
					if err != nil {
						return false, err
					}
					return state.State == "finished", nil
				})
			}
			if waitError != nil {
				return waitError
			}
			collection, err := c.Executor.Collect(ctx, claim.Request)
			if err != nil {
				return err
			}
			if err = c.Store.Collect(ctx, claim, collection); err != nil {
				return err
			}
			claim.Result = &collection.Result
		}
	}
	return c.cleanupAndFinish(ctx, claim)
}

func (c *Controller) effect(ctx context.Context, claim *Claim, operation native.Operation, invoke func() error) error {
	if _, exists := claim.Effects[operation]; exists {
		return errors.New("existing_execution_intent")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	operationID, err := c.Store.Intent(ctx, claim, operation)
	if err != nil {
		return err
	}
	claim.Effects[operation] = Effect{OperationID: operationID}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err = invoke(); err != nil {
		return err
	}
	evidence := map[string]any{"confirmed": true, "actor": claim.RunID}
	if err = c.Store.Evidence(ctx, claim, operationID, evidence); err != nil {
		return err
	}
	claim.Effects[operation] = Effect{OperationID: operationID, Evidence: evidence}
	return nil
}

func (c *Controller) deny(ctx context.Context, claim *Claim) error {
	effect, exists := claim.Effects[native.DenyOperation]
	if !exists {
		operationID, err := c.Store.Intent(ctx, claim, native.DenyOperation)
		if err != nil {
			return err
		}
		effect = Effect{OperationID: operationID}
		claim.Effects[native.DenyOperation] = effect
		if err := ctx.Err(); err != nil {
			return err
		}
		observation, err := c.Executor.SetEgress(ctx, claim.RunID, false)
		if err != nil {
			return err
		}
		if !observation.Denied || !observation.Matches {
			return errors.New("egress_unconfirmed")
		}
	} else {
		observation, err := c.Executor.ObserveEgress(ctx, claim.RunID, false)
		if err != nil {
			return err
		}
		if !observation.Denied || !observation.Matches {
			return errors.New("egress_unconfirmed")
		}
	}
	evidence := map[string]any{"egress_denied": true, "actor": claim.RunID}
	if err := c.Store.Evidence(ctx, claim, effect.OperationID, evidence); err != nil {
		return err
	}
	claim.Effects[native.DenyOperation] = Effect{OperationID: effect.OperationID, Evidence: evidence}
	return nil
}

func (c *Controller) cleanupAndFinish(ctx context.Context, claim *Claim) error {
	if err := c.deny(ctx, claim); err != nil {
		return err
	}
	effect, exists := claim.Effects[native.SuspendOperation]
	if !exists {
		operationID, err := c.Store.Intent(ctx, claim, native.SuspendOperation)
		if err != nil {
			return err
		}
		effect = Effect{OperationID: operationID}
		claim.Effects[native.SuspendOperation] = effect
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err = c.Executor.Suspend(ctx, claim.RunID); err != nil {
			return err
		}
	}
	if err := c.wait(ctx, c.StopTimeout, func() (bool, error) {
		observation, err := c.Executor.ObserveStop(ctx, claim.RunID)
		if err != nil {
			return false, err
		}
		return observation.Stopped && !observation.HasWorker, nil
	}); err != nil {
		return err
	}
	evidence := map[string]any{"phase": "SUSPENDED", "worker_assignment": nil, "actor": claim.RunID}
	if err := c.Store.Evidence(ctx, claim, effect.OperationID, evidence); err != nil {
		return err
	}
	return nil
}

func (c *Controller) wait(ctx context.Context, timeout time.Duration, observe func() (bool, error)) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		ready, err := observe()
		if err != nil {
			return err
		}
		if ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("observation_timeout")
		case <-time.After(c.PollInterval):
		}
	}
}

func safeCode(err error) string {
	var external *native.Error
	if errors.As(err, &external) {
		if external.Kind == "unknown" {
			return "external_effect_unknown"
		}
		return "external_observation_failed"
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "controller_interrupted"
	}
	return "execution_unconfirmed"
}
