import base64
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

import test_code_runtime as contract


NODE = os.environ.get("AX_CODE_RUNSC_NODE")
BUNDLE = os.environ.get("AX_CODE_RUNSC_BUNDLE", "")
RUNSC = os.environ.get("AX_CODE_RUNSC_PATH", "")
LAUNCHER = ["/usr/local/bin/python3", "-I", "-B", "/opt/ax-code/launcher.py", "--profile", "host-quota-v1"]
CAPS = ["CAP_" + name for name in ("KILL", "SYS_CHROOT", "SETUID", "SETGID", "SETPCAP")]
MOUNTS = {
    "input": ("/sandbox/input", 65536, 16, 0, "755"),
    "tmp": ("/sandbox/tmp", 8388608, 128, 65532, "700"),
    "output": ("/sandbox/output", 1048576, 32, 65532, "700"),
    "state": ("/var/lib/ax-code", 65536, 32, 0, "700"),
}


@unittest.skipUnless(NODE and BUNDLE and RUNSC, "explicit disposable runsc bundle is required")
class RunscCodeRuntimeTests(contract.CodeRuntimeTests):
    dirty = False

    @classmethod
    def setUpClass(cls):
        if not re.fullmatch(r"/var/lib/ax-code-runsc-[a-z0-9-]+", BUNDLE):
            raise ValueError("bundle must be a dedicated /var/lib/ax-code-runsc-* directory")
        if not RUNSC.startswith("/var/lib/ateom-gvisor/static-files/gvisor-") or not RUNSC.endswith("/runsc"):
            raise ValueError("use the installed fixed AX runsc")
        cls.node("test", "-f", BUNDLE + "/rootfs/opt/ax-code/launcher.py")
        if cls.node("realpath", "-e", BUNDLE).stdout.decode().strip() != BUNDLE:
            raise ValueError("bundle must not contain a symlink")
        cls.node("mkdir", "-p", BUNDLE + "/host-quota")
        cls.verify_idle()

    @classmethod
    def verify_idle(cls, require_unmounted=True):
        states = cls.node(RUNSC, "--root", BUNDLE + "/state-contract", "list", "--format=json")
        if json.loads(states.stdout):
            cls.dirty = True
            raise RuntimeError("runsc state is not empty; preserve the bundle")
        processes = cls.node("ps", "-ww", "-eo", "pid=,args=").stdout.decode().splitlines()
        if any(BUNDLE in row for row in processes):
            cls.dirty = True
            raise RuntimeError("owned runsc process remains; preserve the bundle")
        if require_unmounted:
            mounts = cls.node("findmnt", "--raw", "--noheadings", "--output", "TARGET").stdout.decode().splitlines()
            if any(path.startswith(BUNDLE + "/host-quota/") for path in mounts):
                cls.dirty = True
                raise RuntimeError("old quota mount remains; preserve the bundle")

    @classmethod
    def node(cls, *args, input=None, check=True, timeout=30):
        try:
            return subprocess.run(["docker", "exec", "-i", NODE, *args], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check, timeout=timeout)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            cls.dirty = True
            raise

    def run_code(self, source, inputs=None, outputs=None, omit_cap=None, omit_mount=None, extra=None, driver=None, profile="host-quota-v1"):
        if type(self).dirty:
            raise RuntimeError("earlier cleanup is unconfirmed; no further probe may start")
        type(self).verify_idle()
        capabilities = [cap for cap in CAPS if cap != "CAP_" + str(omit_cap)]
        args = LAUNCHER[:-1] + [profile]
        if driver:
            driver = driver.replace("'/opt/ax-code/launcher.py']", "'/opt/ax-code/launcher.py','--profile','host-quota-v1']")
            args = ["/usr/local/bin/python3", "-I", "-B", "-c", driver]
        spec = {
            "ociVersion": "1.2.0",
            "root": {"path": "rootfs", "readonly": True},
            "process": {
                "terminal": False, "user": {"uid": 0, "gid": 0}, "args": args,
                "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"], "cwd": "/",
                "capabilities": {"bounding": capabilities, "effective": capabilities, "permitted": capabilities, "inheritable": [], "ambient": []},
                "noNewPrivileges": True,
                "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 1024, "soft": 1024}],
            },
            "mounts": [
                {"destination": "/proc", "type": "proc", "source": "proc", "options": ["nosuid", "noexec", "nodev"]},
                {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "mode=755", "size=65536"]},
            ],
            "linux": {"namespaces": [{"type": name} for name in ("pid", "ipc", "uts", "mount", "network")]},
        }
        options = iter(extra or [])
        for option in options:
            value = next(options)
            if option == "-e":
                spec["process"]["env"].append(value)
            elif option == "--security-opt" and value.startswith("seccomp=") and Path(value.removeprefix("seccomp=")).name == "deny-seccomp-test.json":
                failure_driver = """import ctypes,os,sys
sys.path.insert(0,'/opt/ax-code')
from security import ArgCompare
s=ctypes.CDLL('libseccomp.so.2',use_errno=True)
s.seccomp_init.argtypes=[ctypes.c_uint32];s.seccomp_init.restype=ctypes.c_void_p
s.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p];s.seccomp_syscall_resolve_name.restype=ctypes.c_int
s.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
s.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(ArgCompare)]
s.seccomp_load.argtypes=[ctypes.c_void_p];s.seccomp_release.argtypes=[ctypes.c_void_p]
c=s.seccomp_init(0x7fff0000);assert c
assert s.seccomp_rule_add(c,0x50001,s.seccomp_syscall_resolve_name(b'seccomp'),0)==0
arg=ArgCompare(0,4,22,0)
assert s.seccomp_rule_add_array(c,0x50001,s.seccomp_syscall_resolve_name(b'prctl'),1,ctypes.byref(arg))==0
assert s.seccomp_load(c)==0
s.seccomp_release(c)
"""
                failure_driver += "os.execv('/usr/local/bin/python3'," + repr(LAUNCHER) + ")"
                spec["process"]["args"] = ["/usr/local/bin/python3", "-I", "-B", "-c", failure_driver]
            else:
                raise ValueError("unsupported probe option")
        request = {"version": 1, "source": source, "inputs": {name: base64.b64encode(data).decode() for name, data in (inputs or {}).items()}, "outputs": outputs or ["result.txt"]}
        mounted = []
        attempted_run = False
        run_completed = False
        try:
            for name, (destination, size, inodes, uid, mode) in MOUNTS.items():
                if name == omit_mount:
                    continue
                path = BUNDLE + "/host-quota/" + name
                self.node("mkdir", "-p", path)
                self.assertEqual(self.node("realpath", "-e", path).stdout.decode().strip(), path)
                self.assertEqual(self.node("mountpoint", "-q", path, check=False).returncode, 32, "old probe mount exists")
                self.node("mount", "-t", "tmpfs", "-o", f"nosuid,nodev,noexec,size={size},nr_inodes={inodes},uid={uid},gid={uid},mode={mode}", "tmpfs", path)
                mounted.append(path)
                fs = self.node("findmnt", "-n", "-o", "FSTYPE,OPTIONS", "--mountpoint", path).stdout.decode().split()
                self.assertEqual(fs[0], "tmpfs")
                self.assertTrue({"nosuid", "nodev", "noexec"}.issubset(fs[1].split(",")))
                statfs = self.node("stat", "-f", "-c", "%b %S %c", path).stdout.decode().split()
                self.assertEqual(int(statfs[0]) * int(statfs[1]), size)
                self.assertEqual(int(statfs[2]), inodes)
                if name == "input":
                    device = path + "/nodev-probe"
                    self.node("mknod", device, "c", "1", "3")
                    opened = self.node("cat", device, check=False)
                    self.node("rm", "--", device)
                    self.assertEqual(opened.returncode, 1)
                    self.assertIn(b"Permission denied", opened.stderr)
                spec["mounts"].append({"destination": destination, "type": "bind", "source": path, "options": ["bind", "nosuid", "nodev", "noexec"]})
            self.node("tee", BUNDLE + "/config.json", input=json.dumps(spec).encode())
            attempted_run = True
            result = self.node(RUNSC, "--root", BUNDLE + "/state-contract", "--network=none", "--ignore-cgroups", "run", "--bundle", BUNDLE, "code-contract", input=json.dumps(request).encode(), check=False, timeout=25)
            run_completed = result.returncode == 0
            self.assertEqual(result.returncode, 0, result.stderr.decode()[:1000])
            return json.loads(result.stdout)
        finally:
            try:
                if type(self).dirty or (attempted_run and not run_completed):
                    raise RuntimeError("node operation completion unknown; preserve the bundle and mounts")
                if attempted_run:
                    deleted = self.node(RUNSC, "--root", BUNDLE + "/state-contract", "delete", "--force", "code-contract", check=False)
                    if deleted.returncode and b"does not exist" not in deleted.stderr:
                        raise RuntimeError("runsc cleanup unconfirmed: " + deleted.stderr.decode()[:1000])
                    type(self).verify_idle(require_unmounted=False)
                for path in reversed(mounted):
                    self.node("umount", path)
                    self.assertEqual(self.node("mountpoint", "-q", path, check=False).returncode, 32)
            except BaseException:
                type(self).dirty = True
                raise

    def test_devices_and_parent_process_access_denied(self):
        source = """import os,stat,ctypes
for p in ['/tmp/dev','/output/dev']:
 try: os.mknod(p,stat.S_IFCHR|0o600,os.makedev(1,3))
 except OSError: pass
 else: raise AssertionError('device created')
c=ctypes.CDLL(None,use_errno=True)
assert c.process_vm_readv(os.getppid(),0,0,0,0,0)==-1
assert c.process_vm_writev(os.getppid(),0,0,0,0,0)==-1
open('/output/result.txt','w').write('denied')
"""
        self.assertEqual(self.artifact(self.run_code(source)), b"denied")


RunscCodeRuntimeTests.__unittest_skip__ = not bool(NODE and BUNDLE and RUNSC)


if __name__ == "__main__":
    unittest.main()
