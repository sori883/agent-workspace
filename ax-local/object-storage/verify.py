#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path

from manage import compose, wait_ready
from storage import Client, HTTPFailure, STATE, StorageError, backup, digest, restore


def denied(operation):
    try:
        operation()
    except HTTPFailure as error:
        if error.status == 403:
            return
        raise
    raise StorageError("Expected HTTP 403 permission denial")


def verify(recreate=False):
    clients = {role: Client.role(role) for role in ("api", "controller", "backup", "restore", "maintenance")}
    api, controller = clients["api"], clients["controller"]
    key = f"_infra-contract/{secrets.token_hex(12)}/SKILL.md"
    data = b"---\nname: infra-contract\ndescription: contract test\n---\nRead-only original.\n"
    passed = []
    try:
        api.object("PUT", key, data, headers={"If-None-Match": "*", "Content-Type": "text/markdown"})
        for role in ("api", "controller", "backup", "restore"):
            _, _, actual = clients[role].object("GET", key)
            if digest(actual) != digest(data):
                raise StorageError("Downloaded bytes differ from original")
            _, headers, _ = clients[role].object("HEAD", key)
            if int(headers["content-length"]) != len(data):
                raise StorageError("HEAD length differs from original")
        passed.append("api_put_get_head_and_reader_sha256")
        denied(lambda: api.object("GET", key, signed=False))
        denied(lambda: api.request("GET", f"/{api.bucket}", query={"list-type": "2"}, signed=False))
        passed.append("anonymous_get_and_list_denied")
        for role in ("controller", "backup", "maintenance"):
            denied(lambda role=role: clients[role].object("PUT", key, b"changed"))
        for role in ("api", "controller", "backup", "restore"):
            denied(lambda role=role: clients[role].object("DELETE", key))
        for role in ("api", "controller"):
            denied(lambda role=role: clients[role].list_objects())
            denied(lambda role=role: clients[role].request("GET", "/rustfs/admin/v3/list-users"))
        passed.append("roles_deny_put_delete_list_and_admin")
        try:
            api.object("PUT", key, b"changed", headers={"If-None-Match": "*"})
        except HTTPFailure as error:
            if error.status != 412:
                raise
        else:
            raise StorageError("Conditional PUT overwrote an existing key")
        passed.append("conditional_put_conflict")
        if recreate:
            compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120")
            wait_ready()
            if controller.object("GET", key)[2] != data:
                raise StorageError("Object or IAM did not survive container recreation")
            denied(lambda: controller.object("PUT", key, b"changed"))
            passed.append("container_recreate_preserves_object_and_iam")
        with tempfile.TemporaryDirectory(prefix="verify-", dir=STATE) as temporary:
            directory = Path(temporary) / "backup"
            manifest = backup(clients["backup"], directory, prefix=key.rsplit("/", 1)[0] + "/")
            clients["maintenance"].object("DELETE", key)
            restore(clients["restore"], directory)
            if controller.object("GET", key)[2] != data:
                raise StorageError("Restored object differs")
            restore(clients["restore"], directory)
            passed.append("backup_restore_sha256_and_idempotent_replay")
            blob = directory / "objects" / manifest["objects"][0]["blob"]
            blob.write_bytes(b"corrupt")
            try:
                restore(clients["restore"], directory)
            except StorageError as error:
                if "hash or size mismatch" not in str(error):
                    raise
            else:
                raise StorageError("Corrupted backup was accepted")
            if controller.object("GET", key)[2] != data:
                raise StorageError("Corrupt backup changed target")
            passed.append("corrupt_backup_rejected_before_put")
    finally:
        clients["maintenance"].object("DELETE", key)
    return {"passed": passed, "model_calls": 0, "container_recreated": recreate}


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--recreate", action="store_true", help="Recreate only ax-app-objects to test its persistent volume")
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.recreate), indent=2))
    except (StorageError, OSError, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, StorageError) else type(error).__name__
        print(f"object-storage verification: {message}", file=sys.stderr)
        sys.exit(1)
