package native

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	ax "github.com/google/ax/pkg/apis/v1alpha1"
	"gopkg.in/yaml.v3"
)

func mailboxEnvelope(raw string) []byte {
	hash := sha256.Sum256([]byte(raw))
	wire, _ := json.Marshal(map[string]string{"request_base64": base64.StdEncoding.EncodeToString([]byte(raw)), "sha256": hex.EncodeToString(hash[:])})
	return wire
}
func TestMailboxPreservesSourceAndRejectsAmbiguity(t *testing.T) {
	raw := `{"version":1,"run_id":"` + testRun + `","sequence":1,"kind":"model","body":{"contents":[]}}`
	m, err := ParseMailbox(mailboxEnvelope(raw), testRun)
	if err != nil || string(m.Bytes) != raw {
		t.Fatal("source changed")
	}
	for _, bad := range []string{strings.Replace(raw, `"version":1`, `"version":1,"version":1`, 1), strings.Replace(raw, `"contents":[]`, `"contents":[],"contents":[]`, 1), strings.Replace(raw, `"sequence":1`, `"sequence":2`, 1), strings.Replace(raw, `"body":{`, `"body":null,"extra":{`, 1), strings.Replace(raw, testRun, "ax-run-0000000000000000", 1)} {
		if _, err := ParseMailbox(mailboxEnvelope(bad), testRun); err == nil {
			t.Fatal("ambiguous mailbox accepted")
		}
	}
	if _, err := ParseMailbox(mailboxEnvelope(raw+strings.Repeat(" ", MaxMailboxBytes)), testRun); err == nil {
		t.Fatal("oversize accepted")
	}
	wire := mailboxEnvelope(raw)
	wire = []byte(strings.Replace(string(wire), m.SHA256, strings.Repeat("a", 64), 1))
	if _, err := ParseMailbox(wire, testRun); err == nil {
		t.Fatal("hash mismatch accepted")
	}
}
func TestInteractiveCannotUseLegacyOrExternalEgress(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-runtime"
	if _, err := a.SetEgress(context.Background(), testRun, true); err == nil {
		t.Fatal("runtime egress enabled")
	}
	if err := a.Stage(context.Background(), testRequest()); err == nil {
		t.Fatal("legacy staged in runtime")
	}
	if _, err := a.Create(context.Background(), testRun); err == nil || f.count("create") != 0 {
		t.Fatal("existing actor accepted")
	}
}
func TestRuntimeTemplateRejectsKeysImagesAndMounts(t *testing.T) {
	a, _ := setupFake(t)
	a.config.Atespace = "ax-runtime"
	launch := &ax.Task{ApiVersion: "ax.io/v1alpha1", Kind: "Task", Metadata: &ax.ObjectMeta{Name: testRun, Atespace: "ax-runtime"}, Spec: &ax.TaskSpec{Image: testImage, Command: runnerCommand, Debug: true}}
	taskYAML, _ := yaml.Marshal(launch)
	makeTemplate := func() *pb.ActorTemplate {
		return &pb.ActorTemplate{Metadata: &pb.ResourceMetadata{Name: testRun + "-tmpl-01234567", Atespace: "ax-runtime"}, Containers: []*pb.Container{{Name: "guest", Image: testImage, Command: []string{"/usr/local/bin/ax-task-runner"}, Env: []*pb.EnvVar{{Name: "AX_TASK_YAML", Value: string(taskYAML)}}, VolumeMounts: []*pb.VolumeMount{{Name: "workspace", MountPath: "/workspace"}}}}, Volumes: []*pb.Volume{{Name: "workspace", DurableDir: &pb.DurableDirVolumeSource{}}}, SandboxConfig: &pb.SandboxConfig{SandboxClass: pb.SandboxClass_SANDBOX_CLASS_GVISOR, ConfigName: "gvisor-default"}}
	}
	ref := &pb.ObjectRef{Name: testRun + "-tmpl-01234567", Atespace: "ax-runtime"}
	if !a.runtimeTemplateMatches(makeTemplate(), testRun, ref) {
		t.Fatal("clean template refused")
	}
	for _, poison := range []func(*pb.ActorTemplate){func(x *pb.ActorTemplate) {
		x.Containers[0].Env = append(x.Containers[0].Env, &pb.EnvVar{Name: "GEMINI_API_KEY", Value: "synthetic"})
	}, func(x *pb.ActorTemplate) { x.Containers[0].Image = "old" }, func(x *pb.ActorTemplate) {
		x.Containers[0].VolumeMounts = append(x.Containers[0].VolumeMounts, &pb.VolumeMount{Name: "secret", MountPath: "/secret"})
	}, func(x *pb.ActorTemplate) {
		x.Containers[0].Env[0].Value = strings.Replace(string(taskYAML), "ax-runtime", "ax-demo", 1)
	}} {
		x := makeTemplate()
		poison(x)
		if a.runtimeTemplateMatches(x, testRun, ref) {
			t.Fatal("unsafe template accepted")
		}
	}
}
func TestMailboxReplyIsBoundToRequest(t *testing.T) {
	m, _ := ParseMailbox(mailboxEnvelope(`{"version":1,"run_id":"`+testRun+`","sequence":2,"kind":"tool","body":{"kind":"output","text":"ok"}}`), testRun)
	reply := MailboxReply{Version: 1, RunID: testRun, Sequence: 2, RequestSHA256: m.SHA256, Status: "ok", Body: map[string]json.RawMessage{"accepted": json.RawMessage(`true`)}}
	data, _ := json.Marshal(reply)
	if _, err := ParseReply(data, m); err != nil {
		t.Fatal(err)
	}
	reply.RequestSHA256 = strings.Repeat("a", 64)
	data, _ = json.Marshal(reply)
	if _, err := ParseReply(data, m); err == nil {
		t.Fatal("wrong request accepted")
	}
}
