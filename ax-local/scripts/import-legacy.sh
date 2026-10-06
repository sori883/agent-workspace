#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root/web"
export AX_LEGACY_RUNS="$root/ax-local/.state/runs"
exec python3 - "$@" <<'PY'
import fcntl
import os
from pathlib import Path
import subprocess
import sys

path = os.path.join(os.environ["AX_LEGACY_RUNS"], ".lock")
fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit("Legacy writer is still active; migration stopped.")
if "--dry-run" not in sys.argv[1:] and not (Path(path).parent.parent / "execution/managed").is_file():
    sys.exit("Legacy admission must be retired before importing.")
os.environ["AX_LEGACY_LOCK_FD"] = str(fd)
sys.exit(subprocess.call(["node", "--import", "tsx", "scripts/import-legacy.ts", *sys.argv[1:]], pass_fds=(fd,)))
PY
