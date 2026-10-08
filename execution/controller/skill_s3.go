package controller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/sori883/agent-workspace/execution/native"
)

type S3SkillReaderConfig struct {
	StoreID           string
	Endpoint          string
	Bucket            string
	Region            string
	ForcePathStyle    bool
	AllowInsecureHTTP bool
	Credentials       func(context.Context) (aws.Credentials, error)
	HTTPClient        *http.Client
}
type S3SkillReader struct {
	config   S3SkillReaderConfig
	endpoint *url.URL
	client   *http.Client
	signer   *v4.Signer
}

var skillBucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
var skillStoreIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var skillRegionPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func NewS3SkillReader(config S3SkillReaderConfig) (*S3SkillReader, error) {
	endpoint, err := url.Parse(config.Endpoint)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Path != "" && endpoint.Path != "/") || endpoint.Opaque != "" || !skillBucketPattern.MatchString(config.Bucket) || !skillStoreIDPattern.MatchString(config.StoreID) || !skillRegionPattern.MatchString(config.Region) || config.Credentials == nil {
		return nil, errors.New("invalid_skill_storage_config")
	}
	if endpoint.Scheme != "https" {
		allowed := map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true, "host.docker.internal": true}
		if endpoint.Scheme != "http" || !config.AllowInsecureHTTP || !config.ForcePathStyle || !allowed[endpoint.Hostname()] {
			return nil, errors.New("invalid_skill_storage_config")
		}
	}
	client := http.Client{Timeout: 5 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("skill_storage_redirect_denied") }
	return &S3SkillReader{config, endpoint, &client, v4.NewSigner()}, nil
}

func (s *S3SkillReader) get(ctx context.Context, key string, size int) ([]byte, error) {
	if size < 0 || size > 32768 {
		return nil, errors.New("skill_storage_integrity")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	endpoint := *s.endpoint
	if s.config.ForcePathStyle {
		endpoint.Path = "/" + s.config.Bucket + "/" + key
	} else {
		endpoint.Host = s.config.Bucket + "." + endpoint.Host
		endpoint.Path = "/" + key
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, errors.New("skill_storage_unavailable")
	}
	credentials, err := s.config.Credentials(ctx)
	if err != nil || credentials.AccessKeyID == "" || credentials.SecretAccessKey == "" {
		return nil, errors.New("skill_storage_unavailable")
	}
	emptyHash := native.HashBytes(nil)
	request.Header.Set("x-amz-content-sha256", emptyHash)
	if err = s.signer.SignHTTP(ctx, credentials, request, emptyHash, "s3", s.config.Region, time.Now(), func(options *v4.SignerOptions) { options.DisableURIPathEscaping = true }); err != nil {
		return nil, errors.New("skill_storage_unavailable")
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, errors.New("skill_storage_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, errors.New("skill_storage_integrity")
	}
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("skill_storage_unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(size)+1))
	if err != nil {
		return nil, errors.New("skill_storage_unavailable")
	}
	if len(data) != size || !utf8.Valid(data) {
		return nil, errors.New("skill_storage_integrity")
	}
	return data, nil
}

type skillObjectManifest struct {
	FormatVersion int                      `json:"format_version"`
	WorkspaceID   string                   `json:"workspace_id"`
	DefinitionID  string                   `json:"definition_id"`
	RevisionID    string                   `json:"revision_id"`
	Name          string                   `json:"name"`
	Description   string                   `json:"description"`
	ContentSHA256 string                   `json:"content_sha256"`
	Files         []native.SkillObjectFile `json:"files"`
}

func (s *S3SkillReader) ReadSkill(ctx context.Context, object native.WorkbenchSkillObject) (map[string][]byte, error) {
	if object.Validate() != nil {
		return nil, errors.New("skill_storage_integrity")
	}
	if object.Source.StoreID != s.config.StoreID {
		return nil, errors.New("skill_storage_unavailable")
	}
	raw, err := s.get(ctx, object.Source.ManifestKey, object.Source.ManifestBytes)
	if err != nil {
		return nil, err
	}
	var manifest skillObjectManifest
	workspace, definition, revision := object.Source.Identity()
	if native.HashBytes(raw) != object.Source.ManifestSHA256 || native.DecodeStrict(raw, &manifest) != nil || manifest.FormatVersion != 1 || manifest.WorkspaceID != workspace || manifest.DefinitionID != definition || manifest.RevisionID != revision || manifest.Name != object.Name || manifest.Description != object.Description || manifest.ContentSHA256 != object.ContentSHA256 || !reflect.DeepEqual(manifest.Files, object.Files) {
		return nil, errors.New("skill_storage_integrity")
	}
	files := map[string][]byte{}
	for _, path := range object.LoadedPaths {
		for _, metadata := range object.Files {
			if path != metadata.Path {
				continue
			}
			data, err := s.get(ctx, native.SkillObjectPrefix(object.Source)+path, metadata.SizeBytes)
			if err != nil {
				return nil, err
			}
			if native.HashBytes(data) != metadata.SHA256 {
				return nil, errors.New("skill_storage_integrity")
			}
			files[path] = data
		}
	}
	return files, nil
}
