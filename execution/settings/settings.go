package settings

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/sori883/agent-workspace/execution/controller"
	"github.com/sori883/agent-workspace/execution/gateway"
	"github.com/sori883/agent-workspace/execution/native"
)

type Endpoint struct {
	Address           string `json:"address"`
	ServerName        string `json:"server_name"`
	CAPath            string `json:"ca_path"`
	BearerPath        string `json:"bearer_path"`
	PlaintextLoopback bool   `json:"plaintext_loopback"`
}

type WorkbenchConfig struct {
	Enabled             bool     `json:"enabled"`
	ModelEnabled        bool     `json:"model_enabled"`
	PythonEnabled       bool     `json:"python_enabled"`
	CodeImage           string   `json:"code_image"`
	LegacyRuntimeImages []string `json:"legacy_runtime_images"`
}

type File struct {
	SkillStorage *SkillStorageConfig `json:"skill_storage"`
	Workbench    *WorkbenchConfig    `json:"workbench"`
	ModelGateway *struct {
		Enabled    bool   `json:"enabled"`
		APIKeyPath string `json:"api_key_path"`
	} `json:"model_gateway"`
	SecretGroupRead bool     `json:"secret_group_read"`
	AX              Endpoint `json:"ax"`
	Guest           Endpoint `json:"guest"`
	DirectGuest     *struct {
		CAPath           string `json:"ca_path"`
		ClientBundlePath string `json:"client_bundle_path"`
		ServerIdentity   string `json:"server_identity"`
	} `json:"direct_guest"`
	Substrate   Endpoint `json:"substrate"`
	Atespace    string   `json:"atespace"`
	Image       string   `json:"image"`
	Interactive *struct {
		Image         string `json:"image"`
		Atespace      string `json:"atespace"`
		GuestIdentity string `json:"guest_identity"`
	} `json:"interactive"`
	AllowedHosts            []string `json:"allowed_hosts"`
	CallTimeoutSeconds      int      `json:"call_timeout_seconds"`
	LifecycleTimeoutSeconds int      `json:"lifecycle_timeout_seconds"`
	ControllerID            string   `json:"controller_id"`
	Database                *struct {
		Host         string `json:"host"`
		Port         uint16 `json:"port"`
		Database     string `json:"database"`
		User         string `json:"user"`
		PasswordPath string `json:"password_path"`
		ServerName   string `json:"server_name"`
		CAPath       string `json:"ca_path"`
		Schema       string `json:"schema"`
	} `json:"database"`
}

func (f File) CodeNative() (*native.Config, error) {
	if f.Workbench == nil || !f.Workbench.Enabled || f.Workbench.CodeImage == "" {
		if f.Workbench != nil && f.Workbench.PythonEnabled {
			return nil, errors.New("invalid_workbench_config")
		}
		return nil, nil
	}
	base, err := f.InteractiveNative()
	if err != nil || base == nil {
		return nil, errors.New("invalid_workbench_config")
	}
	base.Atespace = "ax-code"
	base.Image = f.Workbench.CodeImage
	return base, nil
}

func (f File) ModelProvider() (gateway.Provider, error) {
	if f.ModelGateway == nil || !f.ModelGateway.Enabled {
		return nil, nil
	}
	if f.ModelGateway.APIKeyPath == "" {
		return nil, errors.New("invalid_model_gateway_config")
	}
	return gateway.NewGemini(func() (string, error) {
		data, err := read(f.ModelGateway.APIKeyPath, true, 4096, f.SecretGroupRead)
		if err != nil {
			return "", errors.New("model_credential_unavailable")
		}
		key := strings.TrimSpace(string(data))
		if key == "" || strings.ContainsAny(key, "\r\n\x00") {
			return "", errors.New("model_credential_unavailable")
		}
		return key, nil
	}), nil
}

func (f File) InteractiveNative() (*native.Config, error) {
	if f.Interactive == nil {
		return nil, nil
	}
	if f.Interactive.Atespace != "ax-runtime" || f.Interactive.GuestIdentity != "spiffe://cluster.local/ns/ax-demo/sa/default" {
		return nil, errors.New("invalid_interactive_config")
	}
	base, err := f.Native()
	if err != nil || base.DirectGuest == nil {
		return nil, errors.New("invalid_interactive_config")
	}
	identity := *base.DirectGuest
	identity.ServerIdentity = f.Interactive.GuestIdentity
	base.DirectGuest = &identity
	base.Atespace = f.Interactive.Atespace
	base.Image = f.Interactive.Image
	base.AllowedHosts = nil
	return &base, nil
}

func Load(path string) (File, error) {
	var config File
	data, err := read(path, false, 65536, false)
	if err != nil {
		return config, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil {
		return File{}, errors.New("invalid_config_file")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return File{}, errors.New("invalid_config_file")
	}
	return config, nil
}

func read(path string, secret bool, limit int64, allowGroupRead bool) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("config_file_unreadable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("config_file_permissions_or_size")
	}
	if secret {
		forbidden := os.FileMode(0077)
		if allowGroupRead {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || stat.Gid != uint32(os.Getegid()) {
				return nil, errors.New("config_secret_group_mismatch")
			}
			forbidden = 0037
		}
		if info.Mode().Perm()&forbidden != 0 {
			return nil, errors.New("config_file_permissions_or_size")
		}
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("config_file_unreadable")
	}
	return data, nil
}

func (e Endpoint) native(allowGroupRead bool) (native.Endpoint, error) {
	result := native.Endpoint{Address: e.Address, ServerName: e.ServerName, PlaintextLoopback: e.PlaintextLoopback}
	var err error
	if e.CAPath != "" {
		result.CAPEM, err = read(e.CAPath, false, 65536, false)
		if err != nil {
			return result, err
		}
	}
	if e.BearerPath != "" {
		result.BearerToken = func() (string, error) {
			data, err := read(e.BearerPath, true, 16384, allowGroupRead)
			if err != nil {
				return "", err
			}
			token := strings.TrimSpace(string(data))
			if token == "" || strings.ContainsAny(token, "\r\n\x00") {
				return "", errors.New("invalid_credential")
			}
			return token, nil
		}
		if _, err := result.BearerToken(); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (f File) Native() (native.Config, error) {
	result := native.Config{Atespace: f.Atespace, Image: f.Image, AllowedHosts: f.AllowedHosts, CallTimeout: time.Duration(f.CallTimeoutSeconds) * time.Second, LifecycleTimeout: time.Duration(f.LifecycleTimeoutSeconds) * time.Second}
	var err error
	result.AX, err = f.AX.native(f.SecretGroupRead)
	if err != nil {
		return result, err
	}
	result.Guest, err = f.Guest.native(f.SecretGroupRead)
	if err != nil {
		return result, err
	}
	result.Substrate, err = f.Substrate.native(f.SecretGroupRead)
	if err != nil {
		return result, err
	}
	if f.DirectGuest != nil {
		ca, err := read(f.DirectGuest.CAPath, false, 65536, false)
		if err != nil {
			return result, err
		}
		path := f.DirectGuest.ClientBundlePath
		certificate := func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			data, err := read(path, true, 65536, f.SecretGroupRead)
			if err != nil {
				return nil, err
			}
			pair, err := tls.X509KeyPair(data, data)
			if err != nil {
				return nil, errors.New("invalid_client_certificate")
			}
			return &pair, nil
		}
		if _, err := certificate(nil); err != nil {
			return result, err
		}
		result.DirectGuest = &native.DirectGuestConfig{CAPEM: ca, ServerIdentity: f.DirectGuest.ServerIdentity, ClientCertificate: certificate}
	}
	return result, err
}

func (f File) DatabaseConfig() (controller.DatabaseConfig, error) {
	if f.Database == nil {
		return controller.DatabaseConfig{}, errors.New("database_config_required")
	}
	db := f.Database
	password, err := read(db.PasswordPath, true, 16384, f.SecretGroupRead)
	if err != nil {
		return controller.DatabaseConfig{}, err
	}
	ca, err := read(db.CAPath, false, 65536, false)
	if err != nil {
		return controller.DatabaseConfig{}, err
	}
	return controller.DatabaseConfig{Host: db.Host, Port: db.Port, Database: db.Database, User: db.User, Password: strings.TrimSpace(string(password)), ServerName: db.ServerName, CAPEM: ca, Schema: db.Schema}, nil
}
