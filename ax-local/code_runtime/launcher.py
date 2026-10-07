import base64
import binascii
from contextlib import contextmanager
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import stat
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from security import UID, drop_privileges, prctl, verify_parent_capabilities


ROOT = Path("/sandbox")
STATE = Path("/var/lib/ax-code")
MAX_INPUT = 4096
MAX_OUTPUT = 65536
MAX_LOG = 8192
WALL_SECONDS = 5
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
MOUNTS = {"input": (65536, 16, 0), "tmp": (8 * 1024 * 1024, 128, UID), "output": (1024 * 1024, 32, UID)}
PROFILES = ("docker-tmpfs-v1", "host-quota-v1", "host-quota-8m-v1")
LARGE_MOUNTS = {"input": (8 * 1024 * 1024 + 16384, 16, 0), "tmp": (8 * 1024 * 1024, 128, UID), "output": (8 * 1024 * 1024 + 12288, 32, UID)}
ENV = {"PATH": "/usr/local/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "OPENPYXL_DEFUSEDXML": "True"}


class Rejected(Exception):
    pass


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected("invalid_request")
        result[key] = value
    return result


def request_bytes(raw):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {"version", "source", "inputs", "outputs"} or type(value["version"]) is not int or value["version"] != 1:
            raise Rejected("invalid_request")
        source = value["source"].encode("utf-8")
        if not source or len(source) > 4096 or b"\x00" in source:
            raise Rejected("source_limit")
        if not isinstance(value["inputs"], dict) or len(value["inputs"]) > 4:
            raise Rejected("input_limit")
        inputs = {}
        for name, encoded in value["inputs"].items():
            if not NAME.fullmatch(name) or name == "main.py" or not isinstance(encoded, str):
                raise Rejected("invalid_input")
            inputs[name] = base64.b64decode(encoded, validate=True)
        if sum(map(len, inputs.values())) > MAX_INPUT:
            raise Rejected("input_limit")
        outputs = value["outputs"]
        if not isinstance(outputs, list) or not 1 <= len(outputs) <= 4 or any(not isinstance(n, str) or not NAME.fullmatch(n) for n in outputs) or len(set(outputs)) != len(outputs):
            raise Rejected("invalid_output_names")
        return source, inputs, outputs
    except (ValueError, TypeError, AttributeError, UnicodeError, binascii.Error):
        raise Rejected("invalid_request") from None


def parse_profile(arguments):
    if not arguments:
        return PROFILES[0]
    if len(arguments) == 2 and arguments[0] == "--profile" and arguments[1] in PROFILES:
        return arguments[1]
    raise Rejected("invalid_profile")


@contextmanager
def owned_directory(name):
    if name not in ("tmp", "output") or os.geteuid() != 0:
        raise Rejected("unsafe_directory")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    root = os.open(ROOT, flags)
    try:
        info = os.fstat(root)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Rejected("unsafe_layout")
        directory = None
        try:
            os.seteuid(UID)
            directory = os.open(name, flags, dir_fd=root)
            info = os.fstat(directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != UID or info.st_gid != UID or stat.S_IMODE(info.st_mode) != 0o700:
                raise Rejected("unsafe_directory")
            yield directory
        finally:
            try:
                if directory is not None:
                    os.close(directory)
            finally:
                os.seteuid(0)
    finally:
        os.close(root)


def verify_layout(profile="docker-tmpfs-v1", require_empty=True):
    if profile not in PROFILES:
        raise Rejected("invalid_profile")
    host_quota = profile in ("host-quota-v1", "host-quota-8m-v1")
    large = profile == "host-quota-8m-v1"
    verify_parent_capabilities()
    for path in (ROOT, ROOT / "trusted", ROOT / "usr", STATE):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Rejected("unsafe_layout")
    mounted = {}
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        head, tail = line.split(" - ", 1)
        fields = head.split()
        mounted[fields[4]] = (fields[5].split(","), tail.split()[0])
    mounts = [(ROOT / name, size, inodes, uid, 0o700 if uid else 0o755) for name, (size, inodes, uid) in (LARGE_MOUNTS if large else MOUNTS).items()]
    if host_quota:
        mounts.append((STATE, 262144 if large else 65536, 32, 0, 0o700))
    required_options = {"nosuid", "noexec"} if host_quota else {"nosuid", "nodev", "noexec"}
    expected_filesystem = "9p" if host_quota else "tmpfs"
    for path, size, inodes, uid, mode in mounts:
        info = path.lstat()
        options, filesystem = mounted.get(str(path), ([], ""))
        capacity = os.statvfs(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or filesystem != expected_filesystem or not required_options.issubset(options):
            raise Rejected("unsafe_mount")
        if host_quota and (info.st_gid != uid or stat.S_IMODE(info.st_mode) != mode):
            raise Rejected("unsafe_mount")
        if uid == UID:
            with owned_directory(path.name) as directory:
                empty = not os.listdir(directory)
        else:
            empty = not os.listdir(path)
        if capacity.f_blocks * capacity.f_frsize != size or capacity.f_files != inodes or (require_empty and not empty):
            raise Rejected("unsafe_mount")
        if (uid == 0 and info.st_mode & 0o022) or (uid == UID and stat.S_IMODE(info.st_mode) != 0o700):
            raise Rejected("unsafe_mount")


def write_input(name, data):
    fd = os.open(ROOT / "input" / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def child(out, err, ready, parent_pid, output_limit=MAX_OUTPUT):
    phase = "fds"
    try:
        null = os.open("/dev/null", os.O_RDONLY)
        os.dup2(null, 0)
        os.dup2(out, 1)
        os.dup2(err, 2)
        os.dup2(ready, 3, inheritable=True)
        for name in os.listdir("/proc/self/fd"):
            if int(name) >= 4:
                try:
                    os.close(int(name))
                except OSError as error:
                    if error.errno != errno.EBADF:
                        raise
        phase = "chroot"
        os.setsid()
        os.chroot(ROOT)
        os.chdir("/")
        os.umask(0o077)
        phase = "limits"
        for kind, cap in ((resource.RLIMIT_CPU, 2), (resource.RLIMIT_AS, 256 * 1024 * 1024), (resource.RLIMIT_FSIZE, output_limit), (resource.RLIMIT_NOFILE, 32), (resource.RLIMIT_CORE, 0), (resource.RLIMIT_STACK, 8 * 1024 * 1024)):
            resource.setrlimit(kind, (cap, cap))
        phase = "privileges"
        drop_privileges()
        prctl(1, signal.SIGKILL)
        if os.getppid() != parent_pid:
            raise Rejected("supervisor_lost")
        phase = "cwd"
        os.chdir("/output")
        phase = "exec"
        os.execve("/usr/local/bin/python3", ["python3", "-I", "-B", "/trusted/bootstrap.py"], ENV)
    except BaseException as error:
        try:
            os.write(3, ("E:" + phase + ":" + str(getattr(error, "errno", 0))).encode("ascii"))
        finally:
            os._exit(125)


def watch(pid, out, err, ready, wall_seconds=WALL_SECONDS):
    selector = selectors.DefaultSelector()
    for fd in (out, err, ready):
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ)
    log = bytearray()
    handshake = bytearray()
    deadline = time.monotonic() + wall_seconds
    reason = None
    status = None
    try:
        while status is None or selector.get_map():
            if status is None and time.monotonic() >= deadline and reason is None:
                reason = "wall_limit"
                os.kill(pid, signal.SIGKILL)
            for key, _ in selector.select(0.025):
                chunk = os.read(key.fd, 4096)
                if not chunk:
                    selector.unregister(key.fd)
                    os.close(key.fd)
                    continue
                if key.fd == ready:
                    handshake.extend(chunk)
                else:
                    log.extend(chunk[:max(0, MAX_LOG + 1 - len(log))])
                    if len(log) > MAX_LOG and reason is None:
                        reason = "log_limit"
                        if status is None:
                            os.kill(pid, signal.SIGKILL)
            if status is None:
                waited, code = os.waitpid(pid, os.WNOHANG)
                if waited:
                    status = code
        return status, reason, bytes(handshake), bytes(log[:MAX_LOG])
    finally:
        selector.close()
        for fd in (out, err, ready):
            try:
                os.close(fd)
            except OSError:
                pass
        if status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)


def collect(expected, limit=MAX_OUTPUT, inline=True, limits=None):
    with owned_directory("output") as directory:
        names = os.listdir(directory)
        if set(names) != set(expected):
            raise Rejected("output_names_mismatch")
        total = 0
        outputs = []
        for name in sorted(expected):
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != UID or info.st_size > (limits[name] if limits else limit):
                raise Rejected("unsafe_output")
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                actual = os.fstat(fd)
                if (actual.st_dev, actual.st_ino, actual.st_size) != (info.st_dev, info.st_ino, info.st_size):
                    raise Rejected("unsafe_output")
                with os.fdopen(fd, "rb", closefd=False) as stream:
                    content = stream.read(limit + 1)
            finally:
                os.close(fd)
            total += len(content)
            if len(content) != info.st_size or total > limit:
                raise Rejected("output_limit")
            item = {"name": name, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            if inline:
                item["content_base64"] = base64.b64encode(content).decode("ascii")
            outputs.append(item)
        return outputs


def execute(raw, profile="docker-tmpfs-v1"):
    if profile == "host-quota-8m-v1":
        raise Rejected("chunk_protocol_required")
    source, inputs, outputs = request_bytes(raw)
    verify_layout(profile)
    started = os.open(STATE / "started", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(started)
    write_input("main.py", source)
    for name, content in inputs.items():
        write_input(name, content)
    return run_staged(outputs)


def run_staged(outputs, output_limit=MAX_OUTPUT, inline=True, limits=None, wall_seconds=WALL_SECONDS):
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    ready_r, ready_w = os.pipe()
    parent_pid = os.getpid()
    pid = os.fork()
    if pid == 0:
        child(out_w, err_w, ready_w, parent_pid, output_limit)
    for fd in (out_w, err_w, ready_w):
        os.close(fd)
    status, reason, handshake, log = watch(pid, out_r, err_r, ready_r, wall_seconds)
    result = {"version": 1, "status": "failed", "code": reason or "code_failed", "isolation_ready": handshake == b"R", "exit_code": os.waitstatus_to_exitcode(status), "outputs": [], "untrusted_log_base64": base64.b64encode(log).decode("ascii")}
    if handshake != b"R":
        result.update(status="setup_failed", code="isolation_setup_failed")
        if re.fullmatch(rb"E:(fds|chroot|limits|privileges|cwd|exec|verify|environment|compile|seccomp):[0-9]{1,3}", handshake):
            result["setup_detail"] = handshake.decode("ascii")
    elif reason is None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0:
        try:
            result.update(outputs=collect(outputs, output_limit, inline, limits), status="succeeded", code="ok")
        except Rejected as error:
            result["code"] = str(error)
        except OSError:
            result["code"] = "unsafe_output"
    return result


def main():
    try:
        profile = parse_profile(sys.argv[1:])
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise Rejected("request_limit")
        result = execute(raw, profile)
    except Rejected as error:
        result = {"version": 1, "status": "setup_failed", "code": str(error), "isolation_ready": False, "outputs": []}
    except BaseException:
        result = {"version": 1, "status": "setup_failed", "code": "isolation_setup_failed", "isolation_ready": False, "outputs": []}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
