package controller

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

func claimAgent(c *Claim) gateway.Agent {
	if c.Workbench != nil {
		return gateway.Agent{Mode: c.Workbench.Mode, ProfileID: c.Workbench.ProfileID}
	}
	if c.Agent != nil {
		return *c.Agent
	}
	return gateway.Agent{}
}
func outputLimit(c *Claim) int {
	if c.Workbench != nil {
		return 512
	}
	return 256
}

type WorkbenchStore interface {
	AgentStore
	DefinitionChunk(context.Context, *Claim, native.DefinitionRef, int) (native.DefinitionChunk, error)
	InputChunk(context.Context, *Claim, native.WorkbenchFile, int) ([]byte, error)
	CollectWorkbench(context.Context, *Claim, native.WorkbenchResult) error
	OutputBegin(context.Context, *Claim, string, int, string) error
	OutputChunk(context.Context, *Claim, string, int, []byte) error
	OutputSeal(context.Context, *Claim, string) error
	CodeCleanup(context.Context, *Claim, native.CodeCleanup) error
}

func (p *Postgres) DefinitionChunk(ctx context.Context, c *Claim, f native.DefinitionRef, index int) (native.DefinitionChunk, error) {
	var raw []byte
	var part native.DefinitionChunk
	if err := p.pool.QueryRow(ctx, p.query("ax_workbench_definition_chunk")+"($1,$2,$3,$4,$5)", c.RunID, c.Generation, p.controllerID, f.ID, index).Scan(&raw); err != nil {
		return part, classifyIntentError(err)
	}
	if native.DecodeStrict(raw, &part) != nil || part.VersionID != f.ID || part.Kind != f.Kind || part.SHA256 != f.SHA256 || part.SizeBytes != f.SizeBytes || part.Index != index || part.ChunkCount != (f.SizeBytes+native.WorkbenchChunkBytes-1)/native.WorkbenchChunkBytes {
		return part, errors.New("invalid_definition_chunk")
	}
	if _, err := native.DecodeChunk(part.ContentBase64, min(native.WorkbenchChunkBytes, f.SizeBytes-index*native.WorkbenchChunkBytes)); err != nil {
		return part, err
	}
	return part, nil
}
func (p *Postgres) InputChunk(ctx context.Context, c *Claim, f native.WorkbenchFile, index int) ([]byte, error) {
	var value string
	if err := p.pool.QueryRow(ctx, p.query("ax_workbench_read_chunk")+"($1,$2,$3,$4,$5)", c.RunID, c.Generation, p.controllerID, f.FileID, index).Scan(&value); err != nil {
		return nil, classifyIntentError(err)
	}
	if len(value) > native.WorkbenchChunkBytes*2 {
		return nil, errors.New("invalid_file_chunk")
	}
	b, e := hex.DecodeString(value)
	if e != nil || len(b) != min(native.WorkbenchChunkBytes, f.SizeBytes-index*native.WorkbenchChunkBytes) {
		return nil, errors.New("invalid_file_chunk")
	}
	return b, nil
}
func (p *Postgres) CollectWorkbench(ctx context.Context, c *Claim, r native.WorkbenchResult) error {
	if c.WorkbenchRequest == nil || r.Validate(*c.WorkbenchRequest) != nil {
		return errors.New("invalid_runner_result")
	}
	raw, e := json.Marshal(r)
	if e != nil {
		return e
	}
	return p.exec(ctx, "ax_collect", "($1,$2,$3,$4::jsonb,$5::bytea)", c.RunID, c.Generation, p.controllerID, string(raw), nil)
}
func (p *Postgres) OutputBegin(ctx context.Context, c *Claim, alias string, size int, hash string) error {
	return p.outputMutation(ctx, c, "ax_workbench_output_begin", "($1,$2,$3,$4,$5,$6)", alias, size, hash)
}
func (p *Postgres) OutputChunk(ctx context.Context, c *Claim, alias string, index int, data []byte) error {
	return p.outputMutation(ctx, c, "ax_workbench_output_chunk", "($1,$2,$3,$4,$5,$6::bytea)", alias, index, data)
}
func (p *Postgres) OutputSeal(ctx context.Context, c *Claim, alias string) error {
	return p.outputMutation(ctx, c, "ax_workbench_output_seal", "($1,$2,$3,$4)", alias)
}
func (p *Postgres) outputMutation(ctx context.Context, c *Claim, name, args string, values ...any) error {
	var raw []byte
	params := append([]any{c.RunID, c.Generation, p.controllerID}, values...)
	if e := p.pool.QueryRow(ctx, p.query(name)+args, params...).Scan(&raw); e != nil {
		return errors.New("output_import_unconfirmed")
	}
	if name == "ax_workbench_output_chunk" {
		var result struct {
			OK       bool `json:"ok"`
			Replayed bool `json:"replayed"`
		}
		if native.DecodeStrict(raw, &result) != nil || !result.OK {
			return errors.New("output_import_unconfirmed")
		}
	} else {
		var result struct {
			FileID   string `json:"file_id"`
			Replayed bool   `json:"replayed"`
		}
		if native.DecodeStrict(raw, &result) != nil || len(result.FileID) != 36 {
			return errors.New("output_import_unconfirmed")
		}
	}
	return nil
}
func (p *Postgres) CodeCleanup(ctx context.Context, c *Claim, proof native.CodeCleanup) error {
	if proof.Validate(c.RunID, c.Image) != nil {
		return errors.New("invalid_code_cleanup")
	}
	raw, e := json.Marshal(proof)
	if e != nil {
		return e
	}
	return p.exec(ctx, "ax_workbench_cleanup", "($1,$2,$3,$4::jsonb)", c.RunID, c.Generation, p.controllerID, string(raw))
}
