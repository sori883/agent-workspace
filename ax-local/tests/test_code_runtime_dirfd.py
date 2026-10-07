from contextlib import ExitStack
import errno
import os
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

from test_code_runtime_watch import launcher


class OwnedDirectoryTests(unittest.TestCase):
    def setup_mocks(self, close_error=False, open_error=False, target_mode=0o700, root_mode=0o555, restore_error=False):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(launcher.os, "geteuid", return_value=0))
        opened = stack.enter_context(patch.object(launcher.os, "open", side_effect=[10, OSError(errno.ELOOP, "symlink")] if open_error else [10, 11]))
        stack.enter_context(patch.object(launcher.os, "fstat", side_effect=[
            SimpleNamespace(st_mode=stat.S_IFDIR | root_mode, st_uid=0, st_gid=0),
            SimpleNamespace(st_mode=stat.S_IFDIR | target_mode, st_uid=launcher.UID, st_gid=launcher.UID),
        ]))
        def close(fd):
            if close_error and fd == 11:
                raise OSError(errno.EIO, "close")
        closed = stack.enter_context(patch.object(launcher.os, "close", side_effect=close))
        def change_uid(uid):
            if restore_error and uid == 0:
                raise OSError(errno.EPERM, "restore")
        changed = stack.enter_context(patch.object(launcher.os, "seteuid", side_effect=change_uid))
        return opened, closed, changed

    def test_fixed_names_relative_nofollow_cloexec_and_restore(self):
        opened, closed, changed = self.setup_mocks()
        with launcher.owned_directory("output") as directory:
            self.assertEqual(directory, 11)
            self.assertEqual(changed.call_args_list, [call(launcher.UID)])
        self.assertEqual(opened.call_args_list, [call(launcher.ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC), call("output", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=10)])
        self.assertEqual(closed.call_args_list, [call(11), call(10)])
        self.assertEqual(changed.call_args_list, [call(launcher.UID), call(0)])

    def test_other_names_rejected_before_open(self):
        with patch.object(launcher.os, "open") as opened:
            for name in ("input", "state", "../output", "/sandbox/output", "output/x", ""):
                with self.subTest(name=name), self.assertRaises(launcher.Rejected):
                    with launcher.owned_directory(name):
                        self.fail("unsafe directory accepted")
            opened.assert_not_called()

    def test_symlink_open_failure_closes_parent_and_restores_uid(self):
        _, closed, changed = self.setup_mocks(open_error=True)
        with self.assertRaises(OSError):
            with launcher.owned_directory("tmp"):
                self.fail("symlink accepted")
        self.assertEqual(closed.call_args_list, [call(10)])
        self.assertEqual(changed.call_args_list, [call(launcher.UID), call(0)])

    def test_close_failure_does_not_skip_uid_restore_or_parent_close(self):
        _, closed, changed = self.setup_mocks(close_error=True)
        with self.assertRaises(OSError):
            with launcher.owned_directory("output"):
                pass
        self.assertEqual(closed.call_args_list, [call(11), call(10)])
        self.assertEqual(changed.call_args_list, [call(launcher.UID), call(0)])

    def test_uid_restore_failure_still_closes_parent(self):
        _, closed, _ = self.setup_mocks(restore_error=True)
        with self.assertRaises(OSError):
            with launcher.owned_directory("output"):
                pass
        self.assertEqual(closed.call_args_list, [call(11), call(10)])

    def test_body_failure_and_wrong_mode_restore_every_resource(self):
        _, closed, changed = self.setup_mocks()
        with self.assertRaises(ValueError):
            with launcher.owned_directory("output"):
                raise ValueError("fixed failure")
        self.assertEqual(closed.call_args_list, [call(11), call(10)])
        self.assertEqual(changed.call_args_list, [call(launcher.UID), call(0)])

    def test_writable_root_rejected_before_uid_change(self):
        _, closed, changed = self.setup_mocks(root_mode=0o777)
        with self.assertRaises(launcher.Rejected):
            with launcher.owned_directory("tmp"):
                self.fail("writable root accepted")
        self.assertEqual(closed.call_args_list, [call(10)])
        changed.assert_not_called()

    def test_wrong_target_mode_closes_both_and_restores_uid(self):
        _, closed, changed = self.setup_mocks(target_mode=0o755)
        with self.assertRaises(launcher.Rejected):
            with launcher.owned_directory("output"):
                self.fail("wrong target mode accepted")
        self.assertEqual(closed.call_args_list, [call(11), call(10)])
        self.assertEqual(changed.call_args_list, [call(launcher.UID), call(0)])


if __name__ == "__main__":
    unittest.main()
