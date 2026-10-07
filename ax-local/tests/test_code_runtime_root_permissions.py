import os
import subprocess
import unittest
from unittest.mock import patch

import test_code_runtime_8m as eight


IMAGE = os.environ.get("AX_CODE_ROOT700_IMAGE")
LAYOUT = r'''import os,stat,sys
from pathlib import Path
sys.path.insert(0,'/opt/ax-code')
import launcher
assert stat.S_IMODE(os.stat('/root700').st_mode)==0o700
assert launcher.ROOT==Path('/root700/sandbox')
read_text=Path.read_text
def mountinfo(path,*args,**kwargs):
 value=read_text(path,*args,**kwargs)
 return value.replace(' - tmpfs ',' - 9p ') if str(path)=='/proc/self/mountinfo' else value
Path.read_text=mountinfo
before=set(os.listdir('/proc/self/fd'))
launcher.verify_layout('host-quota-8m-v1')
assert os.geteuid()==0 and set(os.listdir('/proc/self/fd'))==before
print('layout_verified')
'''


@unittest.skipUnless(IMAGE, "AX_CODE_ROOT700_IMAGE must use /root700/sandbox below a root-owned 0700 ancestor")
class RootPermissionTests(unittest.TestCase):
    invoke = eight.EightMiBTests.invoke

    def setUp(self):
        self.image = patch.object(eight, "IMAGE", IMAGE)
        self.image.start()
        self.addCleanup(self.image.stop)
        run = subprocess.run
        def relocated(args, *positional, **kwargs):
            if args[:2] == ["docker", "run"]:
                args = [value.replace("/sandbox/", "/root700/sandbox/", 1) if value.startswith("/sandbox/") else value for value in args]
            return run(args, *positional, **kwargs)
        replace = patch.object(subprocess, "run", side_effect=relocated)
        replace.start()
        self.addCleanup(replace.stop)

    def test_initial_layout_under_restricted_root(self):
        args = ["docker", "run", "--rm", "--network", "none", "--read-only", "--pids-limit", "16", "--memory", "384m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]
        for cap in ("KILL", "SYS_CHROOT", "SETUID", "SETGID", "SETPCAP"):
            args += ["--cap-add", cap]
        for path, options in (("/sandbox/input", "size=8404992,nr_inodes=16,uid=0,gid=0,mode=755"), ("/sandbox/tmp", "size=8m,nr_inodes=128,uid=65532,gid=65532,mode=700"), ("/sandbox/output", "size=8400896,nr_inodes=32,uid=65532,gid=65532,mode=700"), ("/var/lib/ax-code", "size=256k,nr_inodes=32,uid=0,gid=0,mode=700")):
            args += ["--tmpfs", path + ":nosuid,nodev,noexec," + options]
        args += ["--entrypoint", "python3", IMAGE, "-I", "-B", "-c", LAYOUT]
        result = subprocess.run(args, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(result.stdout.strip(), "layout_verified")

    def test_csv_rpc_collect_seal_and_output_read_under_restricted_root(self):
        eight.EightMiBTests.test_csv_aggregate_and_xlsx_library(self)

    def test_four_file_boundary_under_restricted_root(self):
        eight.EightMiBTests.test_four_unaligned_files_exact_logical_limit(self)


if __name__ == "__main__":
    unittest.main()
