package native

import (
	"context"
	"encoding/base64"
	"time"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"
)

func (a *Adapter) ObserveCodeProcessService(ctx context.Context, run string) error {
	const op Operation = "observe_code_process_service"
	if a.config.Atespace != "ax-code" || !runPattern.MatchString(run) {
		return invalid(op)
	}
	ctx, cancel := a.callContext(ctx, a.config.Guest, a.config.CallTimeout, run)
	defer cancel()
	client, closeClient, err := a.guestClient(ctx, run)
	if err != nil {
		return failure(op, false, "guest_unavailable")
	}
	defer closeClient()
	_, err = client.GetProcess(ctx, &guestpb.GetProcessRequest{ProcessId: "ax-code-readiness-probe"})
	if err != nil && status.Code(err) != codes.NotFound {
		return rpcFailure(op, false, err)
	}
	return nil
}

func (a *Adapter) PrepareCodeRunner(ctx context.Context, run string, remaining time.Duration) error {
	if a.config.Atespace != "ax-code" || !runPattern.MatchString(run) || remaining <= 0 || remaining > 5*time.Minute {
		return invalid(ResumeOperation)
	}
	ctx, cancel := a.callContext(ctx, a.config.Guest, a.config.CallTimeout, run)
	defer cancel()
	client, closeClient, err := a.guestClient(ctx, run)
	if err != nil {
		return failure(ResumeOperation, false, "guest_unavailable")
	}
	defer closeClient()
	process, err := client.StartProcess(ctx, &guestpb.StartProcessRequest{Command: []string{"python3", "/opt/ax-code/runner.py", "wait"}, Timeout: durationpb.New(remaining)})
	if err != nil {
		return rpcFailure(ResumeOperation, true, err)
	}
	if process.GetProcessId() == "" {
		return failure(ResumeOperation, true, "missing_process_id")
	}
	return nil
}

func (a *Adapter) workbenchRPC(ctx context.Context, run string, op Operation, value string, mutating bool) ([]byte, error) {
	if (a.config.Atespace != "ax-runtime" && a.config.Atespace != "ax-code") || !runPattern.MatchString(run) {
		return nil, invalid(op)
	}
	if len(value) > 65536 {
		return nil, invalid(op)
	}
	path := "/opt/ax-task/workbench_runner.py"
	if a.config.Atespace == "ax-code" {
		path = "/opt/ax-code/runner.py"
	}
	return a.runnerPath(ctx, run, op, value, mutating, path, 65536)
}
func (a *Adapter) workbenchAck(ctx context.Context, run string, op Operation, value any, state string) error {
	raw, e := CanonicalJSON(value)
	if e != nil {
		return invalid(op)
	}
	data, e := a.workbenchRPC(ctx, run, op, base64.StdEncoding.EncodeToString(raw), true)
	if e != nil {
		return e
	}
	var ack struct {
		RunID string `json:"run_id"`
		State string `json:"state"`
	}
	if decodeStrict(data, &ack) != nil || ack.RunID != run || ack.State != state {
		return failure(op, true, "invalid_runner_protocol")
	}
	return nil
}
func (a *Adapter) StageWorkbench(ctx context.Context, r WorkbenchRequest, w Workbench) error {
	if w.Validate(r) != nil || (w.AttemptKind == "runtime" && a.config.Atespace != "ax-runtime") || (w.AttemptKind == "python" && a.config.Atespace != "ax-code") {
		return invalid(StageOperation)
	}
	op := Operation("stage")
	if a.config.Atespace == "ax-code" {
		op = "stage-begin"
	}
	return a.workbenchAck(ctx, r.RunID, op, struct {
		Request   WorkbenchRequest `json:"request"`
		Workbench Workbench        `json:"workbench"`
	}{r, w}, "staged")
}
func (a *Adapter) DefinitionChunk(ctx context.Context, run string, part DefinitionChunk) error {
	return a.workbenchAck(ctx, run, "definition-chunk", struct {
		RunID         string `json:"run_id"`
		VersionID     string `json:"version_id"`
		Index         int    `json:"index"`
		ContentBase64 string `json:"content_base64"`
	}{run, part.VersionID, part.Index, part.ContentBase64}, "staged")
}
func (a *Adapter) workbenchStateOp(ctx context.Context, run string, op Operation, state string) error {
	data, e := a.workbenchRPC(ctx, run, op, run, true)
	if e != nil {
		return e
	}
	var ack struct {
		RunID string `json:"run_id"`
		State string `json:"state"`
	}
	if decodeStrict(data, &ack) != nil || ack.RunID != run || ack.State != state {
		return failure(op, true, "invalid_runner_protocol")
	}
	return nil
}
func (a *Adapter) SealWorkbench(ctx context.Context, r WorkbenchRequest) error {
	if a.config.Atespace == "ax-code" {
		return a.codeStateOp(ctx, r, "stage-seal", "sealed")
	}
	return a.workbenchStateOp(ctx, r.RunID, "seal", "sealed")
}
func (a *Adapter) StartWorkbench(ctx context.Context, r WorkbenchRequest) error {
	if a.config.Atespace == "ax-code" {
		return a.codeStateOp(ctx, r, "code-start", "started")
	}
	return a.workbenchStateOp(ctx, r.RunID, "start", "started")
}
func (a *Adapter) StatusWorkbench(ctx context.Context, r WorkbenchRequest) (WorkbenchStatus, error) {
	var raw []byte
	var e error
	if a.config.Atespace == "ax-code" {
		raw, e = a.codeRPC(ctx, r, "code-status", false)
	} else {
		raw, e = a.workbenchRPC(ctx, r.RunID, "status", r.RunID, false)
	}
	if e != nil {
		return WorkbenchStatus{}, e
	}
	return ParseWorkbenchStatus(raw, r)
}
func (a *Adapter) CollectWorkbench(ctx context.Context, r WorkbenchRequest) (WorkbenchResult, error) {
	var raw []byte
	var e error
	if a.config.Atespace == "ax-code" {
		raw, e = a.codeRPC(ctx, r, "code-collect", false)
	} else {
		raw, e = a.workbenchRPC(ctx, r.RunID, "collect", r.RunID, false)
	}
	if e != nil {
		return WorkbenchResult{}, e
	}
	return ParseWorkbenchCollection(raw, r)
}
func (a *Adapter) MailboxWorkbench(ctx context.Context, run string) (*Mailbox, error) {
	raw, e := a.workbenchRPC(ctx, run, "mailbox", run, false)
	if e != nil {
		return nil, e
	}
	return ParseWorkbenchMailbox(raw, run)
}
func (a *Adapter) ReplyWorkbench(ctx context.Context, m *Mailbox, reply []byte) error {
	r, e := ParseReply(reply, m)
	if e != nil || r.Version != 2 {
		return invalid("reply")
	}
	raw, e := a.workbenchRPC(ctx, r.RunID, "reply", base64.StdEncoding.EncodeToString(reply), true)
	if e != nil {
		return e
	}
	var ack struct {
		RunID    string `json:"run_id"`
		Sequence int    `json:"sequence"`
		State    string `json:"state"`
	}
	if decodeStrict(raw, &ack) != nil || ack.RunID != r.RunID || ack.Sequence != r.Sequence || ack.State != "replied" {
		return failure("reply", true, "invalid_runner_protocol")
	}
	return nil
}

type OutputFile struct {
	Alias     string `json:"alias"`
	Name      string `json:"name"`
	SizeBytes int    `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}
type OutputManifest struct {
	RunID            string       `json:"run_id"`
	DescriptorSHA256 string       `json:"descriptor_sha256"`
	Outputs          []OutputFile `json:"outputs"`
	ManifestSHA256   string       `json:"manifest_sha256"`
}

func (m OutputManifest) Validate(r WorkbenchRequest, w Workbench) error {
	if m.RunID != r.RunID || m.DescriptorSHA256 != r.DescriptorSHA256 || len(m.Outputs) != len(w.Descriptor.Outputs) || len(m.Outputs) < 1 {
		return errProtocol
	}
	raw, e := CanonicalJSON(struct {
		RunID            string       `json:"run_id"`
		DescriptorSHA256 string       `json:"descriptor_sha256"`
		Outputs          []OutputFile `json:"outputs"`
	}{m.RunID, m.DescriptorSHA256, m.Outputs})
	if e != nil || HashBytes(raw) != m.ManifestSHA256 {
		return errProtocol
	}
	for i, f := range m.Outputs {
		want := w.Descriptor.Outputs[i]
		if f.Alias != want.Alias || f.Name != want.Name || f.SizeBytes < 1 || f.SizeBytes > want.SizeLimitBytes || !hashPattern.MatchString(f.SHA256) {
			return errProtocol
		}
	}
	return nil
}
