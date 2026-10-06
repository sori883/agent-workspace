#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def fingerprint(prefix, database):
    def query(statement):
        result = subprocess.run([*prefix, "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1",
                                 "-U", "postgres", "-d", database], input=statement.encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        return result.stdout.decode().splitlines()

    tables = query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;")
    result = {"tables": {}, "sequences": {}}
    for name in tables:
        identifier = '"' + name.replace('"', '""') + '"'
        rows = query("SET timezone='UTC'; SET extra_float_digits=3; "
                     f"SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') "
                     f"FROM ONLY public.{identifier} t ORDER BY 1;")
        rows = [row for row in rows if row != "SET"]
        result["tables"][name] = {"count": len(rows), "sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest()}
    for name in query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename;"):
        identifier = '"' + name.replace('"', '""') + '"'
        result["sequences"][name] = query(f"SELECT last_value,is_called FROM public.{identifier};")
    return result


def main():
    parser = argparse.ArgumentParser(description="Compare all public table rows and sequences while writers are stopped")
    parser.add_argument("source", choices=["kubernetes", "docker"])
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    if args.source == "kubernetes":
        prefix = ["kubectl", "--kubeconfig", str(ROOT / "kubeconfig"), "-n", "ate-system",
                  "exec", "-i", "postgres-0", "-c", "postgres", "--"]
    else:
        prefix = ["docker", "exec", "-i", "ax-local-postgres"]
    print(json.dumps(fingerprint(prefix, args.database), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
