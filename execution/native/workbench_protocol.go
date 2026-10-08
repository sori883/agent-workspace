package native

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

const WorkbenchPolicy = "workbench-trial-2026-10-07-v1"
const CodeProfile = "host-quota-8m-v1"
const WorkbenchChunkBytes = 32768
const WorkbenchFileBytes = 8 * 1024 * 1024

var aliasPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var outputPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,58}\.(csv|xlsx)$`)

type WorkbenchRequest struct {
	SchemaVersion      int    `json:"schema_version"`
	RunID              string `json:"run_id"`
	RootID             string `json:"root_id"`
	Adapter            string `json:"adapter"`
	CheckpointRevision int    `json:"checkpoint_revision"`
	DescriptorSHA256   string `json:"descriptor_sha256"`
}
type DefinitionRef struct {
	ID        string `json:"id"`
	SHA256    string `json:"sha256"`
	SizeBytes int    `json:"size_bytes"`
	Kind      string `json:"kind"`
}
type WorkbenchFile struct {
	Alias     string `json:"alias"`
	FileID    string `json:"file_id"`
	Name      string `json:"name"`
	SizeBytes int    `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}
type WorkbenchOutput struct {
	Alias          string `json:"alias"`
	Name           string `json:"name"`
	SizeLimitBytes int    `json:"size_limit_bytes"`
}
type WorkbenchHistory struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type WorkbenchDescriptor struct {
	Version            int                    `json:"version"`
	RootID             string                 `json:"root_id"`
	Instruction        string                 `json:"instruction"`
	DefinitionManifest []DefinitionRef        `json:"definition_manifest"`
	CodeProfile        *string                `json:"code_profile"`
	Inputs             []WorkbenchFile        `json:"inputs"`
	Outputs            []WorkbenchOutput      `json:"outputs"`
	History            []WorkbenchHistory     `json:"history"`
	Code               *json.RawMessage       `json:"code"`
	SkillContext       *WorkbenchSkillContext `json:"skill_context,omitempty"`
}
type Workbench struct {
	Version         int                 `json:"version"`
	AttemptKind     string              `json:"attempt_kind"`
	ExecutionPolicy string              `json:"execution_policy"`
	Mode            string              `json:"mode"`
	ProfileID       string              `json:"profile_id"`
	RemainingMS     int                 `json:"remaining_ms"`
	Descriptor      WorkbenchDescriptor `json:"descriptor"`
}

func ParseWorkbenchRequest(data []byte) (WorkbenchRequest, error) {
	var r WorkbenchRequest
	if decodeStrict(data, &r) != nil || r.SchemaVersion != 2 || !runPattern.MatchString(r.RunID) || !uuidPattern.MatchString(r.RootID) || (r.Adapter != "interactive" && r.Adapter != "python") || r.CheckpointRevision < 0 || r.CheckpointRevision > 32 || !hashPattern.MatchString(r.DescriptorSHA256) {
		return r, errProtocol
	}
	return r, nil
}
func CanonicalJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var generic any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&generic) != nil {
		return nil, errProtocol
	}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(generic); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(out.Bytes(), []byte("\n"))
	result := make([]byte, 0, len(encoded))
	for i := 0; i < len(encoded); {
		if encoded[i] == '\\' && i+1 < len(encoded) {
			if i+6 <= len(encoded) && (string(encoded[i:i+6]) == `\u2028` || string(encoded[i:i+6]) == `\u2029`) {
				if encoded[i+5] == '8' {
					result = append(result, []byte("\u2028")...)
				} else {
					result = append(result, []byte("\u2029")...)
				}
				i += 6
			} else {
				result = append(result, encoded[i:i+2]...)
				i += 2
			}
		} else {
			result = append(result, encoded[i])
			i++
		}
	}
	return result, nil
}
func HashBytes(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func (w Workbench) Validate(r WorkbenchRequest) error {
	d := w.Descriptor
	raw, err := CanonicalJSON(d)
	if err != nil || len(raw) > 40*1024 || HashBytes(raw) != r.DescriptorSHA256 || w.Version != 2 || w.ExecutionPolicy != WorkbenchPolicy || w.RemainingMS < 0 || w.RemainingMS > 300000 || d.Version != 2 || d.RootID != r.RootID || !validText(d.Instruction) || strings.TrimSpace(d.Instruction) == "" || len(d.Instruction) > 2048 {
		return errProtocol
	}
	if w.Mode == "preview" && w.ProfileID != "preview-v1" || w.Mode == "model" && w.ProfileID != "gemini-3.1-flash-lite-standard-2026-10-07-v1" || w.Mode != "preview" && w.Mode != "model" {
		return errProtocol
	}
	if len(d.DefinitionManifest) > 9 || d.DefinitionManifest == nil || d.Inputs == nil || len(d.Inputs) > 16 || d.Outputs == nil || len(d.Outputs) > 4 || d.History == nil || len(d.History) > 17 {
		return errProtocol
	}
	seen := map[string]bool{}
	skills := 0
	for i, f := range d.DefinitionManifest {
		if !uuidPattern.MatchString(f.ID) || !hashPattern.MatchString(f.SHA256) || f.SizeBytes < 1 || f.SizeBytes > 128*1024 || seen[f.ID] || (f.Kind != "agent" && f.Kind != "skill") || (i > 0 && f.Kind == "agent") {
			return errProtocol
		}
		seen[f.ID] = true
		if f.Kind == "skill" {
			skills++
		}
	}
	if skills > 8 {
		return errProtocol
	}
	if d.SkillContext != nil && (w.AttemptKind != "runtime" || len(d.DefinitionManifest) != 0 || d.SkillContext.Validate() != nil) {
		return errProtocol
	}
	seen = map[string]bool{}
	total := 0
	for _, f := range d.Inputs {
		if !aliasPattern.MatchString(f.Alias) || !uuidPattern.MatchString(f.FileID) || seen[f.Alias] || seen[f.FileID] || !validFileName(f.Name) || f.SizeBytes < 1 || f.SizeBytes > WorkbenchFileBytes || !hashPattern.MatchString(f.SHA256) {
			return errProtocol
		}
		seen[f.Alias] = true
		seen[f.FileID] = true
		total += f.SizeBytes
	}
	if w.AttemptKind == "python" && (total > WorkbenchFileBytes || len(d.Inputs) > 4) {
		return errProtocol
	}
	total = 0
	seen = map[string]bool{}
	for _, f := range d.Outputs {
		if !aliasPattern.MatchString(f.Alias) || !outputPattern.MatchString(f.Name) || seen[f.Alias] || seen[f.Name] || f.SizeLimitBytes < 1 {
			return errProtocol
		}
		seen[f.Alias] = true
		seen[f.Name] = true
		total += f.SizeLimitBytes
	}
	if total > WorkbenchFileBytes {
		return errProtocol
	}
	for _, h := range d.History {
		if !validText(h.Text) || len(h.Text) > 8192 || !identifierPattern.MatchString(h.Kind) {
			return errProtocol
		}
	}
	history, err := CanonicalJSON(d.History)
	if err != nil || len(history) > 16*1024 {
		return errProtocol
	}
	if w.AttemptKind == "runtime" {
		if r.Adapter != "interactive" || d.CodeProfile != nil || d.Code != nil || len(d.Outputs) != 0 {
			return errProtocol
		}
	} else if w.AttemptKind == "python" {
		if r.Adapter != "python" || d.CodeProfile == nil || *d.CodeProfile != CodeProfile || len(d.Outputs) < 1 {
			return errProtocol
		}
		if d.Code == nil {
			return errProtocol
		}
		p, e := ParseWorkbenchProposal(*d.Code)
		if e != nil || p.Kind != "python" || len(p.InputAliases) != len(d.Inputs) || len(p.Outputs) != len(d.Outputs) {
			return errProtocol
		}
		aliases := map[string]bool{}
		for _, f := range d.Inputs {
			aliases[f.Alias] = true
		}
		for _, alias := range p.InputAliases {
			if !aliases[alias] {
				return errProtocol
			}
		}
		for i, f := range d.Outputs {
			if p.Outputs[i].Name != f.Name || p.Outputs[i].SizeLimitBytes != f.SizeLimitBytes {
				return errProtocol
			}
		}
	} else {
		return errProtocol
	}
	return nil
}

type PythonOutput struct {
	Name           string `json:"name"`
	SizeLimitBytes int    `json:"size_limit_bytes"`
}
type WorkbenchProposal struct {
	Kind         string
	Text         string
	Source       string
	InputAliases []string
	Outputs      []PythonOutput
	Purpose      string
	SkillIDs     []string
	SkillID      string
	Path         string
}

func ParseWorkbenchProposal(data []byte) (WorkbenchProposal, error) {
	var fields map[string]json.RawMessage
	if decodeStrict(data, &fields) != nil {
		return WorkbenchProposal{}, errProtocol
	}
	var kind string
	if json.Unmarshal(fields["kind"], &kind) != nil {
		return WorkbenchProposal{}, errProtocol
	}
	if kind == "read_skills" {
		var wire struct {
			Kind     string   `json:"kind"`
			SkillIDs []string `json:"skill_ids"`
		}
		if decodeStrict(data, &wire) != nil || len(wire.SkillIDs) < 1 || len(wire.SkillIDs) > 8 {
			return WorkbenchProposal{}, errProtocol
		}
		seen := map[string]bool{}
		for _, id := range wire.SkillIDs {
			if (!uuidPattern.MatchString(id) && id != "general-v1" && id != "tabular-v1") || seen[id] {
				return WorkbenchProposal{}, errProtocol
			}
			seen[id] = true
		}
		return WorkbenchProposal{Kind: kind, SkillIDs: wire.SkillIDs}, nil
	}
	if kind == "read_skill_file" {
		var wire struct {
			Kind    string `json:"kind"`
			SkillID string `json:"skill_id"`
			Path    string `json:"path"`
		}
		if decodeStrict(data, &wire) != nil || !uuidPattern.MatchString(wire.SkillID) || !validSkillPath(wire.Path) {
			return WorkbenchProposal{}, errProtocol
		}
		return WorkbenchProposal{Kind: kind, SkillID: wire.SkillID, Path: wire.Path}, nil
	}
	if kind != "python" {
		p, e := ParseProposal(data)
		return WorkbenchProposal{Kind: p.Kind, Text: p.Text}, e
	}
	var wire struct {
		Kind         string         `json:"kind"`
		Source       string         `json:"source"`
		InputAliases []string       `json:"input_aliases"`
		Outputs      []PythonOutput `json:"outputs"`
		Purpose      string         `json:"purpose"`
	}
	if decodeStrict(data, &wire) != nil || !validText(wire.Source) || len(wire.Source) > 4096 || strings.TrimSpace(wire.Source) == "" || !validText(wire.Purpose) || len(wire.Purpose) > 2048 || strings.TrimSpace(wire.Purpose) == "" || wire.InputAliases == nil || len(wire.InputAliases) > 4 || len(wire.Outputs) < 1 || len(wire.Outputs) > 4 {
		return WorkbenchProposal{}, errProtocol
	}
	seen := map[string]bool{}
	for _, a := range wire.InputAliases {
		if !aliasPattern.MatchString(a) || seen[a] {
			return WorkbenchProposal{}, errProtocol
		}
		seen[a] = true
	}
	total := 0
	seen = map[string]bool{}
	for _, o := range wire.Outputs {
		if !outputPattern.MatchString(o.Name) || seen[o.Name] || o.SizeLimitBytes < 1 {
			return WorkbenchProposal{}, errProtocol
		}
		seen[o.Name] = true
		total += o.SizeLimitBytes
	}
	if total > WorkbenchFileBytes {
		return WorkbenchProposal{}, errProtocol
	}
	return WorkbenchProposal{Kind: kind, Source: wire.Source, InputAliases: wire.InputAliases, Outputs: wire.Outputs, Purpose: wire.Purpose}, nil
}

type WorkbenchResult struct {
	SchemaVersion int                `json:"schema_version"`
	RunID         string             `json:"run_id"`
	Adapter       string             `json:"adapter"`
	Status        string             `json:"status"`
	ExitCode      int                `json:"exit_code"`
	ErrorType     *string            `json:"error_type"`
	Summary       string             `json:"summary"`
	Usage         map[string]float64 `json:"usage"`
	EstimatedUSD  *float64           `json:"estimated_usd"`
}

func (r WorkbenchResult) Validate(request WorkbenchRequest) error {
	if r.SchemaVersion != 2 || r.RunID != request.RunID || r.Adapter != request.Adapter || !validText(r.Summary) || len(r.Summary) > 8192 || r.ErrorType != nil && !identifierPattern.MatchString(*r.ErrorType) || r.EstimatedUSD != nil && !nonnegative(*r.EstimatedUSD) {
		return errProtocol
	}
	if r.Status != "succeeded" && r.Status != "failed" && r.Status != "timed_out" {
		return errProtocol
	}
	if r.Status == "succeeded" {
		if r.ExitCode != 0 || r.ErrorType != nil || r.Usage == nil || r.EstimatedUSD == nil {
			return errProtocol
		}
	} else if r.ExitCode == 0 {
		return errProtocol
	}
	if r.Usage != nil {
		if len(r.Usage) != 5 {
			return errProtocol
		}
		for _, k := range []string{"prompt_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count", "model_call_count"} {
			v, ok := r.Usage[k]
			if !ok || !nonnegative(v) || v > 1000000 || v != float64(int(v)) {
				return errProtocol
			}
		}
	}
	return nil
}

type WorkbenchStatus struct {
	RunID     string           `json:"run_id"`
	State     string           `json:"state"`
	Attempted bool             `json:"attempted"`
	Result    *WorkbenchResult `json:"result"`
}

func ParseWorkbenchStatus(data []byte, r WorkbenchRequest) (WorkbenchStatus, error) {
	var s WorkbenchStatus
	if decodeStrict(data, &s) != nil || s.RunID != r.RunID {
		return s, errProtocol
	}
	switch s.State {
	case "waiting", "staged", "started":
		if s.Attempted || s.Result != nil {
			return s, errProtocol
		}
	case "running":
		if !s.Attempted || s.Result != nil {
			return s, errProtocol
		}
	case "finished":
		if !s.Attempted || s.Result == nil || s.Result.Validate(r) != nil {
			return s, errProtocol
		}
	default:
		return s, errProtocol
	}
	return s, nil
}
func ParseWorkbenchCollection(data []byte, r WorkbenchRequest) (WorkbenchResult, error) {
	var w struct {
		Result         WorkbenchResult `json:"result"`
		ArtifactBase64 *string         `json:"artifact_base64"`
	}
	if decodeStrict(data, &w) != nil || w.ArtifactBase64 != nil || w.Result.Validate(r) != nil {
		return w.Result, errProtocol
	}
	return w.Result, nil
}
func DecodeChunk(value string, size int) ([]byte, error) {
	if len(value) > base64.StdEncoding.EncodedLen(WorkbenchChunkBytes) || strings.ContainsAny(value, "\r\n") {
		return nil, errProtocol
	}
	b, e := base64.StdEncoding.Strict().DecodeString(value)
	if e != nil || len(b) != size || size < 1 || size > WorkbenchChunkBytes || base64.StdEncoding.EncodeToString(b) != value {
		return nil, errProtocol
	}
	return b, nil
}

type TaskManifest struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name     string `json:"name"`
		Atespace string `json:"atespace"`
	} `json:"metadata"`
	Spec struct {
		Image   string   `json:"image"`
		Command []string `json:"command"`
		Debug   bool     `json:"debug"`
	} `json:"spec"`
}

func (m TaskManifest) Validate(r WorkbenchRequest, image string) error {
	space, path := "ax-runtime", "/opt/ax-task/runner.py"
	if r.Adapter == "python" {
		space, path = "ax-code", "/opt/ax-code/runner.py"
	}
	if m.APIVersion != "ax.io/v1alpha1" || m.Kind != "Task" || m.Metadata.Name != r.RunID || m.Metadata.Atespace != space || m.Spec.Image != image || !imagePattern.MatchString(image) || !m.Spec.Debug || len(m.Spec.Command) != 3 || m.Spec.Command[0] != "python3" || m.Spec.Command[1] != path || m.Spec.Command[2] != "wait" {
		return errProtocol
	}
	return nil
}

type DefinitionChunk struct {
	VersionID     string `json:"version_id"`
	Kind          string `json:"kind"`
	SHA256        string `json:"sha256"`
	SizeBytes     int    `json:"size_bytes"`
	ChunkCount    int    `json:"chunk_count"`
	Index         int    `json:"index"`
	ContentBase64 string `json:"content_base64"`
}
type CodeCleanup struct {
	Actor      string `json:"actor"`
	ActorUID   string `json:"actor_uid"`
	WorkerUID  string `json:"worker_uid"`
	Generation string `json:"generation"`
	Image      string `json:"image"`
	Profile    string `json:"profile"`
	Cleaned    bool   `json:"cleaned"`
}

func (p CodeCleanup) Validate(run, image string) error {
	uid := regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	if p.Actor != run || !uid.MatchString(p.ActorUID) || !uid.MatchString(p.WorkerUID) || !uuidPattern.MatchString(p.Generation) || p.Image != image || p.Profile != CodeProfile || !p.Cleaned {
		return errProtocol
	}
	return nil
}

func validFileName(n string) bool {
	if !validText(n) || len(n) > 255 || len(n) < 5 || strings.TrimSpace(n) != n || strings.ContainsAny(n, "/\\") {
		return false
	}
	for _, r := range n {
		if r < 32 || r == 127 {
			return false
		}
	}
	lower := strings.ToLower(n)
	return strings.HasSuffix(lower, ".csv") || strings.HasSuffix(lower, ".xlsx")
}
