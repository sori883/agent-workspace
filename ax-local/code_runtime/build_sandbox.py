import ctypes.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sysconfig


root = Path("/sandbox")
root.mkdir()
stdlib = Path(sysconfig.get_path("stdlib"))
shutil.copytree(stdlib, root / stdlib.relative_to("/"), ignore=shutil.ignore_patterns("site-packages", "__pycache__", "test", "tests", "idlelib", "ensurepip"))
shutil.copytree("/code-deps", root / stdlib.relative_to("/") / "site-packages", ignore=shutil.ignore_patterns("__pycache__", "bin"))
binary = Path("/usr/local/bin/python3.12")
(root / "usr/local/bin").mkdir(parents=True)
shutil.copy2(binary, root / binary.relative_to("/"))
(root / "usr/local/bin/python3").symlink_to("python3.12")
libraries = {Path("/usr/local/lib/libpython3.12.so.1.0")}
for target in [binary, *stdlib.glob("lib-dynload/*.so")]:
    output = subprocess.check_output(["ldd", str(target)], text=True)
    libraries.update(Path(value) for value in re.findall(r"(?:=>\s+|^\s*)(/[^\s]+)", output, re.M))
for directory in (Path("/lib"), Path("/usr/lib")):
    libraries.update(directory.glob("*/libseccomp.so.2"))
if not any(path.name == "libseccomp.so.2" for path in libraries):
    raise RuntimeError("libseccomp_missing")
for library in libraries:
    destination = root / library.relative_to("/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(library.resolve(), destination)
shutil.copytree("/opt/ax-code", root / "trusted", ignore=shutil.ignore_patterns("__pycache__", "build_sandbox.py"))
(root / "etc").mkdir()
shutil.copy2("/etc/ld.so.cache", root / "etc/ld.so.cache")
for directory in ("input", "tmp", "output"):
    (root / directory).mkdir()
for directory, dirs, files in os.walk(root):
    os.chmod(directory, 0o555)
    for name in files:
        path = Path(directory) / name
        if not path.is_symlink():
            os.chmod(path, 0o555 if os.access(path, os.X_OK) else 0o444)
subprocess.check_call(["chroot", str(root), "/usr/local/bin/python3", "-I", "-B", "-c", "import ctypes,openpyxl,defusedxml; ctypes.CDLL('libseccomp.so.2')"])
