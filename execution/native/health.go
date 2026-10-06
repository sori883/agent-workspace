package native

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"time"
)

func (a *Adapter) Health(ctx context.Context) error {
	endpoint := a.config.AX
	transport := &http.Transport{}
	scheme := "http"
	if !endpoint.PlaintextLoopback {
		scheme = "https"
		var ca *x509.CertPool
		if len(endpoint.CAPEM) > 0 {
			ca = x509.NewCertPool()
			if !ca.AppendCertsFromPEM(endpoint.CAPEM) {
				return errors.New("ax_health_unavailable")
			}
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: ca, ServerName: endpoint.ServerName}
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect_forbidden") }}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+endpoint.Address+"/healthz", nil)
	if err != nil {
		return errors.New("ax_health_unavailable")
	}
	token := endpoint.Bearer
	if endpoint.BearerToken != nil {
		token, err = endpoint.BearerToken()
		if err != nil {
			return errors.New("ax_health_unavailable")
		}
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("ax_health_unavailable")
	}
	defer response.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if err != nil || response.StatusCode != http.StatusOK {
		return errors.New("ax_health_unavailable")
	}
	return nil
}
