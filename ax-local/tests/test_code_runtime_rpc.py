import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "code_runtime/runner.py"
spec = importlib.util.spec_from_file_location("code_runner", MODULE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def fixture(content=b"x", source="open('/output/result.csv','w').write('ok')"):
    d = {"version": 2, "root_id": "22222222-2222-4222-8222-222222222222", "instruction": "Aggregate", "definition_manifest": [], "code_profile": runner.PROFILE,
         "inputs": [{"alias": "input_1", "file_id": "33333333-3333-4333-8333-333333333333", "name": "sales.csv", "size_bytes": len(content), "sha256": runner.digest(content)}],
         "outputs": [{"alias": "output_1", "name": "result.csv", "size_limit_bytes": runner.LIMIT}], "history": [],
         "code": {"kind": "python", "source": source, "input_aliases": ["input_1"], "outputs": [{"name": "result.csv", "size_limit_bytes": runner.LIMIT}], "purpose": "test"}}
    r = {"schema_version": 2, "run_id": "ax-run-0123456789abcdef", "root_id": d["root_id"], "adapter": "python", "checkpoint_revision": 1, "descriptor_sha256": runner.digest(runner.canonical(d))}
    return {"request": r, "workbench": {"version": 2, "attempt_kind": "python", "execution_policy": "workbench-trial-2026-10-07-v1", "mode": "preview", "profile_id": "preview-v1", "remaining_ms": 300000, "descriptor": d}}


class ContractTests(unittest.TestCase):
    def test_skill_without_agent_and_definition_limits(self):
        value=fixture();d=value['workbench']['descriptor']
        def ref(index,kind='skill'):
            return {'id':str(runner.uuid.UUID(int=index+1)),'sha256':'a'*64,'size_bytes':1,'kind':kind}
        def check(refs,rejected=False):
            d['definition_manifest']=refs;value['request']['descriptor_sha256']=runner.digest(runner.canonical(d))
            if rejected:
                with self.assertRaises(runner.Rejected):runner.descriptor(value)
            else:runner.descriptor(value)
        check([ref(0)])
        check([ref(i) for i in range(8)])
        check([ref(8,'agent')]+[ref(i) for i in range(8)])
        check([ref(i) for i in range(9)],True)
        check([ref(0),ref(1,'agent')],True)
        check([ref(0,'agent'),ref(1,'agent')],True)

    def test_history_seventeen_and_encoded_size_limit(self):
        value=fixture();d=value['workbench']['descriptor']
        def check(history,rejected=False):
            d['history']=history;value['request']['descriptor_sha256']=runner.digest(runner.canonical(d))
            if rejected:
                with self.assertRaises(runner.Rejected):runner.descriptor(value)
            else:runner.descriptor(value)
        check([{'kind':'user_start','text':'input'}]+[{'kind':'code_result','text':'done'} for _ in range(16)])
        check([{'kind':'code_result','text':'done'} for _ in range(18)],True)
        check([{'kind':'code_result','text':'x'*8192} for _ in range(2)],True)

    def test_strict_descriptor_and_matching_proposal(self):
        value = fixture(); runner.descriptor(value)
        changes = [lambda v: v["request"].update(extra=True), lambda v: v["workbench"]["descriptor"]["code"].update(input_aliases=[]), lambda v: v["workbench"]["descriptor"]["code"].update(source="x"*4097), lambda v: v["workbench"]["descriptor"].update(code_profile="host-quota-v1"), lambda v: v["workbench"]["descriptor"]["inputs"][0].update(alias="../x"), lambda v: v["workbench"]["descriptor"]["outputs"][0].update(size_limit_bytes=runner.LIMIT+1)]
        for change in changes:
            v=copy.deepcopy(value); change(v); v["request"]["descriptor_sha256"]=runner.digest(runner.canonical(v["workbench"]["descriptor"]))
            with self.assertRaises(runner.Rejected): runner.descriptor(v)

    def test_frame_duplicate_keys_and_base64(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'x'*65537):
            with self.assertRaises(runner.Rejected): runner.decode(raw)
        for encoded in ("eA==\n", "eB==", "x"*43696):
            with self.assertRaises((runner.Rejected, ValueError)): runner.b64(encoded,32768)

    def test_small_protocol_remains_small(self):
        with self.assertRaises(runner.launcher.Rejected):
            runner.launcher.execute(b'{}', runner.PROFILE)
        self.assertEqual(runner.launcher.MAX_INPUT,4096)
        self.assertEqual(runner.launcher.MAX_OUTPUT,65536)


@unittest.skipUnless(os.geteuid()==0, "root-owned protocol fixtures run in an isolated Linux container")
class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); root=Path(self.temp.name)
        self.state=root/'state'; self.inputs=root/'input'; self.outputs=root/'output'
        for p in (self.state,self.inputs,self.outputs):p.mkdir()
        self.patches=[patch.object(runner,'STATE',self.state),patch.object(runner,'INPUT',self.inputs),patch.object(runner,'OUTPUT',self.outputs),patch.object(runner.launcher,'ROOT',root),patch.object(runner,'live_waiter')]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def key(self,value):return {k:value['request'][k] for k in ('run_id','descriptor_sha256')}
    def chunk(self,value,content,index=0):
        part=content[index*runner.CHUNK:(index+1)*runner.CHUNK]
        return {**self.key(value),'alias':'input_1','index':index,'content_base64':base64.b64encode(part).decode(),'sha256':runner.digest(part)}
    def test_exact_8m_seal_replay_and_start_once(self):
        content=b'x'*runner.LIMIT; value=fixture(content)
        self.assertEqual(runner.begin(value),runner.begin(value))
        with self.assertRaises(runner.Rejected):runner.seal(self.key(value))
        for index in range(256):runner.put_chunk(self.chunk(value,content,index))
        self.assertEqual(runner.put_chunk(self.chunk(value,content,255))['state'],'staged')
        self.assertEqual(runner.seal(self.key(value)),runner.seal(self.key(value)))
        self.assertEqual((self.inputs/'input_1').read_bytes(),content)
        self.assertEqual((self.inputs/'input_1').stat().st_mode&0o777,0o444)
        runner.start(self.key(value))
        with self.assertRaises(runner.Rejected):runner.start(self.key(value))
        with self.assertRaises(runner.Rejected):runner.put_chunk(self.chunk(value,content))
    def test_conflict_order_hash_and_wrong_identity(self):
        content=b'x'*(runner.CHUNK+1);value=fixture(content);runner.begin(value)
        with self.assertRaises(runner.Rejected):runner.put_chunk(self.chunk(value,content,1))
        request=self.chunk(value,content);runner.put_chunk(request)
        bad=self.chunk(value,b'y'*(runner.CHUNK+1))
        with self.assertRaises(runner.Rejected):runner.put_chunk(bad)
        bad=copy.deepcopy(value);bad['workbench']['remaining_ms']=100
        with self.assertRaises(runner.Rejected):runner.begin(bad)
        with self.assertRaises(runner.Rejected):runner.status({**self.key(value),'run_id':'ax-run-ffffffffffffffff'})
    def test_source_and_code_never_run_during_stage(self):
        value=fixture(source="raise RuntimeError('must not execute')")
        with patch.object(runner.launcher,'run_staged',side_effect=AssertionError('executed')):
            runner.begin(value);runner.put_chunk(self.chunk(value,b'x'));runner.seal(self.key(value))
            self.assertFalse(runner.status(self.key(value))['attempted'])
    def test_no_send_after_deadline(self):
        value=fixture();runner.begin(value);runner.put_chunk(self.chunk(value,b'x'));runner.seal(self.key(value))
        with patch.object(runner,'remaining_ms',return_value=0):
            with self.assertRaises(runner.Rejected):runner.start(self.key(value))
        self.assertFalse((self.state/'start.json').exists())
    def test_manifest_preserves_declared_output_order(self):
        value=fixture();d=value['workbench']['descriptor']
        d['outputs']=[{'alias':'last','name':'z.csv','size_limit_bytes':2},{'alias':'first','name':'a.csv','size_limit_bytes':2}]
        d['code']['outputs']=[{'name':f['name'],'size_limit_bytes':2} for f in d['outputs']]
        value['request']['descriptor_sha256']=runner.digest(runner.canonical(d));runner.begin(value)
        observation={'untrusted_log_base64':'','exit_code':0,'code':'ok','status':'succeeded','outputs':[{'name':n,'size_bytes':1,'sha256':runner.digest(b'x')} for n in ['a.csv','z.csv']]}
        os.chmod(self.temp.name,0o755);os.chmod(self.outputs,0o700);os.chown(self.outputs,runner.launcher.UID,runner.launcher.UID)
        for n in ['a.csv','z.csv']:
            (self.outputs/n).write_bytes(b'x');os.chown(self.outputs/n,runner.launcher.UID,runner.launcher.UID)
        with patch.object(runner.launcher,'verify_layout'),patch.object(runner.launcher,'run_staged',return_value=observation):
            runner.run_once(value)
        manifest=runner.output_manifest(self.key(value));self.assertEqual([f['alias'] for f in manifest['outputs']],['last','first'])
    def test_failed_child_has_known_zero_result_without_outputs(self):
        value=fixture();runner.begin(value)
        observation={'untrusted_log_base64':base64.b64encode(b'bad\x00\xff').decode(),'exit_code':1,'code':'code_failed','status':'failed','outputs':[]}
        with patch.object(runner.launcher,'verify_layout'),patch.object(runner.launcher,'run_staged',return_value=observation):runner.run_once(value)
        result=runner.collect(self.key(value))['result'];self.assertEqual(result['usage'],runner.ZERO_USAGE);self.assertEqual(result['status'],'failed');self.assertNotIn('\x00',result['summary'])
        with self.assertRaises(runner.Rejected):runner.output_manifest(self.key(value))


if __name__=='__main__':unittest.main()
