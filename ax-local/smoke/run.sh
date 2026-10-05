#!/bin/sh
set -eu
test "$(uname -m)" = aarch64
echo "ax-local-registry-ok: linux/arm64"
