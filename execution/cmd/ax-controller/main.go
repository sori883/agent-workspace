package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/native"
	"github.com/sori883/agent-workspace/execution/settings"
)

func main()               { os.Exit(run()) }
func report(event string) { json.NewEncoder(os.Stdout).Encode(map[string]string{"event": event}) }
func run() int {
	path := flag.String("config", os.Getenv("AX_EXECUTION_CONFIG"), "configuration file path")
	once := flag.Bool("once", false, "claim at most one job")
	healthcheck := flag.Bool("healthcheck", false, "check the running controller on loopback")
	flag.Parse()
	if *healthcheck {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1:9092/healthz")
		if err != nil {
			return 1
		}
		defer response.Body.Close()
		io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
		if response.StatusCode != 200 {
			return 1
		}
		return 0
	}
	if flag.NArg() != 0 || *path == "" {
		report("config_required")
		return 2
	}
	config, err := settings.Load(*path)
	if err != nil {
		report("config_invalid")
		return 2
	}
	nativeConfig, err := config.Native()
	if err != nil || nativeConfig.DirectGuest == nil {
		report("native_config_invalid")
		return 2
	}
	adapter, err := native.Dial(nativeConfig)
	if err != nil {
		report("native_config_invalid")
		return 2
	}
	defer adapter.Close()
	dbConfig, err := config.DatabaseConfig()
	if err != nil {
		report("database_config_invalid")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := controller.OpenPostgres(ctx, dbConfig, config.ControllerID)
	if err != nil {
		report("database_unavailable")
		return 1
	}
	defer db.Close()
	runner := controller.New(db, adapter, config.Image)
	runner.ModelProvider, err = config.ModelProvider()
	if err != nil {
		report("model_gateway_config_invalid")
		return 2
	}
	interactiveConfig, err := config.InteractiveNative()
	if err != nil {
		report("interactive_config_invalid")
		return 2
	}
	if interactiveConfig != nil {
		interactive, err := native.Dial(*interactiveConfig)
		if err != nil {
			report("interactive_config_invalid")
			return 2
		}
		defer interactive.Close()
		runner.InteractiveExecutor = interactive
		runner.InteractiveImage = interactiveConfig.Image
		if config.Workbench != nil && config.Workbench.Enabled {
			runner.WorkbenchRuntime = interactive
			runner.WorkbenchRuntimeImage = interactiveConfig.Image
			runner.WorkbenchModelEnabled = config.Workbench.ModelEnabled && runner.ModelProvider != nil
			runner.WorkbenchPythonEnabled = config.Workbench.PythonEnabled
		}
	}
	codeConfig, err := config.CodeNative()
	if err != nil {
		report("workbench_config_invalid")
		return 2
	}
	if config.Workbench != nil && config.Workbench.Enabled && runner.WorkbenchRuntime == nil {
		report("workbench_config_invalid")
		return 2
	}
	if codeConfig != nil {
		code, err := native.Dial(*codeConfig)
		if err != nil {
			report("workbench_config_invalid")
			return 2
		}
		defer code.Close()
		runner.WorkbenchCode = code
		runner.WorkbenchCodeImage = codeConfig.Image
	}
	server := &http.Server{Addr: "127.0.0.1:9092", ReadHeaderTimeout: 2 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if adapter.Health(r.Context()) != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			io.WriteString(w, "{\"live\":false}\n")
			return
		}
		io.WriteString(w, "{\"live\":true}\n")
	})}
	defer server.Close()
	go func() {
		if server.ListenAndServe() != http.ErrServerClosed {
			stop()
		}
	}()
	report("controller_ready")
	for {
		worked, err := runner.RunOnce(ctx)
		if err != nil {
			report("execution_unconfirmed")
			return 1
		}
		if worked {
			report("job_processed")
		}
		if *once {
			return 0
		}
		select {
		case <-ctx.Done():
			return 0
		case <-time.After(time.Second):
		}
	}
}
