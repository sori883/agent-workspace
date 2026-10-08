#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

from storage import Client, HTTPFailure, ROOT, STATE, StorageError, backup, private_write, read_config, read_private, restore, verify_backup


ROLES = {
    "api": ["s3:GetObject", "s3:PutObject"],
    "controller": ["s3:GetObject"],
    "backup": ["s3:GetObject"],
    "restore": ["s3:GetObject", "s3:PutObject"],
    "maintenance": ["s3:GetObject", "s3:DeleteObject"],
}


def compose(*args):
    result = subprocess.run(["docker", "compose", "-f", str(ROOT / "compose.yaml"), *args],
                            capture_output=True, text=True)
    if result.returncode:
        raise StorageError(f"Docker Compose failed ({result.returncode}); inspect local service status")


def prepare():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    secret_dir = STATE / "secrets"
    secret_dir.mkdir(exist_ok=True, mode=0o700)
    secret_dir.chmod(0o700)
    for name, value in {"root.access-key": secrets.token_hex(12).upper(),
                        "root.secret-key": secrets.token_hex(32)}.items():
        path = secret_dir / name
        if not path.exists():
            private_write(path, (value + "\n").encode())
        read_private(path)
    for role in ROLES:
        path = STATE / f"{role}.env"
        if path.exists():
            read_config(path)
            continue
        endpoint = "http://host.docker.internal:19000" if role == "controller" else "http://127.0.0.1:19000"
        values = {"STORE_ID": "local-skills", "ENDPOINT": endpoint,
                  "BUCKET": "app-skills", "REGION": "us-east-1", "FORCE_PATH_STYLE": "true",
                  "ALLOW_INSECURE_HTTP": "true", "ACCESS_KEY_ID": secrets.token_hex(12).upper(),
                  "SECRET_ACCESS_KEY": secrets.token_hex(32)}
        private_write(path, "".join(f"APP_SKILL_STORAGE_{k}={v}\n" for k, v in values.items()).encode())


def wait_ready():
    client = Client.role("api")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            client.request("GET", "/health", signed=False, timeout=1)
            return
        except StorageError:
            time.sleep(1)
    raise StorageError("RustFS did not become ready within 60 seconds")


def provision():
    config = read_config(STATE / "api.env")
    config["ACCESS_KEY_ID"] = read_private(STATE / "secrets" / "root.access-key")
    config["SECRET_ACCESS_KEY"] = read_private(STATE / "secrets" / "root.secret-key")
    root = Client(config)
    try:
        root.request("PUT", f"/{root.bucket}")
    except HTTPFailure as error:
        if error.status != 409 or error.code != "BucketAlreadyOwnedByYou":
            raise
    try:
        root.request("DELETE", f"/{root.bucket}", query={"policy": ""})
    except HTTPFailure as error:
        if error.status != 404:
            raise
    quota = {"quota": 1024 * 1024 * 1024, "quota_type": "HARD"}
    root.request("PUT", f"/rustfs/admin/v3/quota/{root.bucket}", json.dumps(quota).encode(),
                 headers={"Content-Type": "application/json"})
    for attempt in range(10):
        _, _, quota_body = root.request("GET", f"/rustfs/admin/v3/quota/{root.bucket}")
        if json.loads(quota_body).get("quota") == quota["quota"]:
            break
        if attempt == 9:
            raise StorageError("Bucket quota was not applied")
        time.sleep(1)
    for role, actions in ROLES.items():
        credentials = read_config(STATE / f"{role}.env")
        policy_name = f"ax-app-skills-{role}"
        policy = {"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Action": actions, "Resource": [f"arn:aws:s3:::{root.bucket}/*"]}
        ]}
        if role in {"backup", "restore", "maintenance"}:
            policy["Statement"].append({"Effect": "Allow", "Action": ["s3:ListBucket"],
                                        "Resource": [f"arn:aws:s3:::{root.bucket}"]})
        root.request("PUT", "/rustfs/admin/v3/add-canned-policy", json.dumps(policy).encode(),
                     query={"name": policy_name}, headers={"Content-Type": "application/json"})
        user = {"secretKey": credentials["SECRET_ACCESS_KEY"], "status": "enabled"}
        root.request("PUT", "/rustfs/admin/v3/add-user", json.dumps(user).encode(),
                     query={"accessKey": credentials["ACCESS_KEY_ID"]}, headers={"Content-Type": "application/json"})
        root.request("PUT", "/rustfs/admin/v3/set-user-or-group-policy",
                     query={"policyName": policy_name, "userOrGroup": credentials["ACCESS_KEY_ID"], "isGroup": "false"})


def main():
    parser = argparse.ArgumentParser(description="Manage the local application-only RustFS store without printing credentials")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "start", "provision", "status", "stop", "recreate"):
        commands.add_parser(name)
    for name in ("backup", "restore", "verify-backup"):
        command = commands.add_parser(name)
        command.add_argument("directory", type=Path)
        if name in {"backup", "restore"}:
            command.add_argument("--config", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare()
    elif args.command == "start":
        prepare()
        compose("up", "-d", "--wait", "--wait-timeout", "120")
        wait_ready()
        provision()
    elif args.command == "provision":
        wait_ready()
        provision()
    elif args.command == "recreate":
        compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120")
        wait_ready()
    elif args.command == "stop":
        compose("stop")
    elif args.command == "status":
        wait_ready()
        print(json.dumps({"ready": True, "store_id": "local-skills", "bucket": "app-skills"}))
        return
    else:
        if args.command == "verify-backup":
            manifest = verify_backup(args.directory)
        else:
            client = Client(read_config(args.config)) if args.config else Client.role(args.command)
            manifest = backup(client, args.directory) if args.command == "backup" else restore(client, args.directory)
        print(json.dumps({"command": args.command, "objects": len(manifest["objects"]),
                          "bytes": sum(item["bytes"] for item in manifest["objects"])}))
        return
    print(json.dumps({"command": args.command, "result": "ok"}))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (StorageError, OSError, ValueError, KeyError) as error:
        message = str(error) if isinstance(error, StorageError) else type(error).__name__
        print(f"object-storage: {message}", file=sys.stderr)
        sys.exit(1)
