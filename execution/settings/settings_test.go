package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestModelGatewayIsExplicitAndClosedWithoutReadingCredentials(t *testing.T) {
	for _, source := range []string{`{}`, `{"model_gateway":{"enabled":false,"api_key_path":"/no-such-synthetic-key"}}`} {
		var config File
		if err := json.Unmarshal([]byte(source), &config); err != nil {
			t.Fatal(err)
		}
		provider, err := config.ModelProvider()
		if err != nil || provider != nil {
			t.Fatal("closed model gateway constructed provider", err)
		}
	}
	var config File
	if err := json.Unmarshal([]byte(`{"model_gateway":{"enabled":true,"api_key_path":""}}`), &config); err != nil {
		t.Fatal(err)
	}
	if _, err := config.ModelProvider(); err == nil {
		t.Fatal("enabled gateway accepted absent key path")
	}
}

func TestSecretsArePrivateUnlessTrustedGroupIsExplicit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := read(path, true, 100, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := read(path, true, 100, false); err == nil {
		t.Fatal("local group read accepted")
	}
	if _, err := read(path, true, 100, true); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []os.FileMode{0644, 0660, 0650} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		if _, err := read(path, true, 100, true); err == nil {
			t.Fatalf("unsafe mode %o accepted", mode)
		}
	}
}

func TestProjectedTokenReplacementIsObserved(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	endpoint, err := (Endpoint{BearerPath: path}).native(false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := endpoint.BearerToken()
	if err != nil || first != "first" {
		t.Fatal("initial token missing")
	}
	temporary := filepath.Join(dir, "replacement")
	if err := os.WriteFile(temporary, []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, path); err != nil {
		t.Fatal(err)
	}
	second, err := endpoint.BearerToken()
	if err != nil || second != "second" {
		t.Fatal("stale token cached")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := endpoint.BearerToken(); err == nil {
		t.Fatal("unsafe rotation accepted")
	}
}

func TestWorkbenchGatesDefaultClosed(t *testing.T) {
	f := File{}
	if c, e := f.CodeNative(); e != nil || c != nil {
		t.Fatal("absent gate configured code")
	}
	f.Workbench = &WorkbenchConfig{}
	if c, e := f.CodeNative(); e != nil || c != nil {
		t.Fatal("false gate configured code")
	}
	f.Workbench.PythonEnabled = true
	if _, e := f.CodeNative(); e == nil {
		t.Fatal("python enabled without explicit config")
	}
}
