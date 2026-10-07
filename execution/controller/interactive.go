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

type Reservation struct {
	Send     bool            `json:"send"`
	Response json.RawMessage `json:"response"`
}
type AgentStore interface {
	Reserve(context.Context, *Claim, *native.Mailbox) (Reservation, error)
	Settle(context.Context, *Claim, *native.Mailbox, []byte, map[string]float64, int) error
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
	reply := []byte(reservation.Response)
	if reservation.Send {
		if err := ctx.Err(); err != nil {
			return err
		}
		var usage map[string]float64
		reply, usage, err = gateway.Respond(claim.Request, mailbox)
		if err != nil {
			return err
		}
		if err = store.Settle(ctx, claim, mailbox, reply, usage, int(time.Since(began).Milliseconds())); err != nil {
			return err
		}
	}
	if _, err := native.ParseReply(reply, mailbox); err != nil {
		return errors.New("invalid_gateway_response")
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
