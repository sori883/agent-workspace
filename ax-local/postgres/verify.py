#!/usr/bin/env python3
import json
import secrets
import subprocess

from manage import CONTAINER, DATABASES, ROOT, SECRETS, sql


def connect(role, database, password, *, extra="", remote=None):
    if remote:
        prefix = ["kubectl", "--kubeconfig", str(ROOT / "kubeconfig"), "-n", "ate-system",
                  "exec", "-i", remote, "--"]
        certificate = (SECRETS / "ca.crt").read_text()
        script = "set -eu; read -r PGPASSWORD; export PGPASSWORD; ca=$(mktemp); trap 'rm -f \"$ca\"' EXIT; "
        script += "cat >\"$ca\" <<'AX_LOCAL_CA'\n" + certificate + "AX_LOCAL_CA\n"
        script += 'export PGSSLROOTCERT="$ca"; psql -X -At "$1" -c "SELECT current_user,current_database(),ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();"'
        endpoint = "host=host.docker.internal port=55432"
    else:
        prefix = ["docker", "exec", "-i", CONTAINER]
        script = 'read -r PGPASSWORD; export PGPASSWORD; exec psql -X -At "$1" -c "SELECT current_user,current_database(),ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid();"'
        endpoint = "host=localhost port=5432 sslrootcert=/run/local-secrets/ca.crt"
    dsn = f"{endpoint} user={role} dbname={database} sslmode=verify-full connect_timeout=5 {extra}"
    return subprocess.run([*prefix, "sh", "-c", script, "sh", dsn], input=(password + "\n").encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)


def main():
    checks = {}
    for database, role in DATABASES.items():
        password = (SECRETS / f"{database}.password").read_text().strip()
        result = connect(role, database, password)
        checks[f"{database}:tls"] = result.returncode == 0 and result.stdout.strip() == f"{role}|{database}|t".encode()
        for other in DATABASES:
            if other != database:
                denied = connect(role, other, password)
                checks[f"{database}:deny:{other}"] = denied.returncode != 0 and b"permission denied for database" in denied.stderr
        checks[f"{database}:deny:bad-password"] = b"password authentication failed" in connect(role, database, "incorrect").stderr
        checks[f"{database}:deny:plaintext"] = b"pg_hba.conf rejects connection" in connect(role, database, password, extra="sslmode=disable").stderr
    password = (SECRETS / "substrate.password").read_text().strip()
    checks["deny:wrong-ca"] = b"certificate verify failed" in connect("ax_substrate", "substrate", password, extra="sslrootcert=/etc/ssl/cert.pem").stderr
    checks["deny:wrong-hostname"] = b"does not match host name" in connect("ax_substrate", "substrate", password, extra="host=incorrect.invalid hostaddr=127.0.0.1").stderr
    checks["roles:restricted"] = sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('ax_substrate','ax_keycloak','ax_app') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication;") == "3"
    base = ["kubectl", "--kubeconfig", str(ROOT / "kubeconfig"), "-n", "ate-system"]
    pod = "ax-postgres-check-" + secrets.token_hex(4)
    image = "postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15"
    try:
        subprocess.run([*base, "run", pod, "--image=" + image, "--restart=Never", "--command", "--", "sleep", "180"],
                       check=True, stdout=subprocess.DEVNULL, timeout=30)
        subprocess.run([*base, "wait", "--for=condition=Ready", "pod/" + pod, "--timeout=60s"],
                       check=True, stdout=subprocess.DEVNULL, timeout=70)
        remote = connect("ax_substrate", "substrate", password, remote=pod)
        checks["kubernetes:tls"] = remote.returncode == 0 and remote.stdout.strip() == b"ax_substrate|substrate|t"
    finally:
        subprocess.run([*base, "delete", "pod", pod, "--ignore-not-found", "--wait=false"],
                       check=True, stdout=subprocess.DEVNULL, timeout=30)
    print(json.dumps(checks, indent=2))
    if not all(checks.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
