package native

import (
	"context"
	"encoding/base64"
	"encoding/json"
)

func (a *Adapter) codeRPC(ctx context.Context, r WorkbenchRequest, op Operation, mutating bool) ([]byte, error) {
	if a.config.Atespace != "ax-code" || r.Adapter != "python" {
		return nil, invalid(op)
	}
	raw, _ := json.Marshal(struct {
		RunID            string `json:"run_id"`
		DescriptorSHA256 string `json:"descriptor_sha256"`
	}{r.RunID, r.DescriptorSHA256})
	return a.workbenchRPC(ctx, r.RunID, op, base64.StdEncoding.EncodeToString(raw), mutating)
}
func (a *Adapter) codeStateOp(ctx context.Context, r WorkbenchRequest, op Operation, state string) error {
	raw, e := a.codeRPC(ctx, r, op, true)
	if e != nil {
		return e
	}
	var ack struct {
		RunID string `json:"run_id"`
		State string `json:"state"`
	}
	if decodeStrict(raw, &ack) != nil || ack.RunID != r.RunID || ack.State != state {
		return failure(op, true, "invalid_runner_protocol")
	}
	return nil
}
func (a *Adapter) InputChunk(ctx context.Context, r WorkbenchRequest, f WorkbenchFile, index int, data []byte) error {
	if a.config.Atespace != "ax-code" || r.Adapter != "python" || index < 0 || len(data) != min(WorkbenchChunkBytes, f.SizeBytes-index*WorkbenchChunkBytes) || len(data) < 1 {
		return invalid("stage-chunk")
	}
	return a.workbenchAck(ctx, r.RunID, "stage-chunk", struct {
		RunID            string `json:"run_id"`
		DescriptorSHA256 string `json:"descriptor_sha256"`
		Alias            string `json:"alias"`
		Index            int    `json:"index"`
		ContentBase64    string `json:"content_base64"`
		SHA256           string `json:"sha256"`
	}{r.RunID, r.DescriptorSHA256, f.Alias, index, base64.StdEncoding.EncodeToString(data), HashBytes(data)}, "staged")
}
func (a *Adapter) OutputManifest(ctx context.Context, r WorkbenchRequest) (OutputManifest, error) {
	raw, e := a.codeRPC(ctx, r, "output-manifest", false)
	if e != nil {
		return OutputManifest{}, e
	}
	var m OutputManifest
	if decodeStrict(raw, &m) != nil {
		return m, errProtocol
	}
	return m, nil
}
func (a *Adapter) OutputChunk(ctx context.Context, r WorkbenchRequest, m OutputManifest, f OutputFile, index int) ([]byte, error) {
	if a.config.Atespace != "ax-code" || r.Adapter != "python" || index < 0 {
		return nil, invalid("output-chunk")
	}
	arg, _ := json.Marshal(struct {
		RunID          string `json:"run_id"`
		ManifestSHA256 string `json:"manifest_sha256"`
		Alias          string `json:"alias"`
		Index          int    `json:"index"`
	}{r.RunID, m.ManifestSHA256, f.Alias, index})
	raw, e := a.workbenchRPC(ctx, r.RunID, "output-chunk", base64.StdEncoding.EncodeToString(arg), false)
	if e != nil {
		return nil, e
	}
	var part struct {
		RunID         string `json:"run_id"`
		Alias         string `json:"alias"`
		Index         int    `json:"index"`
		ContentBase64 string `json:"content_base64"`
		SHA256        string `json:"sha256"`
	}
	if decodeStrict(raw, &part) != nil || part.RunID != r.RunID || part.Alias != f.Alias || part.Index != index {
		return nil, errProtocol
	}
	data, e := DecodeChunk(part.ContentBase64, min(WorkbenchChunkBytes, f.SizeBytes-index*WorkbenchChunkBytes))
	if e != nil || HashBytes(data) != part.SHA256 {
		return nil, errProtocol
	}
	return data, nil
}
