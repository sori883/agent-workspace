from contextlib import ExitStack, nullcontext
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import test_code_runtime as runtime_tests
import test_code_runtime_watch as watch_tests


launcher = watch_tests.launcher


class HostLayoutTests(unittest.TestCase):
    def layout(self, change=None, default_profile=False, profile="host-quota-v1"):
        mounts = {
            "/sandbox/input": [65536, 16, 0, 0, 0o755],
            "/sandbox/tmp": [8388608, 128, 65532, 65532, 0o700],
            "/sandbox/output": [1048576, 32, 65532, 65532, 0o700],
            "/var/lib/ax-code": [65536, 32, 0, 0, 0o700],
        }
        if profile == "host-quota-8m-v1":
            mounts["/sandbox/input"][0] = 8404992
            mounts["/sandbox/output"][0] = 8400896
            mounts["/var/lib/ax-code"][0] = 262144
        filesystems = {name: "9p" for name in mounts}
        options = {name: "rw,nosuid,noexec" for name in mounts}
        contents = {name: [] for name in mounts}
        if change:
            change(mounts, filesystems, options, contents)
        mountinfo = "\n".join(f"1 0 0:1 / {name} {options[name]} - {filesystems[name]} none rw" for name in filesystems)

        def info(path):
            record = mounts.get(str(path), [0, 0, 0, 0, 0o555])
            return SimpleNamespace(st_mode=stat.S_IFDIR | record[4], st_uid=record[2], st_gid=record[3])

        def capacity(path):
            record = mounts[str(path)]
            return SimpleNamespace(f_blocks=record[0] // 4096, f_frsize=4096, f_files=record[1])

        with ExitStack() as stack:
            stack.enter_context(patch.object(launcher, "verify_parent_capabilities"))
            stack.enter_context(patch.object(Path, "lstat", info))
            stack.enter_context(patch.object(Path, "read_text", return_value=mountinfo))
            stack.enter_context(patch.object(launcher.os, "statvfs", side_effect=capacity))
            stack.enter_context(patch.object(launcher.os, "listdir", side_effect=lambda path: contents[str(path)]))
            stack.enter_context(patch.object(launcher.os, "seteuid"))
            stack.enter_context(patch.object(launcher, "owned_directory", side_effect=lambda name: nullcontext(launcher.ROOT / name)))
            launcher.verify_layout("docker-tmpfs-v1" if default_profile else profile)

    def test_exact_host_profile_includes_parent_state(self):
        self.layout()

    def test_every_host_mount_rejects_wrong_quota_owner_mode_or_contents(self):
        for name in ("/sandbox/input", "/sandbox/tmp", "/sandbox/output", "/var/lib/ax-code"):
            for index, value in ((0, 16384), (1, 1003178), (2, 1), (3, 1), (4, 0o777)):
                with self.subTest(mount=name, field=index):
                    with self.assertRaises(launcher.Rejected):
                        self.layout(lambda mounts, *rest: mounts[name].__setitem__(index, value))
            for field in ("missing", "filesystem", "nosuid", "noexec", "nonempty"):
                with self.subTest(mount=name, field=field):
                    def change(mounts, filesystems, options, contents):
                        if field == "missing": del filesystems[name]
                        elif field == "filesystem": filesystems[name] = "tmpfs"
                        elif field == "nonempty": contents[name] = ["old"]
                        else: options[name] = options[name].replace("," + field, "")
                    with self.assertRaises(launcher.Rejected):
                        self.layout(change)

    def test_8m_profile_requires_its_exact_mounts(self):
        self.layout(profile="host-quota-8m-v1")
        for name in ("/sandbox/input", "/sandbox/output", "/var/lib/ax-code"):
            with self.subTest(name=name):
                with self.assertRaises(launcher.Rejected):
                    self.layout(lambda mounts,*rest: mounts[name].__setitem__(0,65536), profile="host-quota-8m-v1")

    def test_default_does_not_accept_host_profile(self):
        with self.assertRaises(launcher.Rejected):
            self.layout(default_profile=True)


@unittest.skipUnless(runtime_tests.IMAGE, "AX_CODE_IMAGE is required for Linux isolation tests")
class DockerProfileTests(unittest.TestCase):
    run_code = runtime_tests.CodeRuntimeTests.run_code

    def test_host_profile_rejects_docker_tmpfs_before_code(self):
        result = self.run_code("open('/output/result.txt','w').write('ran')", launcher_args=["--profile", "host-quota-v1"])
        self.assertEqual(result["status"], "setup_failed", result)
        self.assertEqual(result["code"], "unsafe_mount", result)
        self.assertFalse(result["isolation_ready"])
        self.assertEqual(result["outputs"], [])

    def test_unknown_or_extra_arguments_are_rejected(self):
        for arguments in (["--profile", "other"], ["--profile"], ["--unknown"], ["--profile", "docker-tmpfs-v1", "extra"]):
            with self.subTest(arguments=arguments):
                result = self.run_code("open('/output/result.txt','w').write('ran')", launcher_args=arguments)
                self.assertEqual(result["code"], "invalid_profile", result)
                self.assertFalse(result["isolation_ready"])

    def test_explicit_docker_profile_and_environment_cannot_select_host(self):
        for arguments in ([], ["--profile", "docker-tmpfs-v1"]):
            with self.subTest(arguments=arguments):
                result = self.run_code("open('/output/result.txt','w').write('ok')", launcher_args=arguments, extra=["-e", "AX_CODE_PROFILE=host-quota-v1"])
                self.assertEqual(result["status"], "succeeded", result)


if __name__ == "__main__":
    unittest.main()
