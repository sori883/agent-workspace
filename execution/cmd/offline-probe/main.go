package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

type probeStore struct {
	claim     *controller.Claim
	claimed   bool
	collected *native.Collection
	encoder   *json.Encoder
	effects   map[native.Operation]controller.Effect
}

func (s *probeStore) event(event string, extra map[string]any) error {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["event"] = event
	extra["run_id"] = s.claim.RunID
	return s.encoder.Encode(extra)
}
func (s *probeStore) Claim(context.Context) (*controller.Claim, error) {
	if s.claimed {
		return nil, nil
	}
	s.claimed = true
	return s.claim, s.event("probe_accepted", nil)
}
func (s *probeStore) Heartbeat(context.Context, *controller.Claim) error { return nil }
func (s *probeStore) Intent(_ context.Context, _ *controller.Claim, op native.Operation) (string, error) {
	if _, ok := s.effects[op]; ok {
		return "", errors.New("duplicate_probe_intent")
	}
	id := "probe-" + string(op)
	s.effects[op] = controller.Effect{OperationID: id}
	return id, s.event("effect_intent", map[string]any{"operation": op})
}
func (s *probeStore) Evidence(_ context.Context, _ *controller.Claim, id string, evidence map[string]any) error {
	for op, effect := range s.effects {
		if effect.OperationID == id {
			s.effects[op] = controller.Effect{OperationID: id, Evidence: evidence}
			return s.event("effect_observed", map[string]any{"operation": op, "evidence": evidence})
		}
	}
	return errors.New("unknown_probe_intent")
}
func (s *probeStore) Collect(_ context.Context, _ *controller.Claim, value native.Collection) error {
	s.collected = &value
	return s.event("result_collected", map[string]any{"status": value.Result.Status, "artifact": value.Result.Artifact, "estimated_usd": value.Result.EstimatedUSD, "usage": value.Result.Usage})
}
func (s *probeStore) Finish(context.Context, *controller.Claim) error {
	if s.collected == nil || s.collected.Result.Status != "succeeded" || s.effects[native.DenyOperation].Evidence == nil || s.effects[native.SuspendOperation].Evidence == nil {
		return errors.New("probe_incomplete")
	}
	return s.event("probe_succeeded", nil)
}
func (s *probeStore) Fail(_ context.Context, _ *controller.Claim, code string) error {
	return s.event("probe_needs_recovery", map[string]any{"code": code})
}

func main() { os.Exit(run()) }
func run() int {
	path := flag.String("config", os.Getenv("AX_EXECUTION_CONFIG"), "configuration file path")
	isolated := flag.Bool("isolated-offline-probe", false, "confirm admission is isolated and no existing work is running")
	flag.Parse()
	if *path == "" || !*isolated || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "isolated_offline_probe_required")
		return 2
	}
	config, err := settings.Load(*path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config_invalid")
		return 2
	}
	nativeConfig, err := config.Native()
	if err != nil || nativeConfig.DirectGuest == nil {
		fmt.Fprintln(os.Stderr, "native_config_invalid")
		return 2
	}
	adapter, err := native.Dial(nativeConfig)
	if err != nil {
		fmt.Fprintln(os.Stderr, "native_config_invalid")
		return 2
	}
	defer adapter.Close()
	var bytes [8]byte
	if _, err = rand.Read(bytes[:]); err != nil {
		fmt.Fprintln(os.Stderr, "run_id_failed")
		return 1
	}
	id := "ax-run-" + hex.EncodeToString(bytes[:])
	claim := &controller.Claim{RunID: id, Generation: 1, Kind: "execute", Image: config.Image, Request: native.Request{SchemaVersion: 1, RunID: id, Adapter: "offline", Instruction: "Return a local offline verification artifact.", Inputs: map[string]string{"input.txt": "native adapter offline"}, OutputName: "output.txt"}}
	store := &probeStore{claim: claim, encoder: json.NewEncoder(os.Stdout), effects: map[native.Operation]controller.Effect{}}
	runner := controller.New(store, adapter, config.Image)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if _, err = runner.RunOnce(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "probe_unconfirmed_do_not_retry")
		return 1
	}
	return 0
}
