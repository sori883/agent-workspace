#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
source_dir="${1:-$patch_dir/../.sources/ax}"
expected=ac2332829f22360ff97b0ba34d94dd0dd782f17e
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$expected" ]] || { echo 'Unexpected AX source revision' >&2; exit 1; }
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/ax-credential-free.XXXXXX")"
trap 'rm -rf -- "$verification_dir"' EXIT
git -C "$source_dir" archive "$expected" | tar -x -C "$verification_dir"
git -C "$verification_dir" apply --check "$patch_dir/credential-free-atespace.patch"
git -C "$verification_dir" apply "$patch_dir/credential-free-atespace.patch"
cp "$patch_dir/credential_free_test.go.txt" "$verification_dir/internal/controller/credential_free_test.go"
cd "$verification_dir"
gofmt -w internal/controller/reconciler.go internal/controller/credential_free_test.go internal/substrate/client.go
go test -race ./internal/controller ./internal/substrate
go build ./cmd/ax-server
