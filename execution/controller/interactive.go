package controller

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

var ErrGatewayDenied = errors.New("agent_send_denied")
var ErrModelUsageUnknown = errors.New("model_usage_unknown")

type Reservation struct {
	Send        bool            `json:"send"`
	Response    json.RawMessage `json:"response"`
	InputLimit  int             `json:"input_limit"`
	OutputLimit int             `json:"output_limit"`
	ProfileID   string          `json:"profile_id"`
}
type AgentStore interface {
	Reserve(context.Context, *Claim, *native.Mailbox) (Reservation, error)
	AuthorizeGeneration(context.Context, *Claim, *native.Mailbox, string, int) error
	Settle(context.Context, *Claim, *native.Mailbox, []byte, map[string]float64, int, gateway.Evidence) error
}
type MailboxExecutor interface {
	Mailbox(context.Context, string) (*native.Mailbox, error)
	Reply(context.Context, *native.Mailbox, []byte) error
}

func (c *Controller) processMailbox(ctx context.Context, claim *Claim) error {
	store, ok := c.Store.(AgentStore)
	executor, okExecutor := c.Executor.(MailboxExecutor)
	if !ok || !okExecutor {
		return errors.New("interactive_gateway_unavailable")
	}
	mailbox, err := executor.Mailbox(ctx, claim.RunID)
	if err != nil || mailbox == nil {
		return err
	}
	began := time.Now()
	reservation, err := store.Reserve(ctx, claim, mailbox)
	if err != nil {
		return err
	}
	if claim.Agent == nil || !claim.Agent.Valid() || reservation.ProfileID != claim.Agent.ProfileID {
		return errors.New("invalid_gateway_reservation")
	}
	reply := []byte(reservation.Response)
	if reservation.Send {
		if err := ctx.Err(); err != nil {
			return err
		}
		var usage map[string]float64
		var evidence gateway.Evidence
		reply, usage, evidence, err = c.respond(ctx, store, claim, mailbox, reservation)
		if err != nil {
			return err
		}
		settleContext, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		err = store.Settle(settleContext, claim, mailbox, reply, usage, int(time.Since(began).Milliseconds()), evidence)
		stop()
		if err != nil {
			return err
		}
		observed, readErr := store.Reserve(ctx, claim, mailbox)
		if readErr != nil || observed.Send || observed.ProfileID != claim.Agent.ProfileID {
			return errors.New("gateway_settlement_unconfirmed")
		}
		reply = observed.Response
	}
	parsed, err := native.ParseReply(reply, mailbox)
	if err != nil {
		return errors.New("invalid_gateway_response")
	}
	if parsed.Status == "denied" {
		return ErrGatewayDenied
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err = executor.Reply(ctx, mailbox, reply); err != nil {
		if ctx.Err() != nil {
			return err
		}
		observed, readErr := store.Reserve(ctx, claim, mailbox)
		if readErr != nil || observed.Send {
			return errors.New("gateway_reply_unconfirmed")
		}
		if _, readErr = native.ParseReply(observed.Response, mailbox); readErr != nil {
			return errors.New("gateway_reply_unconfirmed")
		}
		var sent, saved any
		if json.Unmarshal(reply, &sent) != nil || json.Unmarshal(observed.Response, &saved) != nil || !reflect.DeepEqual(sent, saved) {
			return errors.New("gateway_reply_changed")
		}
		return executor.Reply(ctx, mailbox, observed.Response)
	}
	return nil
}

func (c *Controller) respond(ctx context.Context, store AgentStore, claim *Claim, mailbox *native.Mailbox, reservation Reservation) ([]byte, map[string]float64, gateway.Evidence, error) {
	if claim.Agent.Mode == "preview" || mailbox.Request.Kind == "tool" {
		reply, usage, err := gateway.Respond(claim.Request, mailbox)
		return reply, usage, gateway.Evidence{Outcome: "ok", Code: "ok"}, err
	}
	evidence := gateway.Evidence{Outcome: "no_send", Code: "model_not_configured"}
	noSend := func(code string) ([]byte, map[string]float64, gateway.Evidence, error) {
		evidence.Code = code
		usage := gateway.ZeroUsage()
		reply, err := gateway.ModelReply(mailbox, gateway.Generated{Usage: usage, Evidence: evidence})
		return reply, usage, evidence, err
	}
	if c.ModelProvider == nil {
		return noSend("model_not_configured")
	}
	limits := gateway.Limits{Input: reservation.InputLimit, Output: reservation.OutputLimit}
	prepared, err := gateway.Prepare(claim.Request, mailbox, limits)
	if err != nil {
		return noSend("model_request_invalid")
	}
	evidence.PayloadSHA256 = &prepared.SHA256
	if ctx.Err() != nil {
		return noSend("model_deadline")
	}
	evidence.CountAttempt = 1
	count, err := c.ModelProvider.Count(ctx, prepared)
	if err != nil {
		return noSend("model_count_failed")
	}
	evidence.CountedInputTokens = &count
	if count <= 0 || count > limits.Input-gateway.InputMargin {
		return noSend("model_input_limit")
	}
	if ctx.Err() != nil {
		return noSend("model_deadline")
	}
	if err = store.AuthorizeGeneration(ctx, claim, mailbox, prepared.SHA256, count); err != nil {
		if errors.Is(err, ErrGatewayDenied) || errors.Is(err, ErrAuthorizationRevoked) {
			return noSend("model_authorization_revoked")
		}
		return nil, nil, evidence, err
	}
	if ctx.Err() != nil {
		return nil, nil, evidence, errors.New("model_send_unconfirmed")
	}
	result, err := c.ModelProvider.Generate(ctx, prepared, limits)
	if err != nil {
		return nil, nil, evidence, ErrModelUsageUnknown
	}
	result.Evidence.CountAttempt = 1
	result.Evidence.CountedInputTokens = &count
	reply, err := gateway.ModelReply(mailbox, result)
	return reply, result.Usage, result.Evidence, err
}

func (c *Controller) waitInteractive(ctx context.Context, claim *Claim, started time.Time) error {
	runtime, err := claim.Request.Runtime()
	if err != nil {
		return err
	}
	deadline := started.Add(time.Duration(runtime.RemainingMS) * time.Millisecond)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !time.Now().Before(deadline) {
			return ErrGatewayDenied
		}
		bounded, cancel := context.WithDeadline(ctx, deadline)
		err = c.processMailbox(bounded, claim)
		if err == nil {
			var state native.RunnerStatus
			state, err = c.Executor.Status(bounded, claim.Request)
			if err == nil && state.State == "finished" {
				cancel()
				return nil
			}
		}
		cancel()
		if err != nil {
			if ctx.Err() == nil && !time.Now().Before(deadline) {
				return ErrGatewayDenied
			}
			return err
		}
		timer := time.NewTimer(c.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
