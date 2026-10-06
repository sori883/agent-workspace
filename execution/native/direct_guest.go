package native

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type DirectGuestConfig struct {
	CAPEM             []byte
	ServerIdentity    string
	ClientCertificate func(*tls.CertificateRequestInfo) (*tls.Certificate, error)
}

func guestTLS(config *DirectGuestConfig) (*tls.Config, error) {
	if config == nil || config.ClientCertificate == nil {
		return nil, errors.New("direct_guest_required")
	}
	identity, err := url.Parse(config.ServerIdentity)
	if err != nil || identity.Scheme != "spiffe" || identity.Host == "" || identity.RawQuery != "" || identity.Fragment != "" {
		return nil, errors.New("invalid_guest_identity")
	}
	ca := x509.NewCertPool()
	if !ca.AppendCertsFromPEM(config.CAPEM) {
		return nil, errors.New("invalid_guest_ca")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, GetClientCertificate: config.ClientCertificate, VerifyConnection: func(state tls.ConnectionState) error {
		if len(state.PeerCertificates) == 0 {
			return errors.New("guest_certificate_required")
		}
		intermediates := x509.NewCertPool()
		for _, certificate := range state.PeerCertificates[1:] {
			intermediates.AddCert(certificate)
		}
		if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: ca, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
			return errors.New("guest_certificate_invalid")
		}
		for _, uri := range state.PeerCertificates[0].URIs {
			if uri.String() == config.ServerIdentity {
				return nil
			}
		}
		return errors.New("guest_identity_mismatch")
	}}, nil
}

func (a *Adapter) guestClient(ctx context.Context, runID string) (guestpb.ProcessServiceClient, func(), error) {
	if a.guest != nil {
		return a.guest, func() {}, nil
	}
	transport, err := guestTLS(a.config.DirectGuest)
	if err != nil {
		return nil, nil, err
	}
	observe, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	actor, err := a.control.GetActor(observe, &controlpb.GetActorRequest{Actor: a.actorRef(runID)})
	if err != nil {
		return nil, nil, err
	}
	if actor.GetMetadata().GetAtespace() != a.config.Atespace || actor.GetMetadata().GetName() != runID || actor.GetStatus().GetState() != controlpb.ActorState_ACTOR_STATE_RUNNING {
		return nil, nil, errors.New("actor_not_running")
	}
	ip := net.ParseIP(actor.GetStatus().GetWorkerAssignment().GetWorkerPodIp())
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLoopback() {
		return nil, nil, errors.New("worker_address_invalid")
	}
	conn, err := grpc.NewClient("passthrough:///"+net.JoinHostPort(ip.String(), "443"), grpc.WithTransportCredentials(credentials.NewTLS(transport)), grpc.WithAuthority("actor.internal"), grpc.WithDisableRetry(), grpc.WithDisableServiceConfig(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(256*1024), grpc.MaxCallSendMsgSize(128*1024)))
	if err != nil {
		return nil, nil, errors.New("guest_connect_failed")
	}
	return guestpb.NewProcessServiceClient(conn), func() { conn.Close() }, nil
}
