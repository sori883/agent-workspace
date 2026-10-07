package native

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestWorkbenchManifestAndCanonicalHistoryLimits(t *testing.T) {
	r, w := workbenchFixture(t)
	for i := 0; i < 9; i++ {
		w.Descriptor.DefinitionManifest = append(w.Descriptor.DefinitionManifest, DefinitionRef{ID: fmt.Sprintf("11111111-1111-4111-8111-%012d", i), SHA256: strings.Repeat("a", 64), SizeBytes: 1, Kind: "skill"})
	}
	bind := func() { raw, _ := CanonicalJSON(w.Descriptor); r.DescriptorSHA256 = HashBytes(raw) }
	bind()
	if w.Validate(r) == nil {
		t.Fatal("nine skills accepted")
	}
	w.Descriptor.DefinitionManifest[0].Kind = "agent"
	bind()
	if err := w.Validate(r); err != nil {
		t.Fatal("agent and eight skills rejected", err)
	}
	w.Descriptor.History = []WorkbenchHistory{{Kind: "user_start", Text: strings.Repeat("x", 8192)}, {Kind: "output", Text: strings.Repeat("x", 8192)}}
	bind()
	if w.Validate(r) == nil {
		t.Fatal("canonical history above 16 KiB accepted")
	}
	w.Descriptor.History[1].Text = "ok"
	bind()
	if err := w.Validate(r); err != nil {
		t.Fatal(err)
	}
}

func TestCodeTrustedWaitIsFixedDetachedAndBounded(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	if err := a.PrepareCodeRunner(context.Background(), testRun, 240*time.Second); err != nil {
		t.Fatal(err)
	}
	if len(f.command) != 3 || f.command[0] != "python3" || f.command[1] != "/opt/ax-code/runner.py" || f.command[2] != "wait" || f.processTimeout != 240*time.Second {
		t.Fatal("trusted wait command or timeout changed")
	}
	if f.count("process:start") != 1 || f.count("process:stream") != 0 {
		t.Fatal("trusted wait was resent or awaited to completion")
	}
	for _, duration := range []time.Duration{0, -time.Second, 301 * time.Second} {
		if err := a.PrepareCodeRunner(context.Background(), testRun, duration); err == nil {
			t.Fatal("invalid process lifetime accepted")
		}
	}
	a.config.Atespace = "ax-runtime"
	if err := a.PrepareCodeRunner(context.Background(), testRun, time.Second); err == nil || f.count("process:start") != 1 {
		t.Fatal("runtime path widened")
	}
}

func TestCodeProcessReadinessOnlyReadsBoundGuest(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	if err := a.ObserveCodeProcessService(context.Background(), testRun); err != nil {
		t.Fatal(err)
	}
	if f.count("process:get") != 1 || f.count("process:start") != 0 || f.count("resume") != 0 || f.metadataBad {
		t.Fatal("readiness changed guest or lost actor binding")
	}
	a.config.Atespace = "ax-runtime"
	if err := a.ObserveCodeProcessService(context.Background(), testRun); err == nil || f.count("process:get") != 1 {
		t.Fatal("readiness widened beyond code atespace")
	}
}

func TestCodeProcessReadinessRejectsAbsentOrUnavailableService(t *testing.T) {
	for _, code := range []codes.Code{codes.Unimplemented, codes.Unavailable, codes.PermissionDenied} {
		t.Run(code.String(), func(t *testing.T) {
			a, f := setupFake(t)
			a.config.Atespace = "ax-code"
			f.processReadError = status.Error(code, "sensitive downstream value")
			err := a.ObserveCodeProcessService(context.Background(), testRun)
			requireKind(t, err, "observation_failed")
			if strings.Contains(err.Error(), "sensitive") || f.count("process:get") != 1 || f.count("process:start") != 0 {
				t.Fatal("readiness leaked details, retried internally, or started work")
			}
		})
	}
}

func TestCodeProcessReadinessDoesNotWakeStoppedActor(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	a.config.DirectGuest, _ = testGuestConfig(t)
	a.guest = nil
	f.actor.Metadata.Atespace = "ax-code"
	if err := a.ObserveCodeProcessService(context.Background(), testRun); err == nil {
		t.Fatal("stopped actor was treated as ready")
	}
	if f.count("control:actor") != 1 || f.count("process:get") != 0 || f.count("process:start") != 0 || f.count("resume") != 0 {
		t.Fatal("readiness observation woke actor")
	}
}

func TestCodeTrustedWaitRPCFailureIsUnknownAndNeverRetried(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	f.processError = status.Error(codes.Unavailable, "sensitive downstream message")
	err := a.PrepareCodeRunner(context.Background(), testRun, time.Minute)
	requireKind(t, err, "unknown")
	if f.count("process:start") != 1 || f.count("process:stream") != 0 {
		t.Fatal("uncertain process start was resent")
	}
	if strings.Contains(err.Error(), "sensitive") {
		t.Fatal("provider message escaped")
	}
}

func TestCodeStatusBeforeStagePreservesDescriptorBinding(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	r, _ := workbenchFixture(t)
	r.Adapter = "python"
	f.stdout = []byte(`{"run_id":"` + r.RunID + `","state":"waiting","attempted":false,"result":null}`)
	s, err := a.StatusWorkbench(context.Background(), r)
	if err != nil || s.RunID != r.RunID || s.State != "waiting" || s.Attempted || s.Result != nil {
		t.Fatal("unstaged code runner was not accepted as waiting", err)
	}
	if len(f.command) != 4 || f.command[0] != "python3" || f.command[1] != "/opt/ax-code/runner.py" || f.command[2] != "code-status" {
		t.Fatal("status invoked a different code operation")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(f.command[3])
	var input map[string]string
	if err != nil || json.Unmarshal(raw, &input) != nil || len(input) != 2 || input["run_id"] != r.RunID || input["descriptor_sha256"] != r.DescriptorSHA256 {
		t.Fatal("status did not preserve the unstaged run and descriptor binding")
	}
	if f.count("process:start") != 1 || f.count("process:stream") != 1 || f.count("resume") != 0 || f.count("create") != 0 {
		t.Fatal("status retried or changed task lifecycle")
	}
}

func workbenchFixture(t *testing.T) (WorkbenchRequest, Workbench) {
	t.Helper()
	w := Workbench{Version: 2, AttemptKind: "runtime", ExecutionPolicy: WorkbenchPolicy, Mode: "preview", ProfileID: "preview-v1", RemainingMS: 300000, Descriptor: WorkbenchDescriptor{Version: 2, RootID: "11111111-1111-4111-8111-111111111111", Instruction: "集計 <CSV>\u2028", DefinitionManifest: []DefinitionRef{}, Inputs: []WorkbenchFile{}, Outputs: []WorkbenchOutput{}, History: []WorkbenchHistory{}, Code: nil}}
	raw, e := CanonicalJSON(w.Descriptor)
	if e != nil {
		t.Fatal(e)
	}
	r := WorkbenchRequest{SchemaVersion: 2, RunID: testRun, RootID: w.Descriptor.RootID, Adapter: "interactive", DescriptorSHA256: HashBytes(raw)}
	return r, w
}
func TestWorkbenchRequestVersionCannotCrossLegacy(t *testing.T) {
	r, w := workbenchFixture(t)
	raw, _ := json.Marshal(r)
	if _, e := ParseRequest(raw); e == nil {
		t.Fatal("v2 accepted by v1")
	}
	if _, e := ParseWorkbenchRequest(raw); e != nil {
		t.Fatal(e)
	}
	if e := w.Validate(r); e != nil {
		t.Fatal(e)
	}
	var m map[string]any
	json.Unmarshal(raw, &m)
	m["instruction"] = "injected"
	raw, _ = json.Marshal(m)
	if _, e := ParseWorkbenchRequest(raw); e == nil {
		t.Fatal("extra legacy field accepted")
	}
	w.Descriptor.Instruction = "different"
	if w.Validate(r) == nil {
		t.Fatal("descriptor not bound")
	}
}
func TestCanonicalDescriptorMatchesPostgresUTF8Sorting(t *testing.T) {
	raw, e := CanonicalJSON(map[string]any{"2": "é\u2029", "10": "<>&\u2028", "text": "\b\f\n\r\t"})
	if e != nil || string(raw) != "{\"10\":\"<>&\u2028\",\"2\":\"é\u2029\",\"text\":\"\\b\\f\\n\\r\\t\"}" {
		t.Fatalf("canonical mismatch %q %v", raw, e)
	}
}
func TestWorkbenchProposalBoundary(t *testing.T) {
	valid := `{"kind":"python","source":"print('ok')","input_aliases":["input_1"],"outputs":[{"name":"result.csv","size_limit_bytes":8388608}],"purpose":"summary"}`
	if _, e := ParseWorkbenchProposal([]byte(valid)); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{strings.Replace(valid, "result.csv", "../result.csv", 1), strings.Replace(valid, "8388608", "8388609", 1), strings.Replace(valid, "print('ok')", strings.Repeat("x", 4097), 1), strings.Replace(valid, `"purpose":`, `"env":{},"purpose":`, 1), strings.Replace(valid, `["input_1"]`, `["input_1","input_1"]`, 1)} {
		if _, e := ParseWorkbenchProposal([]byte(s)); e == nil {
			t.Fatal("unsafe proposal accepted")
		}
	}
	if _, e := ParseProposal([]byte(valid)); e == nil {
		t.Fatal("legacy tools widened")
	}
}
func TestWorkbenchMailboxKeepsRawDigestAndVersion(t *testing.T) {
	r, _ := workbenchFixture(t)
	raw := `{"version":2,"run_id":"` + r.RunID + `","sequence":2,"kind":"tool","body":{"kind":"output","text":"ok"}}`
	envelope, _ := json.Marshal(map[string]string{"request_base64": base64.StdEncoding.EncodeToString([]byte(raw)), "sha256": HashBytes([]byte(raw))})
	m, e := ParseWorkbenchMailbox(envelope, r.RunID)
	if e != nil || string(m.Bytes) != raw {
		t.Fatal(e)
	}
	if _, e = ParseMailbox(envelope, r.RunID); e == nil {
		t.Fatal("v1 accepted v2")
	}
	reply, _ := json.Marshal(MailboxReply{Version: 1, RunID: r.RunID, Sequence: 2, RequestSHA256: m.SHA256, Status: "ok", Body: map[string]json.RawMessage{}})
	if _, e = ParseReply(reply, m); e == nil {
		t.Fatal("cross-version reply")
	}
}
func TestChunkRequiresExactCanonicalBytes(t *testing.T) {
	raw := strings.Repeat("x", WorkbenchChunkBytes)
	s := base64.StdEncoding.EncodeToString([]byte(raw))
	if b, e := DecodeChunk(s, len(raw)); e != nil || string(b) != raw {
		t.Fatal(e)
	}
	for _, s := range []string{s + "\n", s[:len(s)-1], base64.StdEncoding.EncodeToString([]byte(raw + "x"))} {
		if _, e := DecodeChunk(s, len(raw)); e == nil {
			t.Fatal("bad chunk accepted")
		}
	}
}
func TestStandaloneSkillAndRuntimeMetadataLimit(t *testing.T) {
	r, w := workbenchFixture(t)
	w.Descriptor.DefinitionManifest = []DefinitionRef{{ID: r.RootID, Kind: "skill", SizeBytes: 10, SHA256: strings.Repeat("a", 64)}}
	for i := 0; i < 16; i++ {
		id := strings.Repeat("a", 31) + string("0123456789abcdef"[i])
		w.Descriptor.Inputs = append(w.Descriptor.Inputs, WorkbenchFile{Alias: "input_" + id, FileID: id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:], Name: "結果.CSV", SizeBytes: WorkbenchFileBytes, SHA256: strings.Repeat("b", 64)})
	}
	raw, _ := CanonicalJSON(w.Descriptor)
	r.DescriptorSHA256 = HashBytes(raw)
	if e := w.Validate(r); e != nil {
		t.Fatal(e)
	}
}
func TestWorkbenchGuestCommandsAreFixedAndBounded(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-runtime"
	r, w := workbenchFixture(t)
	f.stdout = []byte(`{"run_id":"` + testRun + `","state":"staged"}`)
	if e := a.StageWorkbench(context.Background(), r, w); e != nil {
		t.Fatal(e)
	}
	if len(f.command) != 4 || f.command[1] != "/opt/ax-task/workbench_runner.py" || f.command[2] != "stage" {
		t.Fatal("wrong runtime command")
	}
	a.config.Atespace = "ax-code"
	r.Adapter = "python"
	f.stdout = []byte(`{"run_id":"` + testRun + `","state":"started"}`)
	if e := a.StartWorkbench(context.Background(), r); e != nil {
		t.Fatal(e)
	}
	if f.command[1] != "/opt/ax-code/runner.py" || f.command[2] != "code-start" {
		t.Fatal("wrong code command")
	}
	raw, e := base64.StdEncoding.DecodeString(f.command[3])
	if e != nil || !strings.Contains(string(raw), r.DescriptorSHA256) {
		t.Fatal("missing descriptor binding")
	}
	if _, e = a.SetEgress(context.Background(), testRun, true); e == nil {
		t.Fatal("code egress enabled")
	}
	if _, e = a.workbenchRPC(context.Background(), testRun, "stage", strings.Repeat("x", 65537), true); e == nil {
		t.Fatal("oversized frame accepted")
	}
}
func TestCodeTemplateCannotContainProviderEnvOrBroaderResources(t *testing.T) {
	a, _ := setupFake(t)
	a.config.Atespace = "ax-code"
	makeTemplate := func() *pb.ActorTemplate {
		return &pb.ActorTemplate{Metadata: &pb.ResourceMetadata{Name: testRun + "-tmpl-01234567", Atespace: "ax-code"}, Containers: []*pb.Container{{Name: "guest", Image: testImage, Command: []string{"/usr/local/bin/ax-task-runner", "--task-file", "/opt/ax-code/server-task.json"}, Readyz: &pb.ContainerReadyz{HttpGet: &pb.HTTPGetAction{Path: "/readyz", Port: 80}, TimeoutSeconds: 30}, VolumeMounts: []*pb.VolumeMount{{Name: "workspace", MountPath: "/workspace"}}, SecurityContext: &pb.SecurityContext{Capabilities: &pb.Capabilities{Drop: []string{"ALL"}, Add: []string{"KILL", "SYS_CHROOT", "SETUID", "SETGID", "SETPCAP"}}}}}, Volumes: []*pb.Volume{{Name: "workspace", DurableDir: &pb.DurableDirVolumeSource{}}}, SandboxConfig: &pb.SandboxConfig{SandboxClass: pb.SandboxClass_SANDBOX_CLASS_GVISOR, ConfigName: "gvisor-default"}, Resources: &pb.Resources{Limits: []*pb.Limits{{Name: "cpu", Quantity: "1"}, {Name: "memory", Quantity: "384Mi"}}}, SnapshotsConfig: &pb.SnapshotsConfig{OnPause: pb.SnapshotContentScope_SNAPSHOT_CONTENT_SCOPE_DATA, OnCommit: pb.SnapshotContentScope_SNAPSHOT_CONTENT_SCOPE_DATA, OnResume: &pb.OnResumeConfig{FromData: pb.ResumeSource_RESUME_SOURCE_COLD_BOOT}}}
	}
	ref := &pb.ObjectRef{Name: testRun + "-tmpl-01234567", Atespace: "ax-code"}
	if !a.runtimeTemplateMatches(makeTemplate(), testRun, ref) {
		t.Fatal("valid code template rejected")
	}
	for _, poison := range []func(*pb.ActorTemplate){func(x *pb.ActorTemplate) {
		x.Containers[0].Env = []*pb.EnvVar{{Name: "GEMINI_API_KEY", Value: "synthetic"}}
	}, func(x *pb.ActorTemplate) { x.Resources.Limits[1].Quantity = "512Mi" }, func(x *pb.ActorTemplate) {
		x.Containers[0].SecurityContext.Capabilities.Add = append(x.Containers[0].SecurityContext.Capabilities.Add, "SYS_ADMIN")
	}, func(x *pb.ActorTemplate) {
		x.Containers[0].Command = []string{"python3", "/opt/ax-code/runner.py", "wait"}
	}, func(x *pb.ActorTemplate) {
		x.Containers[0].Command = []string{"/usr/local/bin/ax-task-runner"}
	}, func(x *pb.ActorTemplate) {
		x.Containers[0].Command[2] = "/workspace/server-task.json"
	}} {
		x := makeTemplate()
		poison(x)
		if a.runtimeTemplateMatches(x, testRun, ref) {
			t.Fatal("unsafe code template accepted")
		}
	}
}

func TestCanonicalPreservesLiteralUnicodeEscapes(t *testing.T) {
	raw, e := CanonicalJSON(map[string]string{"literal": `\u2028`, "separator": "\u2028"})
	if e != nil {
		t.Fatal(e)
	}
	var value map[string]string
	if json.Unmarshal(raw, &value) != nil || value["literal"] != `\u2028` || value["separator"] != "\u2028" {
		t.Fatalf("literal escape was changed %q", raw)
	}
}
