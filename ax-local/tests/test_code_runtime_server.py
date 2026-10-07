import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


IMAGE = os.environ.get("AX_CODE_IMAGE")
ROOT = Path(__file__).resolve().parents[2]
PROBE = r'''package main
import("context";"encoding/json";"net/http";"os";"time"; guestpb "github.com/agent-substrate/env/proto/ateenv/v1alpha";"google.golang.org/grpc";"google.golang.org/grpc/credentials/insecure";"google.golang.org/grpc/status")
func main(){
 ready:=false
 client:=&http.Client{Timeout:time.Second}
 for i:=0;i<30;i++ { r,e:=client.Get("http://127.0.0.1:80/readyz"); if e==nil {r.Body.Close();ready=r.StatusCode==200}; if ready {break};time.Sleep(100*time.Millisecond) }
 conn,e:=grpc.NewClient("127.0.0.1:80",grpc.WithTransportCredentials(insecure.NewCredentials()),grpc.WithDisableRetry()); if e!=nil {panic("probe configuration")};defer conn.Close()
 ctx,cancel:=context.WithTimeout(context.Background(),2*time.Second);defer cancel()
 _,e=guestpb.NewProcessServiceClient(conn).GetProcess(ctx,&guestpb.GetProcessRequest{ProcessId:"ax-code-readonly-probe-absent"})
 json.NewEncoder(os.Stdout).Encode(map[string]any{"readyz_ok":ready,"process_service_code":status.Code(e).String()})
}
'''


@unittest.skipUnless(IMAGE, "AX_CODE_IMAGE must name an existing local code image")
class CodeServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="ax-code-server-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        directory = Path(cls.temp.name)
        source = directory / "probe.go"
        source.write_text(PROBE)
        cls.binary = directory / "probe"
        arch = subprocess.check_output(["docker", "image", "inspect", IMAGE, "--format", "{{.Architecture}}"], text=True).strip()
        if arch not in {"arm64", "amd64"}:
            raise RuntimeError("unsupported local image architecture")
        subprocess.run(["go", "build", "-o", str(cls.binary), str(source)], cwd=ROOT / "execution", check=True, env={**os.environ, "GOOS": "linux", "GOARCH": arch, "CGO_ENABLED": "0", "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOSUMDB": "off"})

    def probe(self, arguments):
        command = ["docker", "run", "-d", "--network", "none", "--read-only", "--cap-drop=ALL"]
        for cap in ["KILL", "SETUID", "SETGID", "SETPCAP", "SYS_CHROOT"]:
            command.append("--cap-add=" + cap)
        command += ["--tmpfs", "/workspace:rw,nosuid,nodev,size=65536", "--tmpfs", "/tmp:rw,nosuid,nodev,size=33554432", "--mount", f"type=bind,source={self.binary},target=/probe,readonly", "--entrypoint", "/usr/local/bin/ax-task-runner", IMAGE, *arguments]
        container = subprocess.check_output(command, text=True).strip()
        try:
            result = json.loads(subprocess.check_output(["docker", "exec", container, "/probe"], text=True))
            check = "import json,os,pathlib; assert 'AX_TASK_YAML' not in os.environ; assert not pathlib.Path('/var/lib/ax-code/ready.json').exists(); assert json.loads(pathlib.Path('/opt/ax-code/server-task.json').read_text()) == {'apiVersion':'ax.io/v1alpha1','kind':'Task','metadata':{'name':'ax-code-server'},'spec':{'debug':True}}"
            subprocess.run(["docker", "exec", container, "python3", "-c", check], check=True)
            return result
        finally:
            subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)

    def test_readyz_alone_does_not_prove_guest_service(self):
        self.assertEqual(self.probe([]), {"readyz_ok": True, "process_service_code": "Unimplemented"})

    def test_fixed_task_file_enables_readonly_guest_without_start(self):
        self.assertEqual(self.probe(["--task-file", "/opt/ax-code/server-task.json"]), {"readyz_ok": True, "process_service_code": "NotFound"})


if __name__ == "__main__":
    unittest.main()
