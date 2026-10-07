package native

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"regexp"
	"slices"
	"strings"
	"time"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	axpb "github.com/google/ax/pkg/apis/v1alpha1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type Operation string

const (
	CreateOperation        Operation = "create"
	ResumeOperation        Operation = "resume"
	StageOperation         Operation = "stage"
	StartOperation         Operation = "start"
	AllowOperation         Operation = "egress_allow"
	PrepareEgressOperation Operation = "egress_prepare"
	DenyOperation          Operation = "egress_deny"
	SuspendOperation       Operation = "suspend"
	SuspendActorOperation  Operation = "suspend_actor"
)

type Error struct {
	Operation Operation
	Kind      string
	Code      string
}

func (e *Error) Error() string { return string(e.Operation) + ":" + e.Kind + ":" + e.Code }

func failure(op Operation, mutating bool, code string) error {
	kind := "observation_failed"
	if mutating {
		kind = "unknown"
	}
	return &Error{Operation: op, Kind: kind, Code: code}
}

func rpcFailure(op Operation, mutating bool, err error) error {
	return failure(op, mutating, status.Code(err).String())
}

func invalid(op Operation) error {
	return &Error{Operation: op, Kind: "rejected", Code: "invalid_input"}
}

type Endpoint struct {
	Address           string
	ServerName        string
	CAPEM             []byte
	Bearer            string
	BearerToken       func() (string, error)
	PlaintextLoopback bool
}

type Config struct {
	AX               Endpoint
	Guest            Endpoint
	DirectGuest      *DirectGuestConfig
	Substrate        Endpoint
	Atespace         string
	Image            string
	AllowedHosts     []string
	CallTimeout      time.Duration
	LifecycleTimeout time.Duration
}

type Adapter struct {
	config      Config
	ax          axpb.AXClient
	guest       guestpb.ProcessServiceClient
	control     controlpb.ControlClient
	connections []*grpc.ClientConn
}

var spacePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
var imagePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$`)
var hostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
var runnerCommand = []string{"python3", "/opt/ax-task/runner.py", "wait"}

func Dial(config Config) (*Adapter, error) {
	if !spacePattern.MatchString(config.Atespace) || !imagePattern.MatchString(config.Image) || config.CallTimeout < time.Second || config.CallTimeout > time.Minute || config.LifecycleTimeout < time.Second || config.LifecycleTimeout > 5*time.Minute {
		return nil, invalid("configure")
	}
	config.AllowedHosts = slices.Clone(config.AllowedHosts)
	for _, host := range config.AllowedHosts {
		if len(host) > 253 || !hostnamePattern.MatchString(host) || strings.Contains(host, "..") || net.ParseIP(host) != nil {
			return nil, invalid("configure")
		}
	}
	if (config.Substrate.Bearer == "" && config.Substrate.BearerToken == nil) || config.Substrate.PlaintextLoopback {
		return nil, invalid("configure")
	}
	if config.DirectGuest != nil {
		if _, err := guestTLS(config.DirectGuest); err != nil {
			return nil, invalid("configure")
		}
	}
	a := &Adapter{config: config}
	for _, endpoint := range []Endpoint{config.AX, config.Substrate} {
		conn, err := dialEndpoint(endpoint)
		if err != nil {
			a.Close()
			return nil, err
		}
		a.connections = append(a.connections, conn)
	}
	a.ax = axpb.NewAXClient(a.connections[0])
	a.control = controlpb.NewControlClient(a.connections[1])
	return a, nil
}

func dialEndpoint(endpoint Endpoint) (*grpc.ClientConn, error) {
	host, port, err := net.SplitHostPort(endpoint.Address)
	if err != nil || port == "" || strings.ContainsAny(endpoint.Bearer, "\r\n\x00") {
		return nil, invalid("configure")
	}
	var transport credentials.TransportCredentials
	if endpoint.PlaintextLoopback {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() || endpoint.ServerName != "" || len(endpoint.CAPEM) != 0 || endpoint.Bearer != "" || endpoint.BearerToken != nil {
			return nil, invalid("configure")
		}
		transport = insecure.NewCredentials()
	} else {
		if endpoint.ServerName == "" {
			return nil, invalid("configure")
		}
		var pool *x509.CertPool
		if len(endpoint.CAPEM) > 0 {
			pool = x509.NewCertPool()
			if !pool.AppendCertsFromPEM(endpoint.CAPEM) {
				return nil, invalid("configure")
			}
		}
		transport = credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: endpoint.ServerName, RootCAs: pool})
	}
	options := []grpc.DialOption{grpc.WithTransportCredentials(transport), grpc.WithDisableRetry(), grpc.WithDisableServiceConfig(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(256*1024), grpc.MaxCallSendMsgSize(128*1024))}
	if endpoint.ServerName != "" {
		options = append(options, grpc.WithAuthority(endpoint.ServerName))
	}
	conn, err := grpc.NewClient("passthrough:///"+endpoint.Address, options...)
	if err != nil {
		return nil, invalid("configure")
	}
	return conn, nil
}

func (a *Adapter) Close() error {
	var errs []error
	for _, conn := range a.connections {
		errs = append(errs, conn.Close())
	}
	return errors.Join(errs...)
}

func (a *Adapter) callContext(ctx context.Context, endpoint Endpoint, duration time.Duration, runID string) (context.Context, context.CancelFunc) {
	md := metadata.MD{}
	token := endpoint.Bearer
	var tokenErr error
	if endpoint.BearerToken != nil {
		token, tokenErr = endpoint.BearerToken()
	}
	if tokenErr != nil || strings.ContainsAny(token, "\r\n\x00") {
		ctx, cancel := context.WithCancel(ctx)
		cancel()
		return ctx, cancel
	}
	if token != "" {
		md.Set("authorization", "Bearer "+token)
	}
	if runID != "" {
		md.Set("ate-target-actor", a.config.Atespace+"/"+runID)
	}
	return context.WithTimeout(metadata.NewOutgoingContext(ctx, md), duration)
}

type TaskObservation struct {
	RunID string `json:"run_id"`
	Phase string `json:"phase"`
	Actor string `json:"actor"`
	Ready bool   `json:"ready"`
}

func (a *Adapter) taskObservation(task *axpb.Task, runID string) (TaskObservation, error) {
	if task.GetMetadata().GetName() != runID || task.GetMetadata().GetAtespace() != a.config.Atespace || !proto.Equal(task.GetSpec(), &axpb.TaskSpec{Image: a.config.Image, Command: a.taskCommand(), Debug: true}) {
		return TaskObservation{}, errors.New("task_identity_mismatch")
	}
	state := task.GetStatus()
	if state.GetActor() != "" && state.GetActor() != runID {
		return TaskObservation{}, errors.New("task_identity_mismatch")
	}
	ready := false
	for _, condition := range state.GetConditions() {
		if condition.GetType() == "Ready" && condition.GetStatus() == "True" {
			ready = true
		}
	}
	return TaskObservation{RunID: runID, Phase: state.GetPhase(), Actor: state.GetActor(), Ready: ready}, nil
}

func (a *Adapter) Create(ctx context.Context, runID string) (TaskObservation, error) {
	if !runPattern.MatchString(runID) {
		return TaskObservation{}, invalid(CreateOperation)
	}
	if a.config.Atespace == "ax-runtime" || a.config.Atespace == "ax-code" {
		if err := a.requireFreshActor(ctx, runID); err != nil {
			return TaskObservation{}, err
		}
	}
	ctx, cancel := a.callContext(ctx, a.config.AX, a.config.LifecycleTimeout, "")
	defer cancel()
	task, err := a.ax.CreateTask(ctx, &axpb.CreateTaskRequest{Task: &axpb.Task{ApiVersion: "ax.io/v1alpha1", Kind: "Task", Metadata: &axpb.ObjectMeta{Name: runID, Atespace: a.config.Atespace}, Spec: &axpb.TaskSpec{Image: a.config.Image, Command: a.taskCommand(), Debug: true}}})
	return a.taskResult(CreateOperation, true, task, runID, err)
}

func (a *Adapter) Resume(ctx context.Context, runID string) (TaskObservation, error) {
	if !runPattern.MatchString(runID) {
		return TaskObservation{}, invalid(ResumeOperation)
	}
	if a.config.Atespace == "ax-runtime" || a.config.Atespace == "ax-code" {
		if err := a.verifyRuntimeTemplate(ctx, runID); err != nil {
			return TaskObservation{}, err
		}
	}
	ctx, cancel := a.callContext(ctx, a.config.AX, a.config.LifecycleTimeout, "")
	defer cancel()
	task, err := a.ax.ResumeTask(ctx, &axpb.ResumeTaskRequest{Atespace: a.config.Atespace, Name: runID})
	return a.taskResult(ResumeOperation, true, task, runID, err)
}

func (a *Adapter) ObserveTask(ctx context.Context, runID string) (TaskObservation, error) {
	if !runPattern.MatchString(runID) {
		return TaskObservation{}, invalid("observe_task")
	}
	ctx, cancel := a.callContext(ctx, a.config.AX, a.config.CallTimeout, "")
	defer cancel()
	task, err := a.ax.GetTask(ctx, &axpb.GetTaskRequest{Atespace: a.config.Atespace, Name: runID})
	return a.taskResult("observe_task", false, task, runID, err)
}

func (a *Adapter) InspectTask(ctx context.Context, runID string) (TaskObservation, error) {
	if !runPattern.MatchString(runID) {
		return TaskObservation{}, invalid("inspect_task")
	}
	ctx, cancel := a.callContext(ctx, a.config.AX, a.config.CallTimeout, "")
	defer cancel()
	task, err := a.ax.GetTask(ctx, &axpb.GetTaskRequest{Atespace: a.config.Atespace, Name: runID})
	if err != nil {
		return TaskObservation{}, rpcFailure("inspect_task", false, err)
	}
	if task.GetMetadata().GetName() != runID || task.GetMetadata().GetAtespace() != a.config.Atespace {
		return TaskObservation{}, failure("inspect_task", false, "task_identity_mismatch")
	}
	return TaskObservation{RunID: runID, Phase: task.GetStatus().GetPhase(), Actor: task.GetStatus().GetActor()}, nil
}

func (a *Adapter) Suspend(ctx context.Context, runID string) (TaskObservation, error) {
	if !runPattern.MatchString(runID) {
		return TaskObservation{}, invalid(SuspendOperation)
	}
	ctx, cancel := a.callContext(ctx, a.config.AX, a.config.LifecycleTimeout, "")
	defer cancel()
	task, err := a.ax.SuspendTask(ctx, &axpb.SuspendTaskRequest{Atespace: a.config.Atespace, Name: runID})
	return a.taskResult(SuspendOperation, true, task, runID, err)
}

func (a *Adapter) taskResult(op Operation, mutating bool, task *axpb.Task, runID string, err error) (TaskObservation, error) {
	if err != nil {
		return TaskObservation{}, rpcFailure(op, mutating, err)
	}
	observation, err := a.taskObservation(task, runID)
	if err != nil {
		return TaskObservation{}, failure(op, mutating, "task_identity_mismatch")
	}
	return observation, nil
}

type StopObservation struct {
	RunID     string `json:"run_id"`
	State     string `json:"state"`
	HasWorker bool   `json:"has_worker"`
	Stopped   bool   `json:"stopped"`
}

func (a *Adapter) actorRef(runID string) *controlpb.ObjectRef {
	return &controlpb.ObjectRef{Atespace: a.config.Atespace, Name: runID}
}

func (a *Adapter) ObserveStop(ctx context.Context, runID string) (StopObservation, error) {
	if !runPattern.MatchString(runID) {
		return StopObservation{}, invalid("observe_stop")
	}
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	actor, err := a.control.GetActor(ctx, &controlpb.GetActorRequest{Actor: a.actorRef(runID)})
	if err != nil {
		return StopObservation{}, rpcFailure("observe_stop", false, err)
	}
	if actor.GetMetadata().GetName() != runID || actor.GetMetadata().GetAtespace() != a.config.Atespace || actor.GetStatus() == nil {
		return StopObservation{}, failure("observe_stop", false, "actor_identity_mismatch")
	}
	state := actor.GetStatus()
	return StopObservation{RunID: runID, State: state.GetState().String(), HasWorker: state.GetWorkerAssignment() != nil, Stopped: state.GetState() == controlpb.ActorState_ACTOR_STATE_SUSPENDED && state.GetWorkerAssignment() == nil}, nil
}

func (a *Adapter) SuspendActor(ctx context.Context, runID string) error {
	if !runPattern.MatchString(runID) {
		return invalid(SuspendActorOperation)
	}
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.LifecycleTimeout, "")
	defer cancel()
	_, err := a.control.SuspendActor(ctx, &controlpb.SuspendActorRequest{Actor: a.actorRef(runID)})
	if err != nil {
		return rpcFailure(SuspendActorOperation, true, err)
	}
	return nil
}

type EgressObservation struct {
	RunID   string `json:"run_id"`
	Matches bool   `json:"matches"`
	Denied  bool   `json:"denied"`
}

func (a *Adapter) policy(allow bool) *controlpb.EgressPolicy {
	policy := &controlpb.EgressPolicy{Metadata: &controlpb.ResourceMetadata{Atespace: a.config.Atespace, Name: "default"}}
	if allow {
		policy.Rules = []*controlpb.EgressRule{{Hostnames: &controlpb.HostnameRule{Patterns: slices.Clone(a.config.AllowedHosts)}}}
	}
	return policy
}

func (a *Adapter) SetEgress(ctx context.Context, runID string, allow bool) (EgressObservation, error) {
	if (a.config.Atespace == "ax-runtime" || a.config.Atespace == "ax-code") && allow {
		return EgressObservation{}, invalid(AllowOperation)
	}
	op := DenyOperation
	if allow {
		op = AllowOperation
	}
	if !runPattern.MatchString(runID) || (allow && len(a.config.AllowedHosts) == 0) {
		return EgressObservation{}, invalid(op)
	}
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	existing, err := a.control.GetActorEgressPolicy(ctx, &controlpb.GetActorEgressPolicyRequest{Actor: a.actorRef(runID)})
	if err != nil && status.Code(err) != codes.NotFound {
		return EgressObservation{}, rpcFailure(op, false, err)
	}
	policy := a.policy(allow)
	if err == nil {
		if !a.validPolicyIdentity(existing) {
			return EgressObservation{}, failure(op, false, "policy_identity_mismatch")
		}
		policy.Metadata = existing.Metadata
		_, err = a.control.UpdateActorEgressPolicy(ctx, &controlpb.UpdateActorEgressPolicyRequest{Actor: a.actorRef(runID), EgressPolicy: policy})
	} else {
		_, err = a.control.CreateActorEgressPolicy(ctx, &controlpb.CreateActorEgressPolicyRequest{Actor: a.actorRef(runID), EgressPolicy: policy})
	}
	if err != nil {
		return EgressObservation{}, rpcFailure(op, true, err)
	}
	observed, err := a.observeEgress(ctx, runID, allow)
	if err != nil {
		return EgressObservation{}, failure(op, true, "egress_readback_failed")
	}
	if !observed.Matches {
		return observed, failure(op, true, "egress_readback_mismatch")
	}
	return observed, nil
}

func (a *Adapter) validPolicyIdentity(policy *controlpb.EgressPolicy) bool {
	return policy.GetMetadata().GetAtespace() == a.config.Atespace && policy.GetMetadata().GetName() == "default"
}

func (a *Adapter) ObserveEgress(ctx context.Context, runID string, allow bool) (EgressObservation, error) {
	if !runPattern.MatchString(runID) {
		return EgressObservation{}, invalid("observe_egress")
	}
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	return a.observeEgress(ctx, runID, allow)
}

func (a *Adapter) observeEgress(ctx context.Context, runID string, allow bool) (EgressObservation, error) {
	policy, err := a.control.GetActorEgressPolicy(ctx, &controlpb.GetActorEgressPolicyRequest{Actor: a.actorRef(runID)})
	if err != nil {
		return EgressObservation{}, rpcFailure("observe_egress", false, err)
	}
	if !a.validPolicyIdentity(policy) {
		return EgressObservation{}, failure("observe_egress", false, "policy_identity_mismatch")
	}
	return EgressObservation{RunID: runID, Matches: proto.Equal(&controlpb.EgressPolicy{Rules: policy.Rules}, &controlpb.EgressPolicy{Rules: a.policy(allow).Rules}), Denied: len(policy.Rules) == 0}, nil
}

func (a *Adapter) Stage(ctx context.Context, request Request) error {
	if a.config.Atespace == "ax-code" || request.Validate() != nil || (request.Adapter == "interactive") != (a.config.Atespace == "ax-runtime") {
		return invalid(StageOperation)
	}
	data, err := json.Marshal(request)
	if err != nil || len(data) > 49152 {
		return invalid(StageOperation)
	}
	output, err := a.runner(ctx, request.RunID, StageOperation, base64.StdEncoding.EncodeToString(data), true)
	if err != nil {
		return err
	}
	return parseAcknowledgement(output, request.RunID, "staged", StageOperation)
}

func (a *Adapter) Start(ctx context.Context, runID string) error {
	if !runPattern.MatchString(runID) {
		return invalid(StartOperation)
	}
	output, err := a.runner(ctx, runID, StartOperation, runID, true)
	if err != nil {
		return err
	}
	return parseAcknowledgement(output, runID, "started", StartOperation)
}

func parseAcknowledgement(data []byte, runID, state string, op Operation) error {
	var acknowledgement struct {
		RunID string `json:"run_id"`
		State string `json:"state"`
	}
	if decodeStrict(data, &acknowledgement) != nil || acknowledgement.RunID != runID || acknowledgement.State != state {
		return failure(op, true, "invalid_runner_protocol")
	}
	return nil
}

func (a *Adapter) Status(ctx context.Context, request Request) (RunnerStatus, error) {
	if request.Validate() != nil {
		return RunnerStatus{}, invalid("status")
	}
	output, err := a.runner(ctx, request.RunID, "status", request.RunID, false)
	if err != nil {
		return RunnerStatus{}, err
	}
	result, err := parseStatus(output, request)
	if err != nil {
		return RunnerStatus{}, failure("status", false, "invalid_runner_protocol")
	}
	return result, nil
}

func (a *Adapter) Collect(ctx context.Context, request Request) (Collection, error) {
	if request.Validate() != nil {
		return Collection{}, invalid("collect")
	}
	output, err := a.runner(ctx, request.RunID, "collect", request.RunID, false)
	if err != nil {
		return Collection{}, err
	}
	result, err := parseCollection(output, request)
	if err != nil {
		return Collection{}, failure("collect", false, "invalid_runner_protocol")
	}
	return result, nil
}

func (a *Adapter) taskCommand() []string {
	if a.config.Atespace == "ax-code" {
		return []string{"python3", "/opt/ax-code/runner.py", "wait"}
	}
	return slices.Clone(runnerCommand)
}
