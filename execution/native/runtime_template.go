package native

import (
	"context"
	"regexp"
	"slices"

	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	axpb "github.com/google/ax/pkg/apis/v1alpha1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"gopkg.in/yaml.v3"
)

func (a *Adapter) requireFreshActor(ctx context.Context, runID string) error {
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	_, err := a.control.GetActor(ctx, &controlpb.GetActorRequest{Actor: a.actorRef(runID)})
	if status.Code(err) == codes.NotFound {
		return nil
	}
	if err != nil {
		return rpcFailure(CreateOperation, false, err)
	}
	return failure(CreateOperation, false, "existing_runtime_actor")
}
func (a *Adapter) verifyRuntimeTemplate(ctx context.Context, runID string) error {
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	actor, err := a.control.GetActor(ctx, &controlpb.GetActorRequest{Actor: a.actorRef(runID)})
	if err != nil {
		return rpcFailure(ResumeOperation, false, err)
	}
	ref := actor.GetActorTemplate()
	if actor.GetMetadata().GetName() != runID || actor.GetMetadata().GetAtespace() != a.config.Atespace || actor.GetStatus().GetState() != controlpb.ActorState_ACTOR_STATE_SUSPENDED || actor.GetStatus().GetWorkerAssignment() != nil || ref.GetAtespace() != a.config.Atespace || !regexp.MustCompile("^"+regexp.QuoteMeta(runID)+"-tmpl-[0-9a-f]{8}$").MatchString(ref.GetName()) {
		return failure(ResumeOperation, false, "runtime_actor_mismatch")
	}
	template, err := a.control.GetActorTemplate(ctx, &controlpb.GetActorTemplateRequest{ActorTemplate: ref})
	if err != nil {
		return rpcFailure(ResumeOperation, false, err)
	}
	if !a.runtimeTemplateMatches(template, runID, ref) {
		return failure(ResumeOperation, false, "runtime_template_mismatch")
	}
	return nil
}
func (a *Adapter) runtimeTemplateMatches(t *controlpb.ActorTemplate, runID string, ref *controlpb.ObjectRef) bool {
	if t.GetMetadata().GetName() != ref.GetName() || t.GetMetadata().GetAtespace() != ref.GetAtespace() || len(t.GetContainers()) != 1 || len(t.GetVolumes()) != 1 || t.GetSandboxConfig().GetSandboxClass() != controlpb.SandboxClass_SANDBOX_CLASS_GVISOR || t.GetSandboxConfig().GetConfigName() != "gvisor-default" {
		return false
	}
	c := t.GetContainers()[0]
	if c.GetName() != "guest" || c.GetImage() != a.config.Image || !slices.Equal(c.GetCommand(), []string{"/usr/local/bin/ax-task-runner"}) || len(c.GetEnv()) != 1 || c.GetEnv()[0].GetName() != "AX_TASK_YAML" || len(c.GetVolumeMounts()) != 1 {
		return false
	}
	if !proto.Equal(c.GetVolumeMounts()[0], &controlpb.VolumeMount{Name: "workspace", MountPath: "/workspace"}) || !proto.Equal(t.GetVolumes()[0], &controlpb.Volume{Name: "workspace", DurableDir: &controlpb.DurableDirVolumeSource{}}) {
		return false
	}
	var launch axpb.Task
	if len(c.GetEnv()[0].GetValue()) > 49152 || yaml.Unmarshal([]byte(c.GetEnv()[0].GetValue()), &launch) != nil {
		return false
	}
	_, err := a.taskObservation(&launch, runID)
	return err == nil
}
