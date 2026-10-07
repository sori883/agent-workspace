#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $# == 1 ]] || { echo 'Usage: prepare-credential-free.sh NEW_DIRECTORY' >&2; exit 2; }
source_dir="$patch_dir/../.sources/ax"
expected=ac2332829f22360ff97b0ba34d94dd0dd782f17e
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$expected" ]] || { echo 'Unexpected AX source revision' >&2; exit 1; }
[[ ! -e "$1" ]] || { echo 'Destination must not exist' >&2; exit 1; }
mkdir -- "$1"
destination="$(cd -- "$1" && pwd)"
git -C "$source_dir" archive "$expected" | tar -x -C "$destination"
git -C "$destination" apply --check "$patch_dir/credential-free-atespace.patch"
git -C "$destination" apply "$patch_dir/credential-free-atespace.patch"
cp "$patch_dir/Dockerfile.ax-server" "$destination/Dockerfile"
echo 'Patched isolated AX source prepared; no shared source or service changed.'
