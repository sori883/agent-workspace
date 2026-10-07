package native

import (
	"context"
	controlpb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/protobuf/encoding/protowire"
	"strings"
)

func (a *Adapter) ObserveCodeCleanup(ctx context.Context, run string) (CodeCleanup, error) {
	if a.config.Atespace != "ax-code" || !runPattern.MatchString(run) {
		return CodeCleanup{}, invalid("code_cleanup")
	}
	ctx, cancel := a.callContext(ctx, a.config.Substrate, a.config.CallTimeout, "")
	defer cancel()
	actor, e := a.control.GetActor(ctx, &controlpb.GetActorRequest{Actor: a.actorRef(run)})
	if e != nil {
		return CodeCleanup{}, rpcFailure("code_cleanup", false, e)
	}
	if actor.GetMetadata().GetName() != run || actor.GetMetadata().GetAtespace() != a.config.Atespace || actor.GetMetadata().GetUid() == "" || actor.GetStatus() == nil {
		return CodeCleanup{}, failure("code_cleanup", false, "actor_identity_mismatch")
	}
	state := actor.GetStatus()
	if state.GetState() != controlpb.ActorState_ACTOR_STATE_SUSPENDED || state.GetWorkerAssignment() != nil {
		return CodeCleanup{}, nil
	}
	proof, e := decodeCodeCleanup(state.ProtoReflect().GetUnknown(), run, a.config.Image)
	if e != nil {
		return CodeCleanup{}, failure("code_cleanup", false, "invalid_host_evidence")
	}
	if !proof.Cleaned {
		return proof, nil
	}
	if proof.ActorUID != actor.GetMetadata().GetUid() {
		return CodeCleanup{}, failure("code_cleanup", false, "actor_identity_mismatch")
	}
	return proof, nil
}
func decodeCodeCleanup(raw []byte, run, image string) (CodeCleanup, error) {
	if len(raw) > 4096 {
		return CodeCleanup{}, errProtocol
	}
	var message []byte
	found := false
	for len(raw) > 0 {
		number, kind, n := protowire.ConsumeTag(raw)
		if n < 0 {
			return CodeCleanup{}, errProtocol
		}
		raw = raw[n:]
		if number == 12 {
			if found || kind != protowire.BytesType {
				return CodeCleanup{}, errProtocol
			}
			value, n := protowire.ConsumeBytes(raw)
			if n < 0 || len(value) > 1024 {
				return CodeCleanup{}, errProtocol
			}
			message = value
			found = true
			raw = raw[n:]
		} else {
			n := protowire.ConsumeFieldValue(number, kind, raw)
			if n < 0 {
				return CodeCleanup{}, errProtocol
			}
			raw = raw[n:]
		}
	}
	if !found {
		return CodeCleanup{}, nil
	}
	values := map[protowire.Number]string{}
	cleaned := false
	seen := map[protowire.Number]bool{}
	for len(message) > 0 {
		number, kind, n := protowire.ConsumeTag(message)
		if n < 0 || number < 1 || number > 6 || seen[number] {
			return CodeCleanup{}, errProtocol
		}
		seen[number] = true
		message = message[n:]
		if number == 6 {
			if kind != protowire.VarintType {
				return CodeCleanup{}, errProtocol
			}
			value, n := protowire.ConsumeVarint(message)
			if n < 0 || value != 1 {
				return CodeCleanup{}, errProtocol
			}
			cleaned = true
			message = message[n:]
		} else {
			if kind != protowire.BytesType {
				return CodeCleanup{}, errProtocol
			}
			value, n := protowire.ConsumeString(message)
			if n < 0 || len(value) > 256 || !validText(value) {
				return CodeCleanup{}, errProtocol
			}
			values[number] = value
			message = message[n:]
		}
	}
	if len(seen) != 6 || !imagePattern.MatchString(image) || values[4] != image[strings.LastIndex(image, "@")+1:] {
		return CodeCleanup{}, errProtocol
	}
	proof := CodeCleanup{Actor: run, ActorUID: values[1], WorkerUID: values[2], Generation: values[3], Image: image, Profile: values[5], Cleaned: cleaned}
	if proof.Validate(run, image) != nil {
		return CodeCleanup{}, errProtocol
	}
	return proof, nil
}
