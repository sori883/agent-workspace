package native

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthDependsOnAXWithoutActions(t *testing.T) {
	code := http.StatusOK
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/healthz" {
			t.Error("unexpected operation")
		}
		w.WriteHeader(code)
	}))
	defer server.Close()
	a := &Adapter{config: Config{AX: Endpoint{Address: strings.TrimPrefix(server.URL, "http://"), PlaintextLoopback: true}}}
	if err := a.Health(context.Background()); err != nil {
		t.Fatal(err)
	}
	code = http.StatusServiceUnavailable
	if err := a.Health(context.Background()); err == nil {
		t.Fatal("AX unavailable reported healthy")
	}
	if calls != 2 {
		t.Fatal("unexpected retry")
	}
}
