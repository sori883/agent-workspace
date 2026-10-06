package native

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"syscall"
	"testing"
	"time"

	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const workerIdentity = "spiffe://cluster.local/ns/ax-demo/sa/default"

func testGuestConfig(t *testing.T) (*DirectGuestConfig, *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, root, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := url.Parse(workerIdentity)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, URIs: []*url.URL{uri}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(leafDER)
	if err != nil {
		t.Fatal(err)
	}
	return &DirectGuestConfig{CAPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), ServerIdentity: workerIdentity, ClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) { return &tls.Certificate{}, nil }}, cert
}

func TestDirectGuestVerifiesChainAndExactSPIFFEIdentity(t *testing.T) {
	config, leaf := testGuestConfig(t)
	transport, err := guestTLS(config)
	if err != nil {
		t.Fatal(err)
	}
	state := tls.ConnectionState{PeerCertificates: []*x509.Certificate{leaf}}
	if err := transport.VerifyConnection(state); err != nil {
		t.Fatal(err)
	}
	other, _ := testGuestConfig(t)
	other.ServerIdentity = workerIdentity + "-other"
	other.CAPEM = config.CAPEM
	otherTLS, _ := guestTLS(other)
	if otherTLS.VerifyConnection(state) == nil {
		t.Fatal("accepted wrong identity")
	}
	untrusted, _ := testGuestConfig(t)
	untrustedTLS, _ := guestTLS(untrusted)
	if untrustedTLS.VerifyConnection(state) == nil {
		t.Fatal("accepted wrong chain")
	}
	if transport.VerifyConnection(tls.ConnectionState{}) == nil {
		t.Fatal("accepted absent certificate")
	}
}

func TestStoppedGuestObservationNeverResumesActor(t *testing.T) {
	a, f := setupFake(t)
	config, _ := testGuestConfig(t)
	a.config.DirectGuest = config
	a.guest = nil
	_, err := a.Status(context.Background(), testRequest())
	if err == nil {
		t.Fatal("stopped guest unexpectedly available")
	}
	if f.count("control:actor") != 1 || f.count("resume") != 0 || f.count("process:start") != 0 {
		t.Fatalf("unexpected calls %v", f.calls)
	}
}

func TestGuestDiagnosticDoesNotResumeOrStartStoppedActor(t *testing.T) {
	a, f := setupFake(t)
	d := a.InspectGuest(context.Background(), testRun)
	if !d.ActorObserved || d.ActorRunning || d.TLSConnected || d.Code != "actor_not_running" {
		t.Fatalf("unexpected diagnostic: %+v", d)
	}
	if f.count("control:actor") != 1 || f.count("resume") != 0 || f.count("process:start") != 0 {
		t.Fatalf("diagnostic mutated guest: %v", f.calls)
	}
	f.actor.Status.State = controlpb.ActorState_ACTOR_STATE_RUNNING
	d = a.InspectGuest(context.Background(), testRun)
	if !d.ActorRunning || d.WorkerValid || d.Code != "worker_address_invalid" || f.count("process:start") != 0 {
		t.Fatalf("missing assignment was used: %+v", d)
	}
}

func TestDiagnosticDoesNotExposeRawGRPCError(t *testing.T) {
	if got := diagnosticCode(status.Error(codes.PermissionDenied, "secret internal detail")); got != "PermissionDenied" {
		t.Fatalf("unsafe diagnostic %q", got)
	}
	if got := diagnosticCode(errors.New("secret internal detail")); got != "Unknown" {
		t.Fatalf("unsafe diagnostic %q", got)
	}
}

func TestTLSFailureClassificationDoesNotExposeAddressesOrRawMessages(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{&net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.ParseIP("192.0.2.123"), Port: 443}, Err: os.ErrDeadlineExceeded}, "guest_tcp_timeout"},
		{&net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded}, "guest_tls_timeout"},
		{&net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, "guest_tcp_refused"},
		{&net.OpError{Op: "dial", Err: syscall.EHOSTUNREACH}, "guest_tcp_unreachable"},
		{&net.OpError{Op: "remote error", Err: errors.New("tls: bad certificate")}, "guest_client_certificate_rejected"},
		{errors.New("remote error: tls: unknown certificate authority"), "guest_client_ca_rejected"},
		{errors.New("secret internal diagnostic"), "guest_tls_failed"},
	} {
		if got := diagnosticTLSCode(tc.err); got != tc.code {
			t.Fatalf("got %q, want %q", got, tc.code)
		}
	}
}

func TestBearerSourceRefreshesAndFailsClosed(t *testing.T) {
	a, _ := setupFake(t)
	token := "first"
	endpoint := Endpoint{BearerToken: func() (string, error) {
		if token == "" {
			return "", errors.New("unavailable")
		}
		return token, nil
	}}
	ctx, cancel := a.callContext(context.Background(), endpoint, time.Second, "")
	defer cancel()
	md, _ := metadata.FromOutgoingContext(ctx)
	if md.Get("authorization")[0] != "Bearer first" {
		t.Fatal("missing token")
	}
	token = "second"
	ctx2, cancel2 := a.callContext(context.Background(), endpoint, time.Second, "")
	defer cancel2()
	md, _ = metadata.FromOutgoingContext(ctx2)
	if md.Get("authorization")[0] != "Bearer second" {
		t.Fatal("stale token")
	}
	token = ""
	ctx3, cancel3 := a.callContext(context.Background(), endpoint, time.Second, "")
	defer cancel3()
	if ctx3.Err() == nil {
		t.Fatal("missing credential did not cancel")
	}
}

func TestProtocolRejectsUnpairedSurrogates(t *testing.T) {
	for _, value := range []string{`"\ud800"`, `"\udfff"`, `"\ud800\u0000"`} {
		var s string
		if decodeStrict([]byte(value), &s) == nil {
			t.Fatal("invalid Unicode accepted")
		}
	}
	for _, value := range []string{`"\ud83d\ude00"`, `"\\ud800"`} {
		var s string
		if decodeStrict([]byte(value), &s) != nil {
			t.Fatal("valid Unicode rejected")
		}
	}
}
