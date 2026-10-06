package controller

import (
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/sori883/agent-workspace/execution/native"
	"testing"
)

func TestOnlyExactDatabaseRejectionAllowsAuthorizationCleanup(t *testing.T) {
	exact := &pgconn.PgError{Code: "P0001", Message: "workspace_access_revoked"}
	for _, err := range []error{exact, fmt.Errorf("query failed: %w", exact)} {
		if !errors.Is(classifyIntentError(err), ErrAuthorizationRevoked) {
			t.Fatal("confirmed rejection not recognized")
		}
	}
	for _, err := range []error{errors.New("workspace_access_revoked"), &pgconn.PgError{Code: "08006", Message: "workspace_access_revoked"}, &pgconn.PgError{Code: "P0001", Message: "workspace_required"}, errors.New("connection lost")} {
		if errors.Is(classifyIntentError(err), ErrAuthorizationRevoked) {
			t.Fatalf("unknown result accepted: %v", err)
		}
	}
}

func TestFinishUsesNoEffectCancellationOnlyForFreshExecute(t *testing.T) {
	empty := &Claim{Kind: "execute"}
	if finishFunction(empty) != "ax_cancel_unstarted" || !validFinishOutcome(empty, "not_started") || validFinishOutcome(empty, "succeeded") {
		t.Fatal("invalid empty completion contract")
	}
	for _, c := range []*Claim{{Kind: "recovery"}, {Kind: "execute", Effects: map[native.Operation]Effect{native.CreateOperation: {OperationID: "created"}}}} {
		if finishFunction(c) != "ax_finish" || validFinishOutcome(c, "not_started") || !validFinishOutcome(c, "failed") {
			t.Fatal("effect/recovery bypassed cleanup")
		}
	}
}
