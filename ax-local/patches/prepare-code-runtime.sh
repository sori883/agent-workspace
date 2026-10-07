#!/usr/bin/env bash
set -euo pipefail
patch_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
[[ $# == 1 ]] || { echo 'Usage: prepare-code-runtime.sh NEW_DIRECTORY' >&2; exit 2; }
[[ ! -e "$1" ]] || { echo 'Destination must not exist' >&2; exit 1; }
ax_revision=ac2332829f22360ff97b0ba34d94dd0dd782f17e
substrate_revision=944abe3278b895ccbf5d45555a49dd0f2f6ceae7
for repo in ax substrate; do
  expected="$ax_revision"
  [[ "$repo" == ax ]] || expected="$substrate_revision"
  [[ "$(git -C "$patch_dir/../.sources/$repo" rev-parse HEAD)" == "$expected" ]] || { echo "Unexpected $repo source revision" >&2; exit 1; }
done
mkdir -- "$1"
destination="$(cd -- "$1" && pwd)"
for repo in ax substrate; do
  expected="$ax_revision"
  [[ "$repo" == ax ]] || expected="$substrate_revision"
  mkdir -- "$destination/$repo"
  git -C "$patch_dir/../.sources/$repo" archive "$expected" | tar -x -C "$destination/$repo"
  git -C "$destination/$repo" init -q
done
git -C "$destination/ax" apply --check "$patch_dir/credential-free-atespace.patch"
git -C "$destination/ax" apply "$patch_dir/credential-free-atespace.patch"
for repo in ax substrate; do
  git -C "$destination/$repo" apply --check "$patch_dir/code-runtime-$repo.patch"
  git -C "$destination/$repo" apply "$patch_dir/code-runtime-$repo.patch"
done
cp "$patch_dir/Dockerfile.code-ax-server" "$destination/ax/Dockerfile"
cp "$patch_dir/Dockerfile.code-substrate" "$destination/substrate/Dockerfile"
printf '.git\n' > "$destination/ax/.dockerignore"
printf '.git\n' > "$destination/substrate/.dockerignore"
echo 'Isolated AX/Substrate code profile prepared. No shared source or service changed.'
