package controller

import (
	"strings"
	"testing"
)

func TestSavedWorkbenchImageRequiresAnExplicitAdapter(t *testing.T) {
	c, store, legacy := setupWorkbench(t, false)
	savedImage := store.claim.Image
	c.WorkbenchRuntimeImage = "localhost:5001/current@sha256:" + strings.Repeat("d", 64)
	if _, err := c.selectWorkbench(store.claim); err == nil {
		t.Fatal("unconfigured saved image accepted")
	}
	c.WorkbenchRuntimes = map[string]Executor{savedImage: legacy}
	selected, err := c.selectWorkbench(store.claim)
	if err != nil || selected.Image != savedImage || selected.Executor != legacy {
		t.Fatal("saved image adapter not retained", err)
	}
	if c.Image != savedImage || c.WorkbenchRuntimeImage == savedImage {
		t.Fatal("selection mutated shared controller")
	}
}
