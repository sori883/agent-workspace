#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from fingerprint import fingerprint
from manage import CONTAINER, ROOT, STATE, apply_substrate, run, sql

sys.path.insert(0, str(ROOT))
from task_cli import TaskCLI

KUBE = ["kubectl", "--kubeconfig", str(ROOT / "kubeconfig"), "-n", "ate-system"]
OLD = [*KUBE, "exec", "-i", "postgres-0", "-c", "postgres", "--"]
NEW = ["docker", "exec", "-i", CONTAINER]


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = stream.name
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def backup(directory):
    path = directory / "atepg.dump"
    with path.open("xb") as stream:
        result = subprocess.run([*OLD, "pg_dump", "-U", "postgres", "-d", "atepg", "-Fc"],
                                stdout=stream, stderr=subprocess.PIPE, timeout=180)
    (directory / "dump.stderr").write_bytes(result.stderr)
    if result.returncode:
        raise RuntimeError("Backup failed; cutover prohibited")
    save(directory / "dump.json", {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return path


def restore(path, database):
    with path.open("rb") as stream:
        result = subprocess.run([*NEW, "pg_restore", "-U", "postgres", "-d", database,
                                 "--role=ax_substrate", "--no-owner", "--no-privileges", "--single-transaction"],
                                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    (path.parent / f"restore-{database}.stderr").write_bytes(result.stderr)
    if result.returncode:
        raise RuntimeError("Restore failed; cutover prohibited (no partial transaction committed)")


def rehearse(directory):
    path = backup(directory)
    database = "substrate_rehearsal_" + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    sql(f"CREATE DATABASE {database} OWNER ax_substrate;")
    sql(f"REVOKE ALL ON DATABASE {database} FROM PUBLIC;")
    restore(path, database)
    result = fingerprint(NEW, database)
    save(directory / "restored.json", result)
    if not result["tables"]:
        raise RuntimeError("Rehearsal restored no tables")
    sql(f"DROP DATABASE {database};")
    save(directory / "result.json", {"phase": "rehearsal-restored", "tables": len(result["tables"]), "scratch_database_removed": True})
    print(f"Rehearsal restored {len(result['tables'])} tables; private backup: {directory}")


def cutover(directory):
    cli = TaskCLI()
    with cli.locked():
        for receipt in cli.runs.glob("*/receipt.json"):
            if not json.loads(receipt.read_text()).get("resolved"):
                raise RuntimeError("Unresolved local run; do not stop the API")
        tasks = run(["bash", str(ROOT / "ax"), "get", "tasks", "-a", "ax-demo"]).decode()
        if any(len(line.split()) < 3 or line.split()[2] != "Suspended" for line in tasks.splitlines()[1:] if line.strip()):
            raise RuntimeError("AX has a non-suspended task; do not stop the API")
        (directory / "tasks-before.txt").write_text(tasks)
        if sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';", "substrate") != "0":
            raise RuntimeError("Destination is not empty; automatic overwrite prohibited")
        deployment = json.loads(run([*KUBE, "get", "deployment", "ate-api-server", "-o", "json"]))
        replicas = deployment["spec"]["replicas"]
        if replicas < 1:
            raise RuntimeError("API is already stopped; inspect the previous migration first")
        save(directory / "original-deployment.json", deployment)
        for kind, name in [("configmap", "ate-api-server-envvars"), ("secret", "ate-api-server-secret-envvars"), ("secret", "postgres-server-ca")]:
            raw = run([*KUBE, "get", kind, name, "--ignore-not-found", "-o", "json"])
            save(directory / f"original-{name}.json", json.loads(raw) if raw else None)
        save(directory / "progress.json", {"phase": "stopping-api", "original_replicas": replicas})
        run([*KUBE, "scale", "deployment", "ate-api-server", "--replicas=0"])
        run([*KUBE, "wait", "--for=delete", "pod", "-l", "app=ate-api-server", "--timeout=120s"])
        sessions = run([*OLD, "psql", "-X", "-At", "-U", "postgres", "-d", "atepg", "-c",
                        "SELECT count(*) FROM pg_stat_activity WHERE datname='atepg' AND pid<>pg_backend_pid() AND backend_type='client backend';"])
        if sessions.strip() != b"0":
            raise RuntimeError("Old DB still has client sessions; API remains stopped")
        before = fingerprint(OLD, "atepg")
        save(directory / "source.json", before)
        path = backup(directory)
        if fingerprint(OLD, "atepg") != before:
            raise RuntimeError("Source changed during backup; API remains stopped")
        restore(path, "substrate")
        restored = fingerprint(NEW, "substrate")
        save(directory / "restored.json", restored)
        if before != restored:
            raise RuntimeError("Restored tables or sequences differ; API remains stopped")
        sql("BEGIN; TRUNCATE public.worker_outbox, public.worker_outbox_trim; COMMIT;", "substrate")
        reset = fingerprint(NEW, "substrate")
        save(directory / "after-outbox-reset.json", reset)
        for name, expected in before["tables"].items():
            if name == "worker_outbox" or name.startswith("worker_outbox_"):
                if reset["tables"][name]["count"] != 0:
                    raise RuntimeError("Outbox reset incomplete")
            elif reset["tables"].get(name) != expected:
                raise RuntimeError("Primary table changed during outbox reset")
        if reset["sequences"] != before["sequences"]:
            raise RuntimeError("Sequence changed during outbox reset")
        owners = sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner<>'ax_substrate';", "substrate")
        if owners != "0":
            raise RuntimeError("Restored object owner is incorrect")
        save(directory / "progress.json", {"phase": "verified-before-connection-change", "original_replicas": replicas})
        apply_substrate()
        with (directory / "NO_AUTOMATIC_ROLLBACK").open("x") as marker:
            marker.write("New API startup may write to this database. Never switch to the old snapshot automatically.\n")
            marker.flush()
            os.fsync(marker.fileno())
        sync_directory(directory)
        save(directory / "progress.json", {"phase": "new-api-starting-no-automatic-rollback", "original_replicas": replicas})
        run([*KUBE, "scale", "deployment", "ate-api-server", f"--replicas={replicas}"])
        run([*KUBE, "rollout", "status", "deployment/ate-api-server", "--timeout=180s"])
        save(directory / "progress.json", {"phase": "new-api-ready", "original_replicas": replicas})
        save(directory / "result.json", {"phase": "new-api-ready", "tables_equal": len(before["tables"]),
                                          "sequences_equal": len(before["sequences"]), "outbox_reset": True,
                                          "primary_tables_unchanged_by_reset": True, "paid_model_calls": 0})
        print(f"Migration verified; API ready; private backup: {directory}")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Migrate the pinned local kind Substrate DB; read README.md before cutover")
    parser.add_argument("command", choices=["rehearse", "cutover"])
    args = parser.parse_args()
    directory = STATE / "backups" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + args.command)
    directory.mkdir(parents=True, mode=0o700)
    try:
        if args.command == "rehearse":
            rehearse(directory)
        else:
            cutover(directory)
    except Exception as error:
        print(f"Migration stopped. Inspect private progress at {directory}. Do not restart or switch databases blindly.", file=sys.stderr)
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
