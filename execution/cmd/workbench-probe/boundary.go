package main

import "github.com/sori883/agent-workspace/execution/native"

const boundaryOutput = "check,result\nidentity,pass\nnetwork,denied\nfork_exec,denied\nparent_control,denied\nprivate_paths,hidden\nreadonly_paths,denied\nprivilege_changes,denied\ninherited_fds,closed\ninput,unchanged\n"

const boundarySource = `import os,socket,ctypes,errno,stat,threading
from pathlib import Path
assert os.getresuid()==(65532,)*3 and os.getresgid()==(65532,)*3
assert set(os.environ)=={'PATH','HOME','TMPDIR','LANG','LC_ALL','OPENPYXL_DEFUSEDXML'}
def denied(call,allowed=(errno.EPERM,)):
    try: value=call()
    except OSError as e:
        assert e.errno in allowed
        return
    if hasattr(value,'close'): value.close()
    elif isinstance(value,int) and value>=0: os.close(value)
    raise AssertionError('operation unexpectedly allowed')
for family,kind in [(socket.AF_INET,socket.SOCK_STREAM),(socket.AF_INET,socket.SOCK_DGRAM),(socket.AF_INET6,socket.SOCK_STREAM),(socket.AF_UNIX,socket.SOCK_STREAM)]:
    denied(lambda: socket.socket(family,kind))
try: child=os.fork()
except OSError as e: assert e.errno in (errno.EPERM,errno.EAGAIN)
else:
    if child==0: os._exit(91)
    raise AssertionError('fork unexpectedly allowed')
try: threading.Thread(target=lambda:None).start()
except (RuntimeError,OSError): pass
else: raise AssertionError('thread unexpectedly allowed')
assert os.path.isfile('/usr/local/bin/python3')
denied(lambda: os.execve('/usr/local/bin/python3',['python3','-I','-c','raise SystemExit(91)'],{}))
denied(lambda: os.kill(os.getppid(),0))
lib=ctypes.CDLL(None,use_errno=True)
for call in [lambda: lib.ptrace(0,0,0,0),lambda: lib.process_vm_readv(os.getppid(),0,0,0,0,0),lambda: lib.process_vm_writev(os.getppid(),0,0,0,0,0),lambda: lib.setuid(0),lambda: lib.setgid(0),lambda: lib.capset(0,0),lambda: lib.prctl(38,0,0,0,0),lambda: lib.mount(b'none',b'/tmp',b'tmpfs',0,0),lambda: lib.mknod(b'/tmp/fifo',stat.S_IFIFO|0o600,0),lambda: lib.mknodat(-100,b'/tmp/fifo-at',stat.S_IFIFO|0o600,0)]:
    ctypes.set_errno(0)
    assert call()==-1 and ctypes.get_errno()==errno.EPERM
for path in ['/proc/self/environ','/proc/1/root','/proc/'+str(os.getppid())+'/mem','/opt/ax-code/runner.py','/opt/ax-code/server-task.json','/var/lib/ax-code','/workspace','/../../var/lib/ax-code']:
    denied(lambda: os.open(path,os.O_RDONLY),(errno.EPERM,errno.EACCES,errno.ENOENT,errno.ENOTDIR))
for path in ['/input/input_1','/input/main.py','/trusted/security.py','/usr/local/lib/python3.12/os.py']:
    assert os.path.isfile(path)
    denied(lambda: os.open(path,os.O_WRONLY),(errno.EPERM,errno.EACCES,errno.EROFS))
for fd in range(3,64):
    try: os.fstat(fd)
    except OSError as e: assert e.errno==errno.EBADF
    else: raise AssertionError('inherited descriptor')
assert Path('/input/input_1').read_bytes()==b'amount\n100\n200\n'
with open('/output/boundary.csv','xb') as out:
    out.write(b'check,result\nidentity,pass\nnetwork,denied\nfork_exec,denied\nparent_control,denied\nprivate_paths,hidden\nreadonly_paths,denied\nprivilege_changes,denied\ninherited_fds,closed\ninput,unchanged\n')
print('isolation boundary checks complete')
`

func boundaryScenario() scenarioSpec {
	return scenarioSpec{instruction: "AX workbench isolated boundary probe v1", purpose: "probe:isolation-boundary:verify", complete: "Isolation boundary checks complete", source: boundarySource,
		inputs:  []native.WorkbenchFile{{Alias: "input_1", Name: "sales.csv", SizeBytes: 15, SHA256: "ff0174ca0f09ea443111c05063a51d00cee3dc79d0e836a2f9965e4b7198ed1b"}},
		outputs: []native.PythonOutput{{Name: "boundary.csv", SizeLimitBytes: len(boundaryOutput)}}, fixedOutputs: []string{boundaryOutput}}
}
