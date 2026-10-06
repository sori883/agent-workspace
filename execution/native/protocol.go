package native

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

const MaxArtifactBytes = 65536
const maxResponseBytes = 128 * 1024

var runPattern = regexp.MustCompile(`^ax-run-[0-9a-f]{16}$`)
var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
var identifierPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,95}$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var errProtocol = errors.New("invalid_runner_protocol")

type Request struct {
	SchemaVersion int               `json:"schema_version"`
	RunID         string            `json:"run_id"`
	Adapter       string            `json:"adapter"`
	Instruction   string            `json:"instruction"`
	Inputs        map[string]string `json:"inputs"`
	OutputName    string            `json:"output_name"`
}

func (r Request) Validate() error {
	if r.SchemaVersion != 1 || !runPattern.MatchString(r.RunID) || (r.Adapter != "offline" && r.Adapter != "antigravity") || !namePattern.MatchString(r.OutputName) || r.Inputs == nil || len(r.Inputs) > 4 {
		return errProtocol
	}
	if !validText(r.Instruction) || len(r.Instruction) > 2048 || strings.TrimSpace(r.Instruction) == "" {
		return errProtocol
	}
	total := 0
	for name, value := range r.Inputs {
		if !namePattern.MatchString(name) || !validText(value) {
			return errProtocol
		}
		total += len(value)
	}
	if total > 4096 {
		return errProtocol
	}
	return nil
}

func ParseRequest(data []byte) (Request, error) {
	var r Request
	if len(data) > 49152 || decodeStrict(data, &r) != nil || r.Validate() != nil {
		return Request{}, errProtocol
	}
	return r, nil
}

func validText(s string) bool { return utf8.ValidString(s) && !strings.ContainsRune(s, 0) }

type Artifact struct {
	Name      string `json:"name"`
	SizeBytes int    `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}

type Result struct {
	SchemaVersion int                `json:"schema_version"`
	RunID         string             `json:"run_id"`
	Adapter       string             `json:"adapter"`
	Status        string             `json:"status"`
	ExitCode      int                `json:"exit_code"`
	StopReason    *string            `json:"stop_reason"`
	Usage         map[string]float64 `json:"usage"`
	EstimatedUSD  *float64           `json:"estimated_usd"`
	ErrorType     *string            `json:"error_type"`
	Artifact      *Artifact          `json:"artifact"`
}

func (r Result) Validate(request Request) error {
	if request.Validate() != nil || r.SchemaVersion != 1 || r.RunID != request.RunID || r.Adapter != request.Adapter {
		return errProtocol
	}
	if r.Status != "succeeded" && r.Status != "failed" && r.Status != "timed_out" {
		return errProtocol
	}
	for _, value := range []*string{r.StopReason, r.ErrorType} {
		if value != nil && !identifierPattern.MatchString(*value) {
			return errProtocol
		}
	}
	if r.Usage != nil {
		if len(r.Usage) == 0 {
			return errProtocol
		}
		for key, value := range r.Usage {
			if !identifierPattern.MatchString(key) || !nonnegative(value) {
				return errProtocol
			}
		}
	}
	if r.EstimatedUSD != nil && !nonnegative(*r.EstimatedUSD) {
		return errProtocol
	}
	if r.Artifact != nil && (r.Artifact.Name != request.OutputName || !namePattern.MatchString(r.Artifact.Name) || r.Artifact.SizeBytes < 0 || r.Artifact.SizeBytes > MaxArtifactBytes || !hashPattern.MatchString(r.Artifact.SHA256)) {
		return errProtocol
	}
	if r.Status != "succeeded" {
		if r.ExitCode == 0 {
			return errProtocol
		}
		return nil
	}
	if r.ExitCode != 0 || r.ErrorType != nil || r.Usage == nil || r.EstimatedUSD == nil || r.Artifact == nil || r.StopReason == nil {
		return errProtocol
	}
	if r.Adapter == "offline" {
		if *r.StopReason != "OFFLINE" || *r.EstimatedUSD != 0 {
			return errProtocol
		}
		for _, value := range r.Usage {
			if value != 0 {
				return errProtocol
			}
		}
	} else if *r.StopReason != "UNSPECIFIED" || r.Usage["prompt_token_count"] <= 0 || r.Usage["total_token_count"] <= 0 {
		return errProtocol
	}
	return nil
}

func nonnegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

type RunnerStatus struct {
	RunID     string  `json:"run_id"`
	State     string  `json:"state"`
	Attempted bool    `json:"attempted"`
	Result    *Result `json:"result"`
}

func parseStatus(data []byte, request Request) (RunnerStatus, error) {
	var result RunnerStatus
	if decodeStrict(data, &result) != nil || result.RunID != request.RunID {
		return RunnerStatus{}, errProtocol
	}
	switch result.State {
	case "waiting", "staged", "started":
		if result.Attempted || result.Result != nil {
			return RunnerStatus{}, errProtocol
		}
	case "running":
		if !result.Attempted || result.Result != nil {
			return RunnerStatus{}, errProtocol
		}
	case "finished":
		if !result.Attempted || result.Result == nil || result.Result.Validate(request) != nil {
			return RunnerStatus{}, errProtocol
		}
	default:
		return RunnerStatus{}, errProtocol
	}
	return result, nil
}

type Collection struct {
	Result Result
	Bytes  []byte
}

func parseCollection(data []byte, request Request) (Collection, error) {
	var wire struct {
		Result         Result  `json:"result"`
		ArtifactBase64 *string `json:"artifact_base64"`
	}
	if decodeStrict(data, &wire) != nil || wire.Result.Validate(request) != nil {
		return Collection{}, errProtocol
	}
	if wire.Result.Artifact == nil {
		if wire.ArtifactBase64 != nil {
			return Collection{}, errProtocol
		}
		return Collection{Result: wire.Result}, nil
	}
	if wire.ArtifactBase64 == nil || len(*wire.ArtifactBase64) > base64.StdEncoding.EncodedLen(MaxArtifactBytes) || strings.ContainsAny(*wire.ArtifactBase64, "\r\n") {
		return Collection{}, errProtocol
	}
	content, err := base64.StdEncoding.Strict().DecodeString(*wire.ArtifactBase64)
	if err != nil || len(content) != wire.Result.Artifact.SizeBytes {
		return Collection{}, errProtocol
	}
	hash := sha256.Sum256(content)
	if hex.EncodeToString(hash[:]) != wire.Result.Artifact.SHA256 {
		return Collection{}, errProtocol
	}
	return Collection{Result: wire.Result, Bytes: content}, nil
}

func decodeStrict(data []byte, target any) error {
	if len(data) > maxResponseBytes || !utf8.Valid(data) || !validEscapes(data) {
		return errProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if scanJSON(decoder, 0) != nil {
		return errProtocol
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errProtocol
	}
	if checkShape(data, reflect.TypeOf(target).Elem()) != nil {
		return errProtocol
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return errProtocol
	}
	return nil
}

func validEscapes(data []byte) bool {
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		value, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value >= 0xd800 && value <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func checkShape(data []byte, kind reflect.Type) error {
	if kind.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			return nil
		}
		return checkShape(data, kind.Elem())
	}
	if kind.Kind() == reflect.Map && bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errProtocol
	}
	if kind.Kind() == reflect.Map {
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil {
			return errProtocol
		}
		for _, value := range fields {
			if checkShape(value, kind.Elem()) != nil {
				return errProtocol
			}
		}
	}
	if kind.Kind() != reflect.Struct {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) != kind.NumField() {
		return errProtocol
	}
	for i := 0; i < kind.NumField(); i++ {
		field := kind.Field(i)
		value, exists := fields[field.Tag.Get("json")]
		if !exists || checkShape(value, field.Type) != nil {
			return errProtocol
		}
	}
	return nil
}

func scanJSON(decoder *json.Decoder, depth int) error {
	if depth > 12 {
		return errProtocol
	}
	token, err := decoder.Token()
	if err != nil {
		return errProtocol
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if delim != '{' && delim != '[' {
		return errProtocol
	}
	seen := map[string]bool{}
	for decoder.More() {
		if delim == '{' {
			key, err := decoder.Token()
			if err != nil {
				return errProtocol
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return errProtocol
			}
			seen[name] = true
		}
		if scanJSON(decoder, depth+1) != nil {
			return errProtocol
		}
	}
	_, err = decoder.Token()
	return err
}
