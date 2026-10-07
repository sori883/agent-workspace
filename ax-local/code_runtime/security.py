import ctypes
import errno
import fcntl
import os
import platform
import termios


UID = 65532
libc = ctypes.CDLL(None, use_errno=True)


class SecurityError(Exception):
    pass


def checked(value):
    if value != 0:
        raise SecurityError("isolation_setup_failed")


def prctl(option, value=0):
    result = libc.prctl(ctypes.c_int(option), ctypes.c_ulong(value), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0))
    if result < 0:
        raise SecurityError("isolation_setup_failed")
    return result


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


class ArgCompare(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint), ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]


def capabilities_empty():
    header = CapHeader(0x20080522, 0)
    data = (CapData * 2)()
    checked(libc.capget(ctypes.byref(header), ctypes.byref(data)))
    return all(not value for row in data for value in (row.effective, row.permitted, row.inheritable))


def verify_parent_capabilities():
    header = CapHeader(0x20080522, 0)
    data = (CapData * 2)()
    checked(libc.capget(ctypes.byref(header), ctypes.byref(data)))
    expected = sum(1 << cap for cap in (5, 6, 7, 8, 18))
    if os.geteuid() != 0 or data[0].effective != expected or data[0].permitted != expected or data[0].inheritable or any((data[1].effective, data[1].permitted, data[1].inheritable)):
        raise SecurityError("isolation_setup_failed")


def drop_privileges():
    if os.geteuid() != 0:
        raise SecurityError("isolation_setup_failed")
    checked(prctl(38, 1))
    checked(prctl(47, 4))
    found_last = False
    for cap in range(64):
        result = libc.prctl(23, cap, 0, 0, 0)
        if result < 0:
            if ctypes.get_errno() != errno.EINVAL:
                raise SecurityError("isolation_setup_failed")
            found_last = True
            break
        checked(libc.prctl(24, cap, 0, 0, 0))
    if not found_last:
        raise SecurityError("isolation_setup_failed")
    os.setgroups([])
    os.setresgid(UID, UID, UID)
    os.setresuid(UID, UID, UID)
    header = CapHeader(0x20080522, 0)
    checked(libc.capset(ctypes.byref(header), ctypes.byref((CapData * 2)())))
    checked(prctl(4, 0))
    verify_privileges()


def verify_privileges():
    if os.getresuid() != (UID,) * 3 or os.getresgid() != (UID,) * 3 or os.getgroups() or not capabilities_empty() or prctl(39) != 1:
        raise SecurityError("isolation_setup_failed")
    for cap in range(64):
        result = libc.prctl(23, cap, 0, 0, 0)
        if result < 0:
            if ctypes.get_errno() == errno.EINVAL:
                break
            raise SecurityError("isolation_setup_failed")
        if result != 0 or libc.prctl(47, 1, cap, 0, 0) != 0:
            raise SecurityError("isolation_setup_failed")


def filter_syscalls():
    if platform.machine() not in ("aarch64", "x86_64"):
        raise SecurityError("isolation_setup_failed")
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(ArgCompare)]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x00050000 | errno.EPERM)
    if not context:
        raise SecurityError("isolation_setup_failed")
    allowed = """
        read write readv writev pread64 pwrite64 close close_range lseek
        open openat fstat newfstatat stat lstat statx statfs fstatfs
        access faccessat faccessat2 readlink readlinkat getdents64
        mkdir mkdirat unlink unlinkat rename renameat renameat2
        link linkat symlink symlinkat rmdir truncate ftruncate fsync fdatasync
        chmod fchmod fchmodat umask chdir getcwd dup dup2 dup3
        mmap mprotect munmap mremap madvise brk
        rt_sigaction rt_sigprocmask rt_sigreturn sigaltstack
        clock_gettime clock_getres clock_nanosleep nanosleep gettimeofday times
        getpid getppid gettid getuid geteuid getgid getegid getresuid getresgid
        getrandom uname sysinfo getrusage sched_getaffinity futex restart_syscall
        exit exit_group
    """.split()
    try:
        for name in allowed:
            number = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number >= 0:
                checked(seccomp.seccomp_rule_add(context, 0x7FFF0000, number, 0))
        number = seccomp.seccomp_syscall_resolve_name(b"fcntl")
        if number < 0:
            raise SecurityError("isolation_setup_failed")
        for command in (fcntl.F_GETFD, fcntl.F_GETFL):
            compare = ArgCompare(1, 4, command, 0)
            checked(seccomp.seccomp_rule_add_array(context, 0x7FFF0000, number, 1, ctypes.byref(compare)))
        number = seccomp.seccomp_syscall_resolve_name(b"ioctl")
        if number < 0:
            raise SecurityError("isolation_setup_failed")
        compare = ArgCompare(1, 4, termios.FIOCLEX, 0)
        checked(seccomp.seccomp_rule_add_array(context, 0x7FFF0000, number, 1, ctypes.byref(compare)))
        checked(seccomp.seccomp_load(context))
    finally:
        seccomp.seccomp_release(context)
