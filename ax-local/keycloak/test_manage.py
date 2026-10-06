import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import manage


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.state = root / "auth"
        pg = root / "postgres"
        pg.mkdir()
        (pg / "app.password").write_text("test-app-password")
        (pg / "ca.crt").write_text("test-ca")
        self.enterContext(patch.object(manage, "STATE", self.state))
        self.enterContext(patch.object(manage, "PG_SECRETS", pg))
        self.database = self.enterContext(patch.object(manage, "command", return_value=b"0\n"))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))

    def test_repeat_initialization_preserves_every_credential(self):
        manage.initialize()
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        manage.initialize()
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.state.iterdir()})
        self.assertEqual(self.database.call_count, 1)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in self.state.iterdir()))

    def test_missing_auth_files_with_existing_database_refuses_generation(self):
        self.database.return_value = b"101\n"
        with self.assertRaisesRegex(RuntimeError, "DB already contains data"):
            manage.initialize()
        self.assertFalse(self.state.exists())

    def test_missing_credential_is_not_regenerated(self):
        manage.initialize()
        (self.state / "client.secret").unlink()
        before = {path.name: path.read_bytes() for path in self.state.iterdir()}
        with self.assertRaisesRegex(RuntimeError, "Incomplete auth files"):
            manage.initialize()
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.state.iterdir()})

    def test_mismatched_app_config_is_not_replaced(self):
        manage.initialize()
        path = self.state / "app.json"
        config = json.loads(path.read_text())
        config["encryptionKey"] = "different-key"
        path.write_text(json.dumps(config))
        before = {item.name: item.read_bytes() for item in self.state.iterdir()}
        with self.assertRaisesRegex(RuntimeError, "app.json differs"):
            manage.initialize()
        self.assertEqual(before, {item.name: item.read_bytes() for item in self.state.iterdir()})


if __name__ == "__main__":
    unittest.main()
