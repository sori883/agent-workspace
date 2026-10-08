import json
from pathlib import Path
import tempfile
import unittest

from storage import Client, HTTPFailure, StorageError, backup, digest, private_write, read_private, restore, verify_backup


class MemoryClient:
    bucket = "app-skills"
    config = {"STORE_ID": "local-skills"}

    def __init__(self):
        self.objects = {"workspaces/one/skills/two/revisions/three/SKILL.md": b"original"}
        self.puts = 0
        self.list_calls = 0
        self.change_listing = False

    def list_objects(self, prefix=""):
        self.list_calls += 1
        result = [{"key": key, "size": len(data), "etag": digest(data)}
                  for key, data in sorted(self.objects.items()) if key.startswith(prefix)]
        if self.change_listing and self.list_calls > 1:
            result.append({"key": "later", "size": 1, "etag": "changed"})
        return result

    def object(self, method, key, body=b"", headers=None):
        if method == "PUT":
            self.puts += 1
            if headers.get("If-None-Match") != "*":
                raise AssertionError("Restore must require absent keys")
            if key in self.objects:
                raise HTTPFailure(412, "PreconditionFailed")
            self.objects[key] = body
            return 200, {}, b""
        return 200, {"content-type": "text/markdown"}, self.objects[key]


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "backup"
        self.client = MemoryClient()

    def test_backup_restore_and_replay_preserve_bytes(self):
        original = self.client.objects.copy()
        backup(self.client, self.directory)
        self.client.objects.clear()
        restore(self.client, self.directory)
        restore(self.client, self.directory)
        self.assertEqual(self.client.objects, original)

    def test_corrupt_backup_rejected_before_any_put(self):
        manifest = backup(self.client, self.directory)
        blob = self.directory / "objects" / manifest["objects"][0]["blob"]
        blob.write_bytes(b"corrupt")
        with self.assertRaisesRegex(StorageError, "hash or size mismatch"):
            restore(self.client, self.directory)
        self.assertEqual(self.client.puts, 0)

    def test_conflicting_target_is_not_overwritten(self):
        backup(self.client, self.directory)
        key = next(iter(self.client.objects))
        self.client.objects[key] = b"other revision"
        with self.assertRaisesRegex(StorageError, "Restore conflict"):
            restore(self.client, self.directory)
        self.assertEqual(self.client.objects[key], b"other revision")

    def test_unstable_listing_leaves_no_completed_manifest(self):
        self.client.change_listing = True
        with self.assertRaisesRegex(StorageError, "Bucket changed"):
            backup(self.client, self.directory)
        self.assertFalse((self.directory / "manifest.json").exists())

    def test_manifest_cannot_select_external_file(self):
        manifest = backup(self.client, self.directory)
        manifest["objects"][0]["blob"] = "../../secret"
        (self.directory / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(StorageError, "Invalid backup blob path"):
            verify_backup(self.directory)

    def test_secret_permissions_are_enforced(self):
        path = Path(self.temporary.name) / "credential"
        private_write(path, b"not-a-real-key")
        self.assertEqual(read_private(path), "not-a-real-key")
        path.chmod(0o644)
        with self.assertRaisesRegex(StorageError, "mode-0600"):
            read_private(path)

    def test_http_requires_local_explicit_exception(self):
        config = {"ENDPOINT": "http://objects.example.test", "ALLOW_INSECURE_HTTP": "true"}
        with self.assertRaisesRegex(StorageError, "HTTPS is required"):
            Client(config)
        config["ENDPOINT"] = "http://127.0.0.1:19000"
        config["ALLOW_INSECURE_HTTP"] = "false"
        with self.assertRaisesRegex(StorageError, "HTTPS is required"):
            Client(config)


if __name__ == "__main__":
    unittest.main()
