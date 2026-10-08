package settings

import (
	"context"
	"errors"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sori883/agent-workspace/execution/controller"
)

type SkillStorageConfig struct {
	StoreID             string `json:"store_id"`
	Endpoint            string `json:"endpoint"`
	Bucket              string `json:"bucket"`
	Region              string `json:"region"`
	ForcePathStyle      bool   `json:"force_path_style"`
	AllowInsecureHTTP   bool   `json:"allow_insecure_http"`
	AccessKeyIDPath     string `json:"access_key_id_path"`
	SecretAccessKeyPath string `json:"secret_access_key_path"`
}

func (f File) SkillObjectReader() (controller.SkillObjectReader, error) {
	if f.SkillStorage == nil {
		return nil, nil
	}
	s := f.SkillStorage
	credentials := func(context.Context) (aws.Credentials, error) {
		id, err := read(s.AccessKeyIDPath, true, 4096, f.SecretGroupRead)
		if err != nil {
			return aws.Credentials{}, errors.New("skill_storage_credential_unavailable")
		}
		key, err := read(s.SecretAccessKeyPath, true, 4096, f.SecretGroupRead)
		if err != nil {
			return aws.Credentials{}, errors.New("skill_storage_credential_unavailable")
		}
		access, secret := strings.TrimSpace(string(id)), strings.TrimSpace(string(key))
		if access == "" || secret == "" || strings.ContainsAny(access+secret, "\r\n\x00") {
			return aws.Credentials{}, errors.New("skill_storage_credential_invalid")
		}
		return aws.Credentials{AccessKeyID: access, SecretAccessKey: secret}, nil
	}
	if _, err := credentials(context.Background()); err != nil {
		return nil, err
	}
	return controller.NewS3SkillReader(controller.S3SkillReaderConfig{
		StoreID: s.StoreID, Endpoint: s.Endpoint, Bucket: s.Bucket, Region: s.Region,
		ForcePathStyle: s.ForcePathStyle, AllowInsecureHTTP: s.AllowInsecureHTTP, Credentials: credentials,
	})
}
