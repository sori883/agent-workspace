import os
import resource
import sys

sys.path.insert(0, "/trusted")
from security import filter_syscalls, verify_privileges


def main():
    phase = "verify"
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
        verify_privileges()
        phase = "environment"
        if os.environ != {"PATH": "/usr/local/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "OPENPYXL_DEFUSEDXML": "True"}:
            raise RuntimeError("unexpected_environment")
        phase = "compile"
        source = open("/input/main.py", "rb").read(4097)
        if len(source) > 4096:
            raise RuntimeError("source_limit")
        compiled = compile(source, "/input/main.py", "exec")
        phase = "seccomp"
        filter_syscalls()
        os.write(3, b"R")
        os.close(3)
    except BaseException as error:
        try:
            os.write(3, ("E:" + phase + ":" + str(getattr(error, "errno", 0))).encode("ascii"))
        finally:
            os._exit(125)
    exec(compiled, {"__name__": "__main__", "__file__": "/input/main.py"})


if __name__ == "__main__":
    main()
