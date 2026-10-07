package native

import (
	"context"
	pb "github.com/agent-substrate/substrate/pkg/proto/ateapipb"
	"google.golang.org/protobuf/encoding/protowire"
	"strings"
	"testing"
)

func cleanupWire() []byte {
	var msg []byte
	for i, value := range []string{"actor-uid", "worker-uid", "11111111-1111-4111-8111-111111111111", "sha256:" + strings.Repeat("a", 64), CodeProfile} {
		msg = protowire.AppendTag(msg, protowire.Number(i+1), protowire.BytesType)
		msg = protowire.AppendString(msg, value)
	}
	msg = protowire.AppendTag(msg, 6, protowire.VarintType)
	return protowire.AppendVarint(msg, 1)
}
func statusProof(msg []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(nil, 12, protowire.BytesType), msg)
}
func TestCleanupWireFailsClosedForUnknownMissingDuplicateAndWrongImage(t *testing.T) {
	raw := statusProof(cleanupWire())
	if p, e := decodeCodeCleanup(raw, testRun, testImage); e != nil || !p.Cleaned || p.Generation == "" {
		t.Fatal(e)
	}
	if p, e := decodeCodeCleanup(nil, testRun, testImage); e != nil || p.Cleaned {
		t.Fatal("missing is not evidence")
	}
	for _, bad := range [][]byte{append(append([]byte{}, raw...), raw...), statusProof(append(cleanupWire(), protowire.AppendTag(nil, 7, protowire.VarintType)...)), statusProof(append(cleanupWire(), protowire.AppendVarint(protowire.AppendTag(nil, 6, protowire.VarintType), 1)...)), statusProof(cleanupWire()[:len(cleanupWire())-2]), statusProof([]byte{8, 1}), []byte(strings.Repeat("x", 4097))} {
		if _, e := decodeCodeCleanup(bad, testRun, testImage); e == nil {
			t.Fatal("malformed cleanup accepted")
		}
	}
	if _, e := decodeCodeCleanup(raw, testRun, strings.Replace(testImage, "aaaaaaaa", "bbbbbbbb", 1)); e == nil {
		t.Fatal("wrong digest accepted")
	}
}
func TestCleanupRequiresStoppedServerActorUIDAndNoWorker(t *testing.T) {
	a, f := setupFake(t)
	a.config.Atespace = "ax-code"
	f.actor.Metadata.Atespace = "ax-code"
	f.actor.Metadata.Uid = "actor-uid"
	f.actor.Status.ProtoReflect().SetUnknown(statusProof(cleanupWire()))
	if p, e := a.ObserveCodeCleanup(context.Background(), testRun); e != nil || !p.Cleaned {
		t.Fatal(e)
	}
	f.actor.Metadata.Uid = "other"
	if _, e := a.ObserveCodeCleanup(context.Background(), testRun); e == nil {
		t.Fatal("wrong actor uid accepted")
	}
	f.actor.Metadata.Uid = "actor-uid"
	f.actor.Status.WorkerAssignment = &pb.WorkerAssignment{}
	if p, e := a.ObserveCodeCleanup(context.Background(), testRun); e != nil || p.Cleaned {
		t.Fatal("assigned worker accepted")
	}
	f.actor.Status.WorkerAssignment = nil
	f.actor.Status.State = pb.ActorState_ACTOR_STATE_RUNNING
	if p, e := a.ObserveCodeCleanup(context.Background(), testRun); e != nil || p.Cleaned {
		t.Fatal("running actor accepted")
	}
}
