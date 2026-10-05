#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
registry=kind-registry
cluster=ax-local
port=5001

if docker inspect "$registry" >/dev/null 2>&1; then
  owner="$(docker inspect -f '{{index .Config.Labels "dev.ax.local.cluster"}}' "$registry")"
  if [[ "$owner" != "$cluster" ]]; then
    echo "Existing registry belongs to another setup; inspect it before reusing." >&2
    exit 1
  fi
  docker start "$registry" >/dev/null
else
  docker run -d --restart=unless-stopped \
    --label dev.ax.local.cluster="$cluster" \
    -p "127.0.0.1:${port}:5000" \
    -v ax-local-registry-data:/var/lib/registry \
    --network kind --name "$registry" registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8
fi

if [[ "$(docker inspect -f '{{json .NetworkSettings.Networks.kind}}' "$registry")" == null ]]; then
  docker network connect kind "$registry"
fi

nodes="$(kind get nodes --name "$cluster")"
test -n "$nodes"
for node in $nodes; do
  directory="/etc/containerd/certs.d/localhost:${port}"
  docker exec "$node" mkdir -p "$directory"
  printf '[host."http://%s:5000"]\n' "$registry" |
    docker exec -i "$node" cp /dev/stdin "$directory/hosts.toml"
  docker exec "$node" sysctl net.ipv4.conf.all.proxy_arp=1
  docker exec "$node" sysctl -e net.ipv6.conf.all.proxy_ndp=1
done

kubectl --kubeconfig "$root/kubeconfig" --context "kind-$cluster" apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${port}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

curl --fail --retry 10 --retry-delay 1 --retry-connrefused "http://127.0.0.1:${port}/v2/"
