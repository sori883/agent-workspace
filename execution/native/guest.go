package native

import (
	"context"

	guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha"
	"google.golang.org/protobuf/types/known/durationpb"
)

func (a *Adapter) runner(ctx context.Context, runID string, op Operation, argument string, mutating bool) ([]byte, error) {
	return a.runnerPath(ctx, runID, op, argument, mutating, "/opt/ax-task/runner.py", maxResponseBytes)
}
func (a *Adapter) runnerPath(ctx context.Context, runID string, op Operation, argument string, mutating bool, path string, limit int) ([]byte, error) {
	ctx, cancel := a.callContext(ctx, a.config.Guest, a.config.CallTimeout, runID)
	defer cancel()
	client, closeClient, err := a.guestClient(ctx, runID)
	if err != nil {
		return nil, failure(op, false, "guest_unavailable")
	}
	defer closeClient()
	process, err := client.StartProcess(ctx, &guestpb.StartProcessRequest{Command: []string{"python3", path, string(op), argument}, Timeout: durationpb.New(a.config.CallTimeout)})
	if err != nil {
		return nil, rpcFailure(op, mutating, err)
	}
	if process.GetProcessId() == "" {
		return nil, failure(op, mutating, "missing_process_id")
	}
	stream, err := client.StreamProcessOutput(ctx, &guestpb.StreamProcessOutputRequest{ProcessId: process.ProcessId, Follow: true})
	if err != nil {
		return nil, rpcFailure(op, mutating, err)
	}
	var output []byte
	stderrBytes := 0
	for {
		chunk, err := stream.Recv()
		if err != nil {
			return nil, failure(op, mutating, "incomplete_process_output")
		}
		switch value := chunk.GetOutput().(type) {
		case *guestpb.ProcessOutput_Stdout:
			if len(output)+len(value.Stdout) > limit {
				return nil, failure(op, mutating, "process_output_limit")
			}
			output = append(output, value.Stdout...)
		case *guestpb.ProcessOutput_Stderr:
			stderrBytes += len(value.Stderr)
			if stderrBytes > 8192 {
				return nil, failure(op, mutating, "process_output_limit")
			}
		case *guestpb.ProcessOutput_Exit:
			exit := value.Exit
			if exit.GetProcessId() != process.ProcessId || exit.GetState() != guestpb.ProcessState_PROCESS_STATE_EXITED || exit.GetExitCode() != 0 {
				return nil, failure(op, mutating, "process_failed")
			}
			return output, nil
		default:
			return nil, failure(op, mutating, "invalid_process_output")
		}
	}
}
