package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

func run() error {
	actorName := flag.String("actor", "", "Actor name in ax-demo")
	caPath := flag.String("ca", "", "Substrate service CA PEM")
	hostsPath := flag.String("hosts", "", "JSON array of allowed hostnames; [] denies all")
	flag.Parse()
	if *actorName == "" || *caPath == "" || *hostsPath == "" {
		return fmt.Errorf("--actor, --ca and --hosts are required")
	}
	ca, err := os.ReadFile(*caPath)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return fmt.Errorf("no valid Substrate service CA")
	}
	hostsData, err := os.ReadFile(*hostsPath)
	if err != nil {
		return err
	}
	var hosts []string
	if err := json.Unmarshal(hostsData, &hosts); err != nil {
		return err
	}
	token, err := io.ReadAll(io.LimitReader(os.Stdin, 16384))
	if err != nil || strings.TrimSpace(string(token)) == "" {
		return fmt.Errorf("service token must be provided on stdin")
	}
	conn, err := grpc.NewClient("127.0.0.1:18443",
		grpc.WithAuthority("api.ate-system.svc"),
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			RootCAs: pool, ServerName: "api.ate-system.svc", MinVersion: tls.VersionTLS12,
		})))
	if err != nil {
		return err
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+strings.TrimSpace(string(token)))
	client := ateapipb.NewControlClient(conn)
	actor := &ateapipb.ObjectRef{Atespace: "ax-demo", Name: *actorName}
	policy := &ateapipb.EgressPolicy{Metadata: &ateapipb.ResourceMetadata{Atespace: "ax-demo", Name: "default"}}
	if len(hosts) > 0 {
		policy.Rules = []*ateapipb.EgressRule{{Hostnames: &ateapipb.HostnameRule{Patterns: hosts}}}
	}
	_, err = client.CreateActorEgressPolicy(ctx, &ateapipb.CreateActorEgressPolicyRequest{Actor: actor, EgressPolicy: policy})
	if status.Code(err) == codes.AlreadyExists {
		existing, getErr := client.GetActorEgressPolicy(ctx, &ateapipb.GetActorEgressPolicyRequest{Actor: actor})
		if getErr != nil {
			return getErr
		}
		policy.Metadata = existing.Metadata
		_, err = client.UpdateActorEgressPolicy(ctx, &ateapipb.UpdateActorEgressPolicyRequest{Actor: actor, EgressPolicy: policy})
	}
	if err != nil {
		return err
	}
	confirmed, err := client.GetActorEgressPolicy(ctx, &ateapipb.GetActorEgressPolicyRequest{Actor: actor})
	if err != nil {
		return err
	}
	if !proto.Equal(&ateapipb.EgressPolicy{Rules: policy.Rules}, &ateapipb.EgressPolicy{Rules: confirmed.Rules}) {
		return fmt.Errorf("egress policy readback does not match requested rules")
	}
	fmt.Printf("ax-demo/%s: egress hostnames confirmed as %v\n", *actorName, hosts)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
