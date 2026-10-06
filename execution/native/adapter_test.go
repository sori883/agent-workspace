package native

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	axpb "github.com/google/ax/pkg/apis/v1alpha1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
)

const testRun = "ax-run-0123456789abcdef"
const testImage = "localhost:5000/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func testRequest() Request {
	return Request{SchemaVersion: 1, RunID: testRun, Adapter: "offline", Instruction: "return text", Inputs: map[string]string{"input.txt": "hello"}, OutputName: "output.txt"}
}

func testResult() (Result, []byte) {
	content := []byte("offline: hello\n")
	hash := sha256.Sum256(content)
	stop := "OFFLINE"
	cost := float64(0)
	return Result{SchemaVersion: 1, RunID: testRun, Adapter: "offline", Status: "succeeded", ExitCode: 0, StopReason: &stop, Usage: map[string]float64{"total_token_count": 0}, EstimatedUSD: &cost, Artifact: &Artifact{Name: "output.txt", SizeBytes: len(content), SHA256: hex.EncodeToString(hash[:])}}, content
}

type fakeServices struct {
	axpb.UnimplementedAXServer
	guestpb.UnimplementedProcessServiceServer
	controlpb.UnimplementedControlServer
	mu             sync.Mutex
	calls          []string
	createError    error
	processError   error
	streamError    error
	stdout         []byte
	stderr         []byte
	omitExit       bool
	task           *axpb.Task
	actor          *controlpb.Actor
	policy         *controlpb.EgressPolicy
	policyMismatch bool
	metadataBad    bool
	command        []string
}

func setupFake(t *testing.T) (*Adapter, *fakeServices) {
	t.Helper()
	services := &fakeServices{actor: &controlpb.Actor{Metadata: &controlpb.ResourceMetadata{Atespace: "ax-demo", Name: testRun}, Status: &controlpb.ActorStatus{State: controlpb.ActorState_ACTOR_STATE_SUSPENDED}}}
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	axpb.RegisterAXServer(server, services)
	guestpb.RegisterProcessServiceServer(server, services)
	controlpb.RegisterControlServer(server, services)
	go server.Serve(listener)
	conn, err := grpc.NewClient("passthrough:///fake", grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }), grpc.WithDisableRetry(), grpc.WithDisableServiceConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close(); server.Stop(); listener.Close() })
	a := &Adapter{config: Config{Atespace: "ax-demo", Image: testImage, AllowedHosts: []string{"api.example.test"}, Substrate: Endpoint{Bearer: "test-secret"}, CallTimeout: 2 * time.Second, LifecycleTimeout: 2 * time.Second}, ax: axpb.NewAXClient(conn), guest: guestpb.NewProcessServiceClient(conn), control: controlpb.NewControlClient(conn)}
	return a, services
}

func (f *fakeServices) record(ctx context.Context, name, target string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	md, _ := metadata.FromIncomingContext(ctx)
	if target != "" && strings.Join(md.Get("ate-target-actor"), "") != target {
		f.metadataBad = true
	}
	if strings.HasPrefix(name, "control:") && strings.Join(md.Get("authorization"), "") != "Bearer test-secret" {
		f.metadataBad = true
	}
}

func (f *fakeServices) count(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, value := range f.calls {
		if value == name {
			n++
		}
	}
	return n
}

func (f *fakeServices) CreateTask(ctx context.Context, request *axpb.CreateTaskRequest) (*axpb.Task, error) {
	f.record(ctx, "create", "")
	if f.createError != nil {
		return nil, f.createError
	}
	f.task = proto.Clone(request.Task).(*axpb.Task)
	f.task.Status = &axpb.TaskStatus{Phase: "Suspended", Actor: testRun}
	return f.task, nil
}
func (f *fakeServices) ResumeTask(ctx context.Context, _ *axpb.ResumeTaskRequest) (*axpb.Task, error) {
	f.record(ctx, "resume", "")
	f.task.Status.Phase = "Running"
	return f.task, nil
}
func (f *fakeServices) SuspendTask(ctx context.Context, _ *axpb.SuspendTaskRequest) (*axpb.Task, error) {
	f.record(ctx, "suspend", "")
	f.task.Status.Phase = "Suspended"
	return f.task, nil
}
func (f *fakeServices) GetTask(ctx context.Context, _ *axpb.GetTaskRequest) (*axpb.Task, error) {
	f.record(ctx, "get", "")
	if f.task == nil {
		return nil, status.Error(codes.NotFound, "sensitive")
	}
	return f.task, nil
}
func (f *fakeServices) GetActor(ctx context.Context, _ *controlpb.GetActorRequest) (*controlpb.Actor, error) {
	f.record(ctx, "control:actor", "")
	return f.actor, nil
}
func (f *fakeServices) SuspendActor(ctx context.Context, _ *controlpb.SuspendActorRequest) (*controlpb.SuspendActorResponse, error) {
	f.record(ctx, "control:suspend", "")
	return &controlpb.SuspendActorResponse{Actor: f.actor}, nil
}
func (f *fakeServices) GetActorEgressPolicy(ctx context.Context, _ *controlpb.GetActorEgressPolicyRequest) (*controlpb.EgressPolicy, error) {
	f.record(ctx, "control:egress:get", "")
	if f.policy == nil {
		return nil, status.Error(codes.NotFound, "missing")
	}
	p := proto.Clone(f.policy).(*controlpb.EgressPolicy)
	if f.policyMismatch {
		p.Rules = []*controlpb.EgressRule{{Hostnames: &controlpb.HostnameRule{Patterns: []string{"wrong.test"}}}}
	}
	return p, nil
}
func (f *fakeServices) CreateActorEgressPolicy(ctx context.Context, r *controlpb.CreateActorEgressPolicyRequest) (*controlpb.EgressPolicy, error) {
	f.record(ctx, "control:egress:create", "")
	f.policy = proto.Clone(r.EgressPolicy).(*controlpb.EgressPolicy)
	return f.policy, nil
}
func (f *fakeServices) UpdateActorEgressPolicy(ctx context.Context, r *controlpb.UpdateActorEgressPolicyRequest) (*controlpb.EgressPolicy, error) {
	f.record(ctx, "control:egress:update", "")
	f.policy = proto.Clone(r.EgressPolicy).(*controlpb.EgressPolicy)
	return f.policy, nil
}
func (f *fakeServices) StartProcess(ctx context.Context, r *guestpb.StartProcessRequest) (*guestpb.Process, error) {
	f.record(ctx, "process:start", "ax-demo/"+testRun)
	f.command = r.Command
	if f.processError != nil {
		return nil, f.processError
	}
	return &guestpb.Process{ProcessId: "pid-1", State: guestpb.ProcessState_PROCESS_STATE_RUNNING}, nil
}
func (f *fakeServices) StreamProcessOutput(_ *guestpb.StreamProcessOutputRequest, stream grpc.ServerStreamingServer[guestpb.ProcessOutput]) error {
	f.record(stream.Context(), "process:stream", "ax-demo/"+testRun)
	if f.streamError != nil {
		return f.streamError
	}
	if len(f.stdout) > 0 {
		if err := stream.Send(&guestpb.ProcessOutput{Output: &guestpb.ProcessOutput_Stdout{Stdout: f.stdout}}); err != nil {
			return err
		}
	}
	if len(f.stderr) > 0 {
		if err := stream.Send(&guestpb.ProcessOutput{Output: &guestpb.ProcessOutput_Stderr{Stderr: f.stderr}}); err != nil {
			return err
		}
	}
	if f.omitExit {
		return nil
	}
	return stream.Send(&guestpb.ProcessOutput{Output: &guestpb.ProcessOutput_Exit{Exit: &guestpb.Process{ProcessId: "pid-1", State: guestpb.ProcessState_PROCESS_STATE_EXITED}}})
}

func requireKind(t *testing.T, err error, kind string) {
	t.Helper()
	var nativeErr *Error
	if !errors.As(err, &nativeErr) || nativeErr.Kind != kind {
		t.Fatalf("wanted %s, got %v", kind, err)
	}
}

func TestNativeLifecycleAndEgressReadback(t *testing.T) {
	a, f := setupFake(t)
	ctx := context.Background()
	if _, err := a.Create(ctx, testRun); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Resume(ctx, testRun); err != nil {
		t.Fatal(err)
	}
	allowed, err := a.SetEgress(ctx, testRun, true)
	if err != nil || !allowed.Matches || allowed.Denied {
		t.Fatalf("allow %v %v", allowed, err)
	}
	denied, err := a.SetEgress(ctx, testRun, false)
	if err != nil || !denied.Matches || !denied.Denied {
		t.Fatalf("deny %v %v", denied, err)
	}
	if _, err := a.Suspend(ctx, testRun); err != nil {
		t.Fatal(err)
	}
	stopped, err := a.ObserveStop(ctx, testRun)
	if err != nil || !stopped.Stopped {
		t.Fatalf("stop %v %v", stopped, err)
	}
	if f.metadataBad {
		t.Fatal("metadata boundary mismatch")
	}
	if f.count("create") != 1 || f.count("resume") != 1 || f.count("suspend") != 1 {
		t.Fatal("lifecycle sent more than once")
	}
}

func TestSuspendedTaskDoesNotProveActorStopped(t *testing.T) {
	a, f := setupFake(t)
	ctx := context.Background()
	a.Create(ctx, testRun)
	f.actor.Status.State = controlpb.ActorState_ACTOR_STATE_RUNNING
	f.actor.Status.WorkerAssignment = &controlpb.WorkerAssignment{}
	a.Suspend(ctx, testRun)
	observed, err := a.ObserveStop(ctx, testRun)
	if err != nil || observed.Stopped {
		t.Fatalf("false stopped: %v %v", observed, err)
	}
	f.actor.Status.State = controlpb.ActorState_ACTOR_STATE_SUSPENDED
	observed, err = a.ObserveStop(ctx, testRun)
	if err != nil || observed.Stopped {
		t.Fatalf("assignment ignored: %v %v", observed, err)
	}
}

func TestLostMutationResponseNeverRetries(t *testing.T) {
	a, f := setupFake(t)
	f.createError = status.Error(codes.Unavailable, "test-secret input-content")
	_, err := a.Create(context.Background(), testRun)
	requireKind(t, err, "unknown")
	if f.count("create") != 1 || strings.Contains(err.Error(), "test-secret") {
		t.Fatal("retry or secret leak")
	}
	f.processError = status.Error(codes.Unavailable, "secret")
	err = a.Start(context.Background(), testRun)
	requireKind(t, err, "unknown")
	if f.count("process:start") != 1 {
		t.Fatal("guest start retried")
	}
}

func TestGuestCommandsAndBinding(t *testing.T) {
	a, f := setupFake(t)
	r := testRequest()
	f.stdout = []byte(`{"run_id":"` + testRun + `","state":"staged"}`)
	if err := a.Stage(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(f.command) != 4 || f.command[0] != "python3" || f.command[1] != "/opt/ax-task/runner.py" || f.command[2] != "stage" {
		t.Fatalf("unexpected command %v", f.command[:3])
	}
	decoded, err := base64.StdEncoding.DecodeString(f.command[3])
	if err != nil {
		t.Fatal(err)
	}
	staged, err := ParseRequest(decoded)
	if err != nil || staged.RunID != r.RunID {
		t.Fatal("staged mismatch")
	}
	f.stdout = []byte(`{"run_id":"ax-run-aaaaaaaaaaaaaaaa","state":"started"}`)
	requireKind(t, a.Start(context.Background(), r.RunID), "unknown")
	if f.metadataBad {
		t.Fatal("routing metadata mismatch")
	}
}

func TestIncompleteAndOversizeGuestOutput(t *testing.T) {
	for _, test := range []string{"missing_exit", "oversized_stdout", "oversized_stderr", "stream_error"} {
		t.Run(test, func(t *testing.T) {
			a, f := setupFake(t)
			switch test {
			case "missing_exit":
				f.omitExit = true
			case "oversized_stdout":
				f.stdout = make([]byte, maxResponseBytes+1)
			case "oversized_stderr":
				f.stderr = make([]byte, 8193)
			case "stream_error":
				f.streamError = status.Error(codes.Internal, "secret")
			}
			requireKind(t, a.Start(context.Background(), testRun), "unknown")
			if f.count("process:start") != 1 {
				t.Fatal("retry")
			}
		})
	}
}

func TestCollectValidatesBytesAndResult(t *testing.T) {
	a, f := setupFake(t)
	result, content := testResult()
	encoded := base64.StdEncoding.EncodeToString(content)
	f.stdout, _ = json.Marshal(map[string]any{"result": result, "artifact_base64": encoded})
	collected, err := a.Collect(context.Background(), testRequest())
	if err != nil || string(collected.Bytes) != string(content) {
		t.Fatalf("collect %v", err)
	}
	f.stdout, _ = json.Marshal(map[string]any{"result": result, "artifact_base64": base64.StdEncoding.EncodeToString([]byte("tampered"))})
	_, err = a.Collect(context.Background(), testRequest())
	requireKind(t, err, "observation_failed")
}

func TestEgressReadbackMismatchIsUnknown(t *testing.T) {
	a, f := setupFake(t)
	f.policyMismatch = true
	_, err := a.SetEgress(context.Background(), testRun, false)
	requireKind(t, err, "unknown")
}

func TestStrictProtocolRejectsAmbiguousJSON(t *testing.T) {
	valid, _ := json.Marshal(testRequest())
	for _, data := range []string{strings.Replace(string(valid), `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1), strings.Replace(string(valid), `"schema_version":1`, `"schema_version":null`, 1), strings.Replace(string(valid), `"output_name":"output.txt"`, `"output_name":"output.txt","unknown":true`, 1), string(valid) + `{}`, strings.Replace(string(valid), `"input.txt":"hello"`, `"input.txt":null`, 1)} {
		if _, err := ParseRequest([]byte(data)); err == nil {
			t.Fatal("accepted malformed request")
		}
	}
	result, _ := testResult()
	data, _ := json.Marshal(result)
	for _, bad := range []string{strings.Replace(string(data), `"exit_code":0`, `"exit_code":null`, 1), strings.Replace(string(data), `"total_token_count":0`, `"total_token_count":null`, 1), strings.Replace(string(data), `"size_bytes":15,`, "", 1)} {
		var decoded Result
		if decodeStrict([]byte(bad), &decoded) == nil && decoded.Validate(testRequest()) == nil {
			t.Fatalf("accepted malformed result %s", bad)
		}
	}
}

func TestInvalidRequestNeverSends(t *testing.T) {
	a, f := setupFake(t)
	r := testRequest()
	r.Instruction = strings.Repeat("あ", 683)
	requireKind(t, a.Stage(context.Background(), r), "rejected")
	if f.count("process:start") != 0 {
		t.Fatal("invalid input dispatched")
	}
}

func TestPlaintextIsLoopbackOnly(t *testing.T) {
	for _, address := range []string{"example.test:80", "10.0.0.1:80", "https://127.0.0.1:80"} {
		if conn, err := dialEndpoint(Endpoint{Address: address, PlaintextLoopback: true}); err == nil {
			conn.Close()
			t.Fatal("accepted insecure remote endpoint")
		}
	}
	conn, err := dialEndpoint(Endpoint{Address: "127.0.0.1:1", PlaintextLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}
