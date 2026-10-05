#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
mkdir -p "$root/.state/docker"
if [[ ! -f "$root/.state/docker/config.json" ]]; then
  printf '{"cliPluginsExtraDirs":["%s/.docker/cli-plugins"]}\n' "$HOME" > "$root/.state/docker/config.json"
  chmod 600 "$root/.state/docker/config.json"
fi
export DOCKER_HOST="$docker_host"
export DOCKER_CONFIG="$root/.state/docker"
export KUBECONFIG="$root/kubeconfig"
export KIND_CLUSTER_NAME=ax-local
export KUBECTL_CONTEXT=kind-ax-local
export KO_DOCKER_REPO=localhost:5001
export KO_DEFAULTPLATFORMS=linux/arm64
exec mise exec go@1.27.1 ko@0.19.1 -- "$@"
