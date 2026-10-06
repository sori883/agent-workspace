package native

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"strings"
	"syscall"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type GuestDiagnostic struct {
	RunID            string `json:"run_id"`
	ActorObserved    bool   `json:"actor_observed"`
	ActorRunning     bool   `json:"actor_running"`
	WorkerValid      bool   `json:"worker_address_valid"`
	TLSConnected     bool   `json:"tls_connected"`
	ProcessAvailable bool   `json:"process_service_available"`
	StatusObserved   bool   `json:"runner_status_observed"`
	State            string `json:"runner_state,omitempty"`
	Code             string `json:"code"`
}

func diagnosticCode(err error) string {
	var failure *Error
	if errors.As(err, &failure) {
		return failure.Code
	}
	return status.Code(err).String()
}

func diagnosticTLSCode(err error) string {
	var op *net.OpError
	if errors.As(err, &op) && op.Timeout() {
		if op.Op == "dial" {
			return "guest_tcp_timeout"
		}
		return "guest_tls_timeout"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "guest_tcp_refused"
	}
	if errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) {
		return "guest_tcp_unreachable"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "guest_tcp_reset"
	}
	for _, item := range []struct{ text, code string }{
		{"tls: bad certificate", "guest_client_certificate_rejected"},
		{"tls: unknown certificate authority", "guest_client_ca_rejected"},
		{"tls: certificate required", "guest_client_certificate_required"},
		{"tls: handshake failure", "guest_tls_handshake_rejected"},
		{"tls: no application protocol", "guest_tls_protocol_rejected"},
	} {
		if strings.Contains(err.Error(), item.text) {
			return item.code
		}
	}
	return "guest_tls_failed"
}

func (a *Adapter) InspectGuest(ctx context.Context, runID string) GuestDiagnostic {
	d := GuestDiagnostic{RunID: runID, Code: "invalid_run_id"}
	if !runPattern.MatchString(runID) {
		return d
	}
	observe, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	actor, err := a.control.GetActor(observe, &controlpb.GetActorRequest{Actor: a.actorRef(runID)})
	cancel()
	if err != nil {
		d.Code = "actor_" + diagnosticCode(err)
		return d
	}
	d.ActorObserved = actor.GetMetadata().GetAtespace() == a.config.Atespace && actor.GetMetadata().GetName() == runID
	d.ActorRunning = d.ActorObserved && actor.GetStatus().GetState() == controlpb.ActorState_ACTOR_STATE_RUNNING
	if !d.ActorRunning {
		d.Code = "actor_not_running"
		return d
	}
	ip := net.ParseIP(actor.GetStatus().GetWorkerAssignment().GetWorkerPodIp())
	d.WorkerValid = ip != nil && !ip.IsUnspecified() && !ip.IsMulticast() && !ip.IsLoopback()
	if !d.WorkerValid {
		d.Code = "worker_address_invalid"
		return d
	}
	transport, err := guestTLS(a.config.DirectGuest)
	if err != nil {
		d.Code = "guest_tls_config_invalid"
		return d
	}
	transport.NextProtos = []string{"h2"}
	connect, stop := context.WithTimeout(ctx, a.config.CallTimeout)
	conn, err := (&tls.Dialer{Config: transport}).DialContext(connect, "tcp", net.JoinHostPort(ip.String(), "443"))
	stop()
	if err != nil {
		d.Code = diagnosticTLSCode(err)
		for _, code := range []string{"guest_certificate_required", "guest_certificate_invalid", "guest_identity_mismatch", "config_file_unreadable", "config_secret_group_mismatch", "config_file_permissions_or_size", "invalid_client_certificate"} {
			if strings.Contains(err.Error(), code) {
				d.Code = code
				break
			}
		}
		return d
	}
	conn.Close()
	d.TLSConnected = true
	call, stop := a.callContext(ctx, a.config.Guest, a.config.CallTimeout, runID)
	client, closeClient, err := a.guestClient(call, runID)
	if err == nil {
		_, err = client.GetProcess(call, &guestpb.GetProcessRequest{ProcessId: "ax-native-diagnostic-nonexistent"})
		closeClient()
	}
	stop()
	d.ProcessAvailable = err == nil || status.Code(err) == codes.NotFound
	if !d.ProcessAvailable {
		d.Code = "process_" + diagnosticCode(err)
		return d
	}
	output, err := a.runner(ctx, runID, "status", runID, false)
	if err != nil {
		d.Code = "runner_" + diagnosticCode(err)
		return d
	}
	var current RunnerStatus
	if decodeStrict(output, &current) != nil || current.RunID != runID {
		d.Code = "runner_invalid_protocol"
		return d
	}
	switch current.State {
	case "waiting", "staged", "started", "running", "finished":
		d.State, d.StatusObserved, d.Code = current.State, true, "ok"
	default:
		d.Code = "runner_invalid_protocol"
	}
	return d
}
