package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout)) }

func run(args []string, output io.Writer) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runContext(ctx, args, output)
}

func runContext(ctx context.Context, args []string, output io.Writer) int {
	report := func(event string) { _ = json.NewEncoder(output).Encode(map[string]string{"event": event}) }
	flags := flag.NewFlagSet("workbench-probe", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath, fixturePath := flags.String("config", "", "isolated execution configuration"), flags.String("fixture", "", "fixed probe fixture")
	idle := flags.Bool("idle", false, "validate isolated fixture and wait without database or native calls")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || *fixturePath == "" {
		report("probe_arguments_invalid")
		return 2
	}
	f, err := loadFixture(*fixturePath)
	if err != nil {
		report("probe_fixture_invalid")
		return 2
	}
	config, err := settings.Load(*configPath)
	if err != nil || validateConfig(config, f) != nil {
		report("probe_config_invalid")
		return 2
	}
	if *idle {
		report("probe_idle_no_claim")
		<-ctx.Done()
		return 0
	}
	runtimeConfig, err := config.InteractiveNative()
	if err != nil || runtimeConfig == nil {
		report("probe_native_config_invalid")
		return 2
	}
	codeConfig, err := config.CodeNative()
	if err != nil || codeConfig == nil {
		report("probe_native_config_invalid")
		return 2
	}
	runtime, err := native.Dial(*runtimeConfig)
	if err != nil {
		report("probe_native_config_invalid")
		return 2
	}
	defer runtime.Close()
	code, err := native.Dial(*codeConfig)
	if err != nil {
		report("probe_native_config_invalid")
		return 2
	}
	defer code.Close()
	databaseConfig, err := config.DatabaseConfig()
	if err != nil {
		report("probe_database_config_invalid")
		return 2
	}
	database, err := controller.OpenPostgres(ctx, databaseConfig, config.ControllerID)
	if err != nil {
		report("probe_database_unavailable")
		return 1
	}
	defer database.Close()
	store := &probeStore{backend: database, fixture: f}
	store.observe = func(stage, code string, revision int) {
		_ = json.NewEncoder(output).Encode(struct {
			Event    string `json:"event"`
			Stage    string `json:"stage"`
			Code     string `json:"code"`
			Revision int    `json:"revision"`
		}{"probe_stage", stage, code, revision})
	}
	runner := controller.New(store, runtime, runtimeConfig.Image)
	runner.WorkbenchRuntime, runner.WorkbenchRuntimeImage = runtime, runtimeConfig.Image
	runner.WorkbenchCode, runner.WorkbenchCodeImage = code, codeConfig.Image
	runner.WorkbenchPythonEnabled = true
	if err := runJobs(ctx, runner); err != nil {
		report("probe_execution_unconfirmed")
		return 1
	}
	report("probe_three_jobs_processed_check_database")
	return 0
}

type jobRunner interface {
	RunOnce(context.Context) (bool, error)
}

func runJobs(ctx context.Context, runner jobRunner) error {
	for i := 0; i < 3; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		worked, err := runner.RunOnce(ctx)
		if err != nil {
			return err
		}
		if !worked {
			return errors.New("probe_job_missing")
		}
	}
	return nil
}
