#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATE = ROOT / ".state/postgres"
SECRETS = STATE / "secrets"
CONTAINER = "ax-local-postgres"
DATABASES = {"substrate": "ax_substrate", "keycloak": "ax_keycloak", "app": "ax_app"}


def run(args, *, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed (exit {result.returncode}); secret-bearing output withheld")
    return result.stdout


def compose(*args):
    return run(["docker", "compose", "-f", str(HERE / "compose.yaml"), *args])


def sql(statement, database="postgres"):
    return run(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                "-U", "postgres", "-d", database, "-At"], data=statement.encode()).decode().strip()


def write_private(path, value):
    with path.open("x") as stream:
        stream.write(value)
    path.chmod(0o600)


def initialize():
    expected = ["admin.password", *(f"{db}.password" for db in DATABASES),
                "ca.key", "ca.crt", "server.key", "server.crt"]
    if SECRETS.exists():
        if not all((SECRETS / name).is_file() for name in expected):
            raise RuntimeError("Incomplete secrets; restore the private backup instead of replacing credentials")
        print("Existing credentials and TLS files retained")
        return
    volumes = run(["docker", "volume", "ls", "--format", "{{.Name}}"])
    if b"ax-local-postgres-data" in volumes.splitlines():
        raise RuntimeError("Data volume already exists; recover its original secrets first")
    SECRETS.mkdir(parents=True, mode=0o700)
    STATE.chmod(0o700)
    for name in ["admin", *DATABASES]:
        write_private(SECRETS / f"{name}.password", secrets.token_urlsafe(36) + "\n")
    config = SECRETS / "openssl.cnf"
    write_private(config, """[req]
distinguished_name=dn
prompt=no
[dn]
CN=ax-local-postgres
[server]
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:host.docker.internal,DNS:ax-local-postgres,IP:127.0.0.1
""")
    run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "365",
         "-subj", "/CN=ax-local-postgres-ca", "-keyout", str(SECRETS / "ca.key"),
         "-out", str(SECRETS / "ca.crt")])
    run(["openssl", "req", "-new", "-newkey", "rsa:3072", "-nodes", "-config", str(config),
         "-keyout", str(SECRETS / "server.key"), "-out", str(SECRETS / "server.csr")])
    run(["openssl", "x509", "-req", "-in", str(SECRETS / "server.csr"), "-CA", str(SECRETS / "ca.crt"),
         "-CAkey", str(SECRETS / "ca.key"), "-CAserial", str(SECRETS / "ca.srl"), "-CAcreateserial", "-days", "365",
         "-extfile", str(config), "-extensions", "server", "-out", str(SECRETS / "server.crt")])
    for path in SECRETS.iterdir():
        path.chmod(0o600)
    print("Private credentials and local TLS certificate created (365 days)")


def provision():
    for database, role in DATABASES.items():
        password = (SECRETS / f"{database}.password").read_text().strip().replace("'", "''")
        exists = sql(f"SELECT 1 FROM pg_roles WHERE rolname='{role}';") == "1"
        if not exists:
            sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '{password}';")
        owner = sql(f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='{database}';")
        if not owner:
            sql(f"CREATE DATABASE {database} OWNER {role};")
        elif owner != role:
            raise RuntimeError(f"Unexpected owner of {database}; no ownership changed")
        sql(f"REVOKE ALL ON DATABASE {database} FROM PUBLIC; GRANT CONNECT ON DATABASE {database} TO {role};")
    sql("REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;")
    print("Separate databases and login roles prepared; PUBLIC database access revoked")


def substrate_config():
    return {
        "ATE_API_POSTGRES_CONNECTION_STRING": "postgres://ax_substrate@host.docker.internal:55432/substrate?sslmode=verify-full&sslrootcert=/run/postgres-server-ca/server-ca.pem",
        "ATE_API_POSTGRES_SCHEMA": "public",
        "PGPASSWORD": (SECRETS / "substrate.password").read_text().strip(),
    }


def apply_substrate():
    base = ["kubectl", "--kubeconfig", str(ROOT / "kubeconfig"), "-n", "ate-system"]
    deployment = json.loads(run([*base, "get", "deployment", "ate-api-server", "-o", "json"]))
    pods = json.loads(run([*base, "get", "pods", "-l", "app=ate-api-server", "-o", "json"]))
    if deployment["spec"]["replicas"] != 0 or pods["items"]:
        raise RuntimeError("Stop every ate-api-server Pod before changing the DB connection")
    for name, values in [("ate-api-server-secret-envvars", substrate_config()),
                         ("postgres-server-ca", {"server-ca.pem": (SECRETS / "ca.crt").read_text()})]:
        existing = run([*base, "get", "secret", name, "--ignore-not-found", "-o", "name"])
        if existing:
            run([*base, "patch", "secret", name, "--type=merge", "--patch-file=/dev/stdin"],
                data=json.dumps({"stringData": values}).encode())
        else:
            manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": "ate-system"},
                        "type": "Opaque", "stringData": values}
            run([*base, "create", "-f", "-"], data=json.dumps(manifest).encode())
    print("Substrate connection Secret and CA installed; API remains stopped")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Local external PostgreSQL setup (no automatic data migration)")
    parser.add_argument("command", choices=["init", "up", "provision", "status", "apply-substrate"])
    args = parser.parse_args()
    if args.command == "init":
        initialize()
    elif args.command == "up":
        if not (SECRETS / "server.crt").is_file():
            raise RuntimeError("Run init or recover the original private files first")
        compose("up", "-d", "--wait", "--wait-timeout", "90")
        print("PostgreSQL healthy on 127.0.0.1:55432")
    elif args.command == "provision":
        provision()
    elif args.command == "status":
        print(compose("ps").decode(), end="")
        print(sql("SELECT datname, pg_get_userbyid(datdba) FROM pg_database WHERE datname IN ('substrate','keycloak','app') ORDER BY 1;"))
    else:
        apply_substrate()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
