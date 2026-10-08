package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSkillStorageSecretsAndTransport(t *testing.T) {
	if reader, err := (File{}).SkillObjectReader(); reader != nil || err != nil {
		t.Fatal("optional storage should stay absent")
	}
	dir := t.TempDir()
	id, key := filepath.Join(dir, "id"), filepath.Join(dir, "key")
	if err := os.WriteFile(id, []byte("synthetic-id"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, []byte("synthetic-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &SkillStorageConfig{StoreID: "test-skills", Endpoint: "https://objects.example.test", Bucket: "app-skills", Region: "us-east-1", ForcePathStyle: true, AccessKeyIDPath: id, SecretAccessKeyPath: key}
	f := File{SkillStorage: s}
	if _, err := f.SkillObjectReader(); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(key, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := f.SkillObjectReader(); err == nil {
		t.Fatal("publicly readable credential accepted")
	}
	if err := os.Chmod(key, 0600); err != nil {
		t.Fatal(err)
	}
	s.Endpoint = "http://127.0.0.1:19000"
	if _, err := f.SkillObjectReader(); err == nil {
		t.Fatal("implicit cleartext accepted")
	}
	s.AllowInsecureHTTP = true
	if _, err := f.SkillObjectReader(); err != nil {
		t.Fatal(err)
	}
	s.Endpoint = "http://external.example.test"
	if _, err := f.SkillObjectReader(); err == nil {
		t.Fatal("external cleartext accepted")
	}
}
