import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("code_launcher_under_test", Path(__file__).resolve().parents[1] / "code_runtime/launcher.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class DrainingSelector:
    def __init__(self):
        self.registered = {}
        self.events = iter((102, 100, 100, 100, 100, 101, 102))

    def register(self, fd, event):
        self.registered[fd] = event

    def unregister(self, fd):
        del self.registered[fd]

    def select(self, timeout):
        return [(SimpleNamespace(fd=next(self.events)), 1)]

    def get_map(self):
        return self.registered

    def close(self):
        pass


class WatchTests(unittest.TestCase):
    def test_excess_log_is_failure_after_child_already_exited(self):
        chunks = {100: iter((b"a" * 4096, b"b" * 4096, b"c", b"")), 101: iter((b"",)), 102: iter((b"R", b""))}
        with patch.object(launcher.selectors, "DefaultSelector", DrainingSelector), patch.object(launcher.os, "set_blocking"), patch.object(launcher.os, "close"), patch.object(launcher.os, "read", side_effect=lambda fd, _: next(chunks[fd])), patch.object(launcher.os, "waitpid", return_value=(123, 0)), patch.object(launcher.os, "kill") as kill:
            status, reason, ready, log = launcher.watch(123, 100, 101, 102)
        self.assertEqual(status, 0)
        self.assertEqual(reason, "log_limit")
        self.assertEqual(ready, b"R")
        self.assertEqual(len(log), 8192)
        kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
