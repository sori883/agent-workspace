package controller

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sori883/agent-workspace/execution/native"
)

func skillObjectFixture(t *testing.T) (native.WorkbenchSkillObject, map[string][]byte) {
	t.Helper()
	main := []byte("---\nname: \"sales-sum\"\ndescription: \"売上\"\n---\n\n集計する\n")
	files := []native.SkillObjectFile{{Path: "SKILL.md", SizeBytes: len(main), MediaType: "text/plain; charset=utf-8", SHA256: native.HashBytes(main)}, {Path: "references/empty.md", SizeBytes: 0, MediaType: "text/plain; charset=utf-8", SHA256: native.HashBytes(nil)}}
	m := skillObjectManifest{FormatVersion: 1, WorkspaceID: rootID, DefinitionID: rootID, RevisionID: rootID, Name: "sales-sum", Description: "売上", ContentSHA256: native.HashBytes([]byte("content")), Files: files}
	raw, err := native.CanonicalJSON(m)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "workspaces/" + rootID + "/skills/" + rootID + "/revisions/" + rootID + "/"
	o := native.WorkbenchSkillObject{ID: rootID, Name: m.Name, Description: m.Description, ContentSHA256: m.ContentSHA256, Files: files, LoadedPaths: []string{"SKILL.md", "references/empty.md"}, Source: native.SkillObjectSource{Type: "skill-object-v1", StoreID: "test-skills", RevisionID: rootID, ManifestKey: prefix + "manifest.json", ManifestSHA256: native.HashBytes(raw), ManifestBytes: len(raw), TotalBytes: len(raw) + len(main)}}
	return o, map[string][]byte{"/app-skills/" + prefix + "manifest.json": raw, "/app-skills/" + prefix + "SKILL.md": main, "/app-skills/" + prefix + "references/empty.md": {}}
}
func readerConfig(endpoint string, client *http.Client) S3SkillReaderConfig {
	return S3SkillReaderConfig{StoreID: "test-skills", Endpoint: endpoint, Bucket: "app-skills", Region: "us-east-1", ForcePathStyle: true, HTTPClient: client, Credentials: func(context.Context) (aws.Credentials, error) {
		return aws.Credentials{AccessKeyID: "fixture-key", SecretAccessKey: "fixture-secret"}, nil
	}}
}
func TestS3SkillReaderChecksSignatureMetadataAndSelectedBytes(t *testing.T) {
	object, objects := skillObjectFixture(t)
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") || r.Header.Get("X-Amz-Date") == "" || r.Header.Get("X-Amz-Content-Sha256") != native.HashBytes(nil) {
			t.Error("unsigned read")
		}
		data, ok := objects[r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Write(data)
	}))
	defer server.Close()
	reader, err := NewS3SkillReader(readerConfig(server.URL, server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	files, err := reader.ReadSkill(context.Background(), object)
	if err != nil || len(files) != 2 || calls != 3 || len(files["references/empty.md"]) != 0 {
		t.Fatal("valid object failed", err, calls)
	}
	object.LoadedPaths = []string{"SKILL.md"}
	calls = 0
	if _, err = reader.ReadSkill(context.Background(), object); err != nil || calls != 2 {
		t.Fatal("unselected file fetched", err, calls)
	}
	object.Source.StoreID = "other-store"
	calls = 0
	if _, err = reader.ReadSkill(context.Background(), object); err == nil || calls != 0 {
		t.Fatal("unconfigured store used")
	}
	object.Source.StoreID = "test-skills"
	object.Name = "wrong-name"
	if _, err = reader.ReadSkill(context.Background(), object); err == nil {
		t.Fatal("mismatched manifest accepted")
	}
	object.Name = "sales-sum"
	key := "/app-skills/" + native.SkillObjectPrefix(object.Source) + "SKILL.md"
	for _, bad := range [][]byte{[]byte("wrong"), append(append([]byte{}, objects[key]...), 'x'), bytesSameSize(objects[key])} {
		objects[key] = bad
		if _, err = reader.ReadSkill(context.Background(), object); err == nil {
			t.Fatal("wrong bytes accepted")
		}
	}
}
func bytesSameSize(value []byte) []byte { out := append([]byte{}, value...); out[0] ^= 1; return out }
func TestS3SkillReaderRejectsRedirectAndUnsafeEndpoint(t *testing.T) {
	object, _ := skillObjectFixture(t)
	sent := 0
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sent++; w.WriteHeader(200) }))
	defer target.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer server.Close()
	reader, err := NewS3SkillReader(readerConfig(server.URL, server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reader.ReadSkill(context.Background(), object); err == nil || sent != 0 {
		t.Fatal("redirect forwarded credentials")
	}
	for _, endpoint := range []string{"http://127.0.0.1:9000", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?x=1", "file:///etc/passwd"} {
		if _, err = NewS3SkillReader(readerConfig(endpoint, nil)); err == nil {
			t.Fatal("unsafe endpoint accepted", endpoint)
		}
	}
	config := readerConfig("http://127.0.0.1:9000", nil)
	config.AllowInsecureHTTP = true
	if _, err = NewS3SkillReader(config); err != nil {
		t.Fatal("explicit local HTTP rejected")
	}
	config.Endpoint = "http://untrusted.example:9000"
	if _, err = NewS3SkillReader(config); err == nil {
		t.Fatal("remote HTTP accepted")
	}
}

type objectStoreFixture struct {
	*workStore
	checks   int
	revokeAt int
}

func (s *objectStoreFixture) SkillObject(_ context.Context, _ *Claim, object native.WorkbenchSkillObject) (native.WorkbenchSkillObject, error) {
	s.checks++
	if s.checks == s.revokeAt {
		return object, ErrAuthorizationRevoked
	}
	return object, nil
}

type objectReaderFixture struct {
	files map[string][]byte
	err   error
	reads int
}

func (s *objectReaderFixture) ReadSkill(context.Context, native.WorkbenchSkillObject) (map[string][]byte, error) {
	s.reads++
	return s.files, s.err
}

type objectExecutorFixture struct {
	*workExecutor
	files map[string][]byte
}

func (e *objectExecutorFixture) SkillFileChunk(_ context.Context, _ native.WorkbenchRequest, _ native.WorkbenchSkillObject, f native.SkillObjectFile, b []byte) error {
	e.files[f.Path] = b
	return nil
}
func TestSkillStagingReauthorizesBeforeSendingAndFailsClosed(t *testing.T) {
	for _, failure := range []string{"", "revoked-before", "revoked-after", "corrupt", "unavailable"} {
		t.Run(failure, func(t *testing.T) {
			c, _, _ := setupWorkbench(t, false)
			store := &objectStoreFixture{workStore: c.Store.(*workStore)}
			claim := store.claim
			object, objects := skillObjectFixture(t)
			list := []native.WorkbenchSkillObject{object}
			claim.Workbench.Descriptor.SkillContext = &native.WorkbenchSkillContext{Version: 2, Catalog: []native.WorkbenchSkillSummary{}, LoadedSkills: []native.WorkbenchLoadedSkill{}, LoadedFiles: []native.WorkbenchLoadedSkillFile{}, BuiltinSkillIDs: []string{}, Objects: &list}
			files := map[string][]byte{"SKILL.md": objects["/app-skills/"+native.SkillObjectPrefix(object.Source)+"SKILL.md"], "references/empty.md": {}}
			reader := &objectReaderFixture{files: files}
			executor := &objectExecutorFixture{workExecutor: c.WorkbenchRuntime.(*workExecutor), files: map[string][]byte{}}
			c.Store = store
			c.SkillObjects = reader
			switch failure {
			case "revoked-before":
				store.revokeAt = 1
			case "revoked-after":
				store.revokeAt = 2
			case "corrupt":
				files["SKILL.md"] = []byte("changed")
			case "unavailable":
				reader.err = errors.New("skill_storage_unavailable")
			}
			err := c.stageSkillObjects(context.Background(), claim, executor)
			if failure == "" {
				if err != nil || store.checks != 2 || !reflect.DeepEqual(executor.files, files) {
					t.Fatal("staging failed", err)
				}
			} else if err == nil || len(executor.files) != 0 {
				t.Fatal("unsafe content sent", failure, err)
			}
			if failure == "revoked-before" && reader.reads != 0 {
				t.Fatal("read before authorization")
			}
		})
	}
}

type promptLimitExecutor struct{ *workExecutor }

func (e *promptLimitExecutor) MailboxWorkbench(context.Context, string) (*native.Mailbox, error) {
	return nil, nil
}
func (e *promptLimitExecutor) limitedResult() native.WorkbenchResult {
	code := "skill_context_too_large"
	zero := float64(0)
	return native.WorkbenchResult{SchemaVersion: 2, RunID: runID, Adapter: "interactive", Status: "failed", ExitCode: 1, ErrorType: &code, Usage: map[string]float64{"prompt_token_count": 0, "candidates_token_count": 0, "thoughts_token_count": 0, "total_token_count": 0, "model_call_count": 0}, EstimatedUSD: &zero}
}
func (e *promptLimitExecutor) StatusWorkbench(ctx context.Context, r native.WorkbenchRequest) (native.WorkbenchStatus, error) {
	if !e.started {
		return e.workExecutor.StatusWorkbench(ctx, r)
	}
	result := e.limitedResult()
	return native.WorkbenchStatus{RunID: r.RunID, State: "finished", Attempted: true, Result: &result}, nil
}
func (e *promptLimitExecutor) CollectWorkbench(_ context.Context, r native.WorkbenchRequest) (native.WorkbenchResult, error) {
	raw, _ := json.Marshal(map[string]any{"result": e.limitedResult(), "artifact_base64": nil})
	return native.ParseWorkbenchCollection(raw, r)
}
func TestPromptLimitResultHasNoModelOperationAndStillCleansUp(t *testing.T) {
	c, s, e := setupWorkbench(t, false)
	c.WorkbenchRuntime = &promptLimitExecutor{e}
	if worked, err := c.RunOnce(context.Background()); !worked || err != nil {
		t.Fatal("prompt denial did not finish", err)
	}
	if !s.finished || !s.collected || !e.stopped || len(s.saved) != 0 {
		t.Fatal("known zero-use rejection did not clean up")
	}
	r := s.claim.WorkbenchResult
	if r == nil || r.ErrorType == nil || *r.ErrorType != "skill_context_too_large" || r.EstimatedUSD == nil || *r.EstimatedUSD != 0 || r.Usage["model_call_count"] != 0 {
		t.Fatal("lost zero-use denial evidence")
	}
}
