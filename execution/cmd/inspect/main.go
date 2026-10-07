package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

func main() { os.Exit(run()) }
func run() int {
	path := flag.String("config", os.Getenv("AX_EXECUTION_CONFIG"), "configuration file path")
	guest := flag.Bool("guest", false, "observe direct guest TLS, ProcessService and fixed runner status")
	interactive := flag.Bool("interactive", false, "observe the configured credential-free interactive atespace")
	flag.Parse()
	if *path == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "config_required")
		return 2
	}
	var ids []string
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 16385))
	if err != nil || len(data) > 16384 || json.Unmarshal(data, &ids) != nil || len(ids) == 0 || len(ids) > 256 {
		fmt.Fprintln(os.Stderr, "run_ids_json_required")
		return 2
	}
	config, err := settings.Load(*path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config_invalid")
		return 2
	}
	nativeConfig, err := inspectConfig(config, *interactive)
	if err != nil {
		fmt.Fprintln(os.Stderr, "native_config_invalid")
		return 2
	}
	adapter, err := native.Dial(nativeConfig)
	if err != nil {
		fmt.Fprintln(os.Stderr, "native_config_invalid")
		return 2
	}
	defer adapter.Close()
	encoder := json.NewEncoder(os.Stdout)
	exit := 0
	for _, id := range ids {
		if *guest {
			diagnostic := adapter.InspectGuest(context.Background(), id)
			if !diagnostic.StatusObserved {
				exit = 1
			}
			if encoder.Encode(diagnostic) != nil {
				return 1
			}
			continue
		}
		task, taskErr := adapter.InspectTask(context.Background(), id)
		actor, actorErr := adapter.ObserveStop(context.Background(), id)
		egress, egressErr := adapter.ObserveEgress(context.Background(), id, false)
		verified := taskErr == nil && task.Phase == "Suspended" && actorErr == nil && actor.Stopped && egressErr == nil && egress.Denied && egress.Matches
		if !verified {
			exit = 1
		}
		if encoder.Encode(map[string]any{"run_id": id, "task_observed": taskErr == nil, "ax_suspended": taskErr == nil && task.Phase == "Suspended", "actor_observed": actorErr == nil, "actor_stopped": actorErr == nil && actor.Stopped, "worker_unassigned": actorErr == nil && !actor.HasWorker, "egress_observed": egressErr == nil, "egress_denied": egressErr == nil && egress.Denied && egress.Matches, "verified_stopped_and_denied": verified}) != nil {
			return 1
		}
	}
	return exit
}

func inspectConfig(config settings.File, interactive bool) (native.Config, error) {
	if !interactive {
		return config.Native()
	}
	selected, err := config.InteractiveNative()
	if err != nil || selected == nil {
		return native.Config{}, errors.New("interactive_config_required")
	}
	return *selected, nil
}
