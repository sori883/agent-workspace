#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $# == 0 ]] || { echo 'Usage: verify-code-runtime.sh' >&2; exit 2; }
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/ax-code-verify.XXXXXX")"
trap 'rm -rf -- "$verification_dir"' EXIT
"$patch_dir/prepare-code-runtime.sh" "$verification_dir/source"
ax_dir="$verification_dir/source/ax"
substrate_dir="$verification_dir/source/substrate"
cp "$patch_dir/credential_free_test.go.txt" "$ax_dir/internal/controller/credential_free_test.go"
cp "$patch_dir/code_runtime_ax_profile_test.go.txt" "$ax_dir/internal/substrate/code_profile_test.go"
cp "$patch_dir/code_runtime_ax_controller_test.go.txt" "$ax_dir/internal/controller/code_profile_test.go"
cp "$patch_dir/code_runtime_substrate_profile_test.go.txt" "$substrate_dir/internal/codeprofile/profile_test.go"
cp "$patch_dir/code_runtime_record_test.go.txt" "$substrate_dir/internal/codequota/record_test.go"
cp "$patch_dir/code_runtime_mount_linux_test.go.txt" "$substrate_dir/internal/codequota/mount_linux_test.go"
cp "$patch_dir/code_runtime_atelet_test.go.txt" "$substrate_dir/cmd/atelet/code_profile_test.go"
cp "$patch_dir/code_runtime_ateom_test.go.txt" "$substrate_dir/cmd/ateom-gvisor/code_runtime_test.go"
cp "$patch_dir/code_runtime_control_test.go.txt" "$substrate_dir/cmd/ateapi/internal/controlapi/code_profile_test.go"
(
  cd "$ax_dir"
  go test -race ./internal/controller ./internal/substrate
  go build ./cmd/ax-server
)
(
  cd "$substrate_dir"
  go test -race ./internal/codeprofile ./internal/codequota ./internal/ocispec ./cmd/atelet ./cmd/ateapi/internal/controlapi
  if [[ "$(go env GOOS)" == linux ]]; then
    go test -race ./cmd/ateom-gvisor
  else
    [[ -n "${CODE_TEST_IMAGE:-}" ]] || { echo 'Set CODE_TEST_IMAGE to an existing local Linux image; Linux-only tests are required.' >&2; exit 1; }
    test_image="$(docker image inspect "$CODE_TEST_IMAGE" --format '{{.Id}}')"
    arch="${CODE_TEST_ARCH:-arm64}"
    [[ "$arch" == arm64 || "$arch" == amd64 ]] || exit 2
    for package in internal/codequota cmd/ateom-gvisor; do
      binary="${package##*/}.test"
      GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go test -c -o "$verification_dir/$binary" "./$package"
      docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec \
        --entrypoint "/tests/$binary" --mount "type=bind,source=$verification_dir/$binary,target=/tests/$binary,readonly" \
        "$test_image" -test.v
    done
  fi
  for component in ateapi atelet ateom-gvisor; do
    GOOS=linux GOARCH="${CODE_TEST_ARCH:-arm64}" CGO_ENABLED=0 go build -o "$verification_dir/$component" "./cmd/$component"
  done
)
echo 'Code profile local verification passed. No AX Actor or host mount lifecycle was exercised.'
