package settings

import (
	"os"
	"path/filepath"
	"testing"
)

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
