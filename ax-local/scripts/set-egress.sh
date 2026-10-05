#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
actor="${1:?actor name is required}"
hosts="${2:?hostname JSON file is required}"
export KUBECONFIG="$root/kubeconfig"
context=kind-ax-local
mkdir -p "$root/.state"
work="$(mktemp -d "$root/.state/egress.XXXXXX")"
forward_pid=
cleanup() {
  if [[ -n "$forward_pid" ]]; then
    kill "$forward_pid" 2>/dev/null || true
    wait "$forward_pid" 2>/dev/null || true
  fi
  rm -f "$work/ca.pem" "$work/forward.log"
  rmdir "$work"
}
trap cleanup EXIT

kubectl --context "$context" get clustertrustbundle -l podcert.ate.dev/canarying=live \
  -o 'jsonpath={range .items[?(@.spec.signerName=="servicedns.podcert.ate.dev/identity")]}{.spec.trustBundle}{"\n"}{end}' > "$work/ca.pem"
kubectl --context "$context" -n ate-system port-forward --address=127.0.0.1 svc/api 18443:443 > "$work/forward.log" 2>&1 &
forward_pid=$!
for attempt in {1..20}; do
  if rg -q '^Forwarding from 127.0.0.1:18443' "$work/forward.log"; then
    break
  fi
  if ! kill -0 "$forward_pid" 2>/dev/null; then
    cat "$work/forward.log" >&2
    exit 1
  fi
  sleep 0.5
done
if ! rg -q '^Forwarding from 127.0.0.1:18443' "$work/forward.log"; then
  echo "Substrate port-forward did not become ready" >&2
  exit 1
fi
kubectl --context "$context" -n ate-system create token ate-client --audience=api.ate-system.svc --duration=10m |
  "$root/bin/set-egress" --actor "$actor" --ca "$work/ca.pem" --hosts "$hosts"
