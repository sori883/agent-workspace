#!/usr/bin/env python3
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import subprocess
import sys

from manage import ROOT, STATE, compose
from verify import verify

sys.path.insert(0, str(ROOT / "postgres"))
from fingerprint import fingerprint

PREFIX = ["docker", "exec", "-i", "ax-local-postgres"]


def sql(statement):
    result = subprocess.run([*PREFIX, "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
                            input=statement.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if result.returncode:
        raise RuntimeError("Storage verification SQL failed; output withheld")


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def main():
    os.umask(0o077)
    before = verify()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = STATE / "backups" / stamp
    directory.mkdir(parents=True, mode=0o700)
    database = "keycloak_verify_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    backup = directory / "keycloak.dump"
    created = False
    stopping = False
    try:
        stopping = True
        compose("stop")
        with backup.open("xb") as stream:
            result = subprocess.run([*PREFIX, "pg_dump", "-U", "postgres", "-d", "keycloak", "-Fc"],
                                    stdout=stream, stderr=subprocess.PIPE, timeout=180)
            stream.flush()
            os.fsync(stream.fileno())
        if result.returncode:
            raise RuntimeError("Keycloak backup failed; output withheld")
        for name in ["admin.password", "client.secret", "encryption.key", "alice.password", "bob.password", "app.json"]:
            shutil.copyfile(STATE / name, directory / name)
            (directory / name).chmod(0o600)
        source = fingerprint(PREFIX, "keycloak")
        save(directory / "source.json", source)
        sql(f"CREATE DATABASE {database} OWNER ax_keycloak;")
        created = True
        sql(f"REVOKE ALL ON DATABASE {database} FROM PUBLIC;")
        with backup.open("rb") as stream:
            result = subprocess.run([*PREFIX, "pg_restore", "-U", "postgres", "-d", database,
                                     "--role=ax_keycloak", "--no-owner", "--no-privileges", "--single-transaction"],
                                    stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if result.returncode:
            raise RuntimeError("Scratch restore failed; output withheld")
        restored = fingerprint(PREFIX, database)
        save(directory / "restored.json", restored)
        if restored != source or not source["tables"]:
            raise RuntimeError("Restored Keycloak tables or sequences differ")
        sql(f"DROP DATABASE {database};")
        created = False
        compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180")
        stopping = False
        after = verify()
        same_identity = all(before[key] == after[key] for key in ["subjects", "realm_id", "client_id"])
        if not same_identity:
            raise RuntimeError("Realm, client or user identity changed after container recreation")
        result = {"tables_equal": len(source["tables"]), "sequences_equal": len(source["sequences"]),
                  "scratch_database_removed": True, "container_recreated": True, "identities_retained": True,
                  "password_logins_after_recreation": True, "checks": after["checks"],
                  "dump_sha256": hashlib.sha256(backup.read_bytes()).hexdigest()}
        save(directory / "result.json", result)
        print(json.dumps({key: value for key, value in result.items() if key != "dump_sha256"}, indent=2))
        print(f"Private backup and evidence: {directory}")
    finally:
        try:
            if created:
                sql(f"DROP DATABASE {database};")
        finally:
            if stopping:
                compose("up", "-d", "--wait", "--wait-timeout", "180")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Storage verification failed; private evidence retained", file=sys.stderr)
        sys.exit(1)
