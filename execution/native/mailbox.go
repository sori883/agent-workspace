package native

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

const MaxMailboxBytes = 65536

type Runtime struct {
	Version     int     `json:"version"`
	RootID      string  `json:"root_id"`
	Phase       string  `json:"phase"`
	QuestionID  *string `json:"question_id"`
	SkillID     string  `json:"skill_id"`
	RemainingMS int     `json:"remaining_ms"`
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (r Request) Runtime() (Runtime, error) {
	var result Runtime
	if r.Adapter != "interactive" || r.OutputName != "reply.txt" || len(r.Inputs) != 2 || r.Inputs["conversation.json"] == "" || decodeStrict([]byte(r.Inputs["runtime.json"]), &result) != nil || result.Version != 1 || !uuidPattern.MatchString(result.RootID) || result.SkillID != "brief-v1" || result.RemainingMS < 1 || result.RemainingMS > 90000 {
		return Runtime{}, errProtocol
	}
	if result.Phase == "request" && result.QuestionID == nil || result.Phase == "answer" && result.QuestionID != nil && *result.QuestionID == result.RootID {
		return result, nil
	}
	return Runtime{}, errProtocol
}

type MailboxRequest struct {
	Version  int                        `json:"version"`
	RunID    string                     `json:"run_id"`
	Sequence int                        `json:"sequence"`
	Kind     string                     `json:"kind"`
	Body     map[string]json.RawMessage `json:"body"`
}
type Mailbox struct {
	Request MailboxRequest
	Bytes   []byte
	SHA256  string
}
type MailboxReply struct {
	Version       int                        `json:"version"`
	RunID         string                     `json:"run_id"`
	Sequence      int                        `json:"sequence"`
	RequestSHA256 string                     `json:"request_sha256"`
	Status        string                     `json:"status"`
	Body          map[string]json.RawMessage `json:"body"`
}
type Proposal struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func ParseProposal(data []byte) (Proposal, error) {
	var p Proposal
	if decodeStrict(data, &p) != nil || (p.Kind != "question" && p.Kind != "output" && p.Kind != "unsupported") || !validText(p.Text) || strings.TrimSpace(p.Text) == "" || len(p.Text) > 2048 {
		return Proposal{}, errProtocol
	}
	return p, nil
}
func ParseMailbox(data []byte, runID string) (*Mailbox, error) {
	return parseMailboxVersion(data, runID, 1)
}
func ParseWorkbenchMailbox(data []byte, runID string) (*Mailbox, error) {
	return parseMailboxVersion(data, runID, 2)
}
func parseMailboxVersion(data []byte, runID string, version int) (*Mailbox, error) {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, nil
	}
	var envelope struct {
		RequestBase64 string `json:"request_base64"`
		SHA256        string `json:"sha256"`
	}
	if decodeStrict(data, &envelope) != nil || !hashPattern.MatchString(envelope.SHA256) {
		return nil, errProtocol
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(envelope.RequestBase64)
	if err != nil || len(raw) > MaxMailboxBytes {
		return nil, errProtocol
	}
	hash := sha256.Sum256(raw)
	var request MailboxRequest
	if hex.EncodeToString(hash[:]) != envelope.SHA256 || decodeStrict(raw, &request) != nil || request.Version != version || request.RunID != runID || !runPattern.MatchString(runID) || request.Body == nil || !(request.Sequence == 1 && request.Kind == "model" || request.Sequence == 2 && request.Kind == "tool") {
		return nil, errProtocol
	}
	if request.Kind == "tool" {
		body, _ := json.Marshal(request.Body)
		if version == 1 {
			if _, err := ParseProposal(body); err != nil {
				return nil, err
			}
		} else {
			if _, err := ParseWorkbenchProposal(body); err != nil {
				return nil, err
			}
		}
	}
	return &Mailbox{Request: request, Bytes: raw, SHA256: envelope.SHA256}, nil
}
func ParseReply(data []byte, mailbox *Mailbox) (MailboxReply, error) {
	var r MailboxReply
	if mailbox == nil || len(data) > MaxMailboxBytes || decodeStrict(data, &r) != nil || (r.Version != 1 && r.Version != 2) || r.Version != mailbox.Request.Version || r.RunID != mailbox.Request.RunID || r.Sequence != mailbox.Request.Sequence || r.RequestSHA256 != mailbox.SHA256 || (r.Status != "ok" && r.Status != "denied") || r.Body == nil {
		return MailboxReply{}, errProtocol
	}
	return r, nil
}
func (a *Adapter) Mailbox(ctx context.Context, runID string) (*Mailbox, error) {
	if a.config.Atespace != "ax-runtime" || !runPattern.MatchString(runID) {
		return nil, invalid("mailbox")
	}
	output, err := a.runner(ctx, runID, "mailbox", runID, false)
	if err != nil {
		return nil, err
	}
	result, err := ParseMailbox(output, runID)
	if err != nil {
		return nil, failure("mailbox", false, "invalid_runner_protocol")
	}
	return result, nil
}
func (a *Adapter) Reply(ctx context.Context, mailbox *Mailbox, data []byte) error {
	if a.config.Atespace != "ax-runtime" {
		return invalid("reply")
	}
	reply, err := ParseReply(data, mailbox)
	if err != nil {
		return invalid("reply")
	}
	output, err := a.runner(ctx, reply.RunID, "reply", base64.StdEncoding.EncodeToString(data), true)
	if err != nil {
		return err
	}
	var ack struct {
		RunID    string `json:"run_id"`
		Sequence int    `json:"sequence"`
		State    string `json:"state"`
	}
	if decodeStrict(output, &ack) != nil || ack.RunID != reply.RunID || ack.Sequence != reply.Sequence || ack.State != "replied" {
		return failure("reply", true, "invalid_runner_protocol")
	}
	return nil
}
