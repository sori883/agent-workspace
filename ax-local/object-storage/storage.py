from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
STATE = ROOT.parent / ".state" / "object-storage"
PREFIX = "APP_SKILL_STORAGE_"
MAX_OBJECT_BYTES = 1024 * 1024


class StorageError(RuntimeError):
    pass


class HTTPFailure(StorageError):
    def __init__(self, status, code):
        self.status = status
        self.code = code
        super().__init__(f"Object storage returned HTTP {status} ({code})")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_write(path, data):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    with os.fdopen(os.open(path, flags, 0o600), "wb") as handle:
        handle.write(data)


def read_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise StorageError(f"Expected a regular mode-0600 file: {path.name}")
    return path.read_text().strip()


def read_config(path):
    config = {}
    for line in read_private(path).splitlines():
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        if key.startswith(PREFIX):
            config[key[len(PREFIX):]] = value
    return config


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, config):
        self.config = config
        self.endpoint = config["ENDPOINT"].rstrip("/")
        parsed = urllib.parse.urlsplit(self.endpoint)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
            raise StorageError("Endpoint must be an origin without credentials or path")
        if parsed.scheme != "https":
            if not (parsed.scheme == "http" and config.get("ALLOW_INSECURE_HTTP") == "true"
                    and parsed.hostname in {"localhost", "127.0.0.1", "host.docker.internal"}):
                raise StorageError("HTTPS is required outside the explicit local development exception")
        if config.get("FORCE_PATH_STYLE") != "true":
            raise StorageError("This local operations client requires path-style addressing")
        self.host = parsed.netloc
        self.bucket = config["BUCKET"]
        self.region = config["REGION"]
        self.access_key = config["ACCESS_KEY_ID"]
        self.secret_key = config["SECRET_ACCESS_KEY"]
        self.opener = urllib.request.build_opener(NoRedirect())

    @classmethod
    def role(cls, name):
        config = read_config(STATE / f"{name}.env")
        config["ENDPOINT"] = "http://127.0.0.1:19000"
        return cls(config)

    def request(self, method, path, body=b"", query=None, headers=None, signed=True, timeout=30):
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        date = timestamp[:8]
        encoded_path = urllib.parse.quote(path, safe="/~")
        encoded_query = "&".join(f"{urllib.parse.quote(str(k), safe='~')}={urllib.parse.quote(str(v), safe='~')}"
                                 for k, v in sorted((query or {}).items()))
        request_headers = {"host": self.host, "x-amz-date": timestamp,
                           "x-amz-content-sha256": digest(body)}
        request_headers.update({k.lower(): v for k, v in (headers or {}).items()})
        if signed:
            names = ";".join(sorted(request_headers))
            canonical_headers = "".join(f"{k}:{request_headers[k].strip()}\n" for k in sorted(request_headers))
            canonical = "\n".join([method, encoded_path, encoded_query, canonical_headers, names, digest(body)])
            scope = f"{date}/{self.region}/s3/aws4_request"
            to_sign = "\n".join(["AWS4-HMAC-SHA256", timestamp, scope, digest(canonical.encode())])
            key = ("AWS4" + self.secret_key).encode()
            for part in (date, self.region, "s3", "aws4_request"):
                key = hmac.new(key, part.encode(), hashlib.sha256).digest()
            signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
            request_headers["authorization"] = (
                f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, "
                f"SignedHeaders={names}, Signature={signature}")
        url = self.endpoint + encoded_path + ("?" + encoded_query if encoded_query else "")
        request = urllib.request.Request(url, data=body if method in {"PUT", "POST"} else None,
                                         headers=request_headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read(MAX_OBJECT_BYTES + 1)
                if len(data) > MAX_OBJECT_BYTES:
                    raise StorageError("Object or response exceeds the local operations size limit")
                return response.status, {k.lower(): v for k, v in response.headers.items()}, data
        except urllib.error.HTTPError as error:
            code = "request_failed"
            raw = error.read(65536)
            try:
                value = ET.fromstring(raw).findtext("Code")
                if value and re.fullmatch(r"[A-Za-z0-9_]+", value):
                    code = value
            except ET.ParseError:
                pass
            raise HTTPFailure(error.code, code) from None
        except urllib.error.URLError:
            raise StorageError("Object storage connection failed") from None

    def object(self, method, key, body=b"", headers=None, signed=True):
        return self.request(method, f"/{self.bucket}/{key}", body, headers=headers, signed=signed)

    def list_objects(self, prefix=""):
        result = []
        token = None
        namespace = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        while True:
            query = {"list-type": "2", "max-keys": "1000", "prefix": prefix}
            if token:
                query["continuation-token"] = token
            _, _, body = self.request("GET", f"/{self.bucket}", query=query)
            root = ET.fromstring(body)
            for entry in root.findall("s3:Contents", namespace):
                result.append({"key": entry.findtext("s3:Key", namespaces=namespace),
                               "size": int(entry.findtext("s3:Size", namespaces=namespace)),
                               "etag": entry.findtext("s3:ETag", namespaces=namespace)})
            if root.findtext("s3:IsTruncated", namespaces=namespace) != "true":
                return sorted(result, key=lambda item: item["key"])
            next_token = root.findtext("s3:NextContinuationToken", namespaces=namespace)
            if not next_token or next_token == token:
                raise StorageError("Invalid listing continuation token")
            token = next_token


def backup(client, directory, prefix=""):
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    (directory / "objects").mkdir(mode=0o700)
    before = client.list_objects(prefix)
    entries = []
    for item in before:
        _, headers, data = client.object("GET", item["key"])
        if len(data) != item["size"]:
            raise StorageError("Object changed during backup")
        name = digest(item["key"].encode())
        private_write(directory / "objects" / name, data)
        entries.append({"key": item["key"], "blob": name, "bytes": len(data), "sha256": digest(data),
                        "content_type": headers.get("content-type", "application/octet-stream")})
    if client.list_objects(prefix) != before:
        raise StorageError("Bucket changed during backup; no completed manifest was written")
    manifest = {"format": 1, "store_id": client.config["STORE_ID"], "bucket": client.bucket,
                "prefix": prefix, "objects": entries}
    private_write(directory / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
    verify_backup(directory)
    return manifest


def verify_backup(directory):
    manifest = json.loads(read_private(directory / "manifest.json"))
    if manifest.get("format") != 1 or not isinstance(manifest.get("objects"), list):
        raise StorageError("Unsupported backup manifest")
    objects = directory / "objects"
    if objects.is_symlink() or not objects.is_dir():
        raise StorageError("Invalid backup objects directory")
    seen = set()
    for item in manifest["objects"]:
        key = item.get("key")
        if not isinstance(key, str) or not key or key in seen:
            raise StorageError("Invalid or duplicate backup key")
        seen.add(key)
        if item.get("blob") != digest(key.encode()):
            raise StorageError("Invalid backup blob path")
        media_type = item.get("content_type")
        if not isinstance(media_type, str) or not media_type or any(ord(c) < 32 or ord(c) > 126 for c in media_type):
            raise StorageError("Invalid backup media type")
        blob = directory / "objects" / item["blob"]
        info = blob.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_OBJECT_BYTES:
            raise StorageError("Invalid backup blob")
        data = blob.read_bytes()
        if len(data) != item.get("bytes") or digest(data) != item.get("sha256"):
            raise StorageError("Backup object hash or size mismatch")
    return manifest


def restore(client, directory):
    manifest = verify_backup(directory)
    if manifest["bucket"] != client.bucket or manifest["store_id"] != client.config["STORE_ID"]:
        raise StorageError("Backup storage identity differs from target")
    for item in manifest["objects"]:
        data = (directory / "objects" / item["blob"]).read_bytes()
        if digest(data) != item["sha256"]:
            raise StorageError("Backup changed after validation")
        try:
            client.object("PUT", item["key"], data,
                          headers={"If-None-Match": "*", "Content-Type": item["content_type"]})
        except HTTPFailure as error:
            if error.status != 412:
                raise
        _, _, actual = client.object("GET", item["key"])
        if len(actual) != item["bytes"] or digest(actual) != item["sha256"]:
            raise StorageError("Restore conflict: target object differs; no overwrite performed")
    return manifest
