package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sori883/agent-workspace/execution/settings"
)

func TestInteractiveSelectionRequiresExplicitConfiguration(t *testing.T) {
	config := settings.File{Atespace: "ax-demo", Image: "legacy-image"}
	legacy, err := inspectConfig(config, false)
	if err != nil || legacy.Atespace != "ax-demo" || legacy.Image != "legacy-image" {
		t.Fatal("default inspection changed")
	}
	if _, err := inspectConfig(config, true); err == nil {
		t.Fatal("interactive inspection fell back to legacy configuration")
	}
}

func TestInteractiveSelectionUsesPinnedIdentityAndImage(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, public, private)
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	bundle := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})...)
	path := filepath.Join(t.TempDir(), "fixture.pem")
	if err := os.WriteFile(path, bundle, 0600); err != nil {
		t.Fatal(err)
	}
	var config settings.File
	if err := json.Unmarshal([]byte(`{"atespace":"ax-demo","image":"legacy-image","allowed_hosts":["generativelanguage.googleapis.com"],"direct_guest":{"server_identity":"spiffe://cluster.local/ns/ax-demo/sa/default"},"interactive":{"atespace":"ax-runtime","image":"interactive-image","guest_identity":"spiffe://cluster.local/ns/ax-demo/sa/default"}}`), &config); err != nil {
		t.Fatal(err)
	}
	config.DirectGuest.CAPath, config.DirectGuest.ClientBundlePath = path, path
	selected, err := inspectConfig(config, true)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Atespace != "ax-runtime" || selected.Image != "interactive-image" || selected.DirectGuest.ServerIdentity != "spiffe://cluster.local/ns/ax-demo/sa/default" || len(selected.AllowedHosts) != 0 {
		t.Fatal("interactive identity or image was not selected")
	}
	if config.Atespace != "ax-demo" || config.DirectGuest.ServerIdentity != "spiffe://cluster.local/ns/ax-demo/sa/default" {
		t.Fatal("legacy configuration was mutated")
	}
	for _, identity := range []string{"spiffe://cluster.local/ns/ax-runtime/sa/default", "spiffe://cluster.local/ns/arbitrary-space/sa/default", ""} {
		config.Interactive.GuestIdentity = identity
		if _, err := inspectConfig(config, true); err == nil {
			t.Fatal("unapproved interactive worker identity accepted")
		}
	}
	config.Interactive.GuestIdentity = "spiffe://cluster.local/ns/ax-demo/sa/default"
	config.Interactive.Atespace = "arbitrary-space"
	if _, err := inspectConfig(config, true); err == nil {
		t.Fatal("arbitrary interactive atespace accepted")
	}
}
