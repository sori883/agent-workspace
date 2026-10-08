import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

from test_workbench_runtime import fixture, encoded, rehash, VERSION, ROOT_ID, RUN_ID
from task_runtime import workbench_runner as runner
from task_runtime.adapters.workbench import prompt_value, validate_bound_proposal
from task_runtime.workbench_protocol import ProtocolError, json_bytes, validate_envelope
from task_runtime.workbench_skills import hydrate_context


def object_fixture(reference=False):
    saved = fixture()
    main = '---\nname: "file-skill"\ndescription: "概要\\nnext"\n---\n\n本文を確認してください。\n'.encode('utf-8')
    data = {'SKILL.md': main, 'references/empty.md': b'', 'scripts/not-run.py': b'raise RuntimeError("must not execute")\n'}
    files = [{'path': path, 'size_bytes': len(raw), 'media_type': 'text/plain; charset=utf-8', 'sha256': hashlib.sha256(raw).hexdigest()} for path, raw in data.items()]
    object = {'id': VERSION, 'name': 'file-skill', 'description': '概要\nnext', 'content_sha256': 'a' * 64,
              'files': files, 'loaded_paths': ['SKILL.md', 'references/empty.md'] if reference else ['SKILL.md'],
              'source': {'type': 'skill-object-v1', 'store_id': 'test-skills', 'revision_id': ROOT_ID,
                         'manifest_key': f'workspaces/{ROOT_ID}/skills/{VERSION}/revisions/{ROOT_ID}/manifest.json',
                         'manifest_sha256': 'b' * 64, 'manifest_bytes': 10, 'total_bytes': 10 + sum(map(len, data.values()))}}
    saved['workbench']['descriptor']['skill_context'] = {'version': 2, 'catalog': [], 'omitted_count': 0,
         'loaded_skills': [], 'loaded_files': [], 'builtin_skill_ids': [], 'objects': [object]}
    return rehash(saved), data


def send(root, saved, path, raw):
    runner.skill_file_chunk(root, encoded({'run_id': RUN_ID, 'descriptor_sha256': saved['request']['descriptor_sha256'],
         'skill_id': VERSION, 'path': path, 'index': 0, 'content_base64': base64.b64encode(raw).decode('ascii')}))


class SkillStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'task'

    def stage(self, reference=False):
        saved, data = object_fixture(reference)
        runner.stage(self.root, encoded(saved))
        for path in saved['workbench']['descriptor']['skill_context']['objects'][0]['loaded_paths']:
            send(self.root, saved, path, data[path])
        return saved, data

    def test_selected_files_are_readonly_and_hydrate_without_changing_descriptor(self):
        saved, data = self.stage(True)
        original = json_bytes(saved['workbench']['descriptor'])
        runner.seal(self.root, RUN_ID)
        runner.seal(self.root, RUN_ID)
        runner.start(self.root, RUN_ID)
        folder = self.root / 'skills' / f'skill-{VERSION}'
        self.assertEqual((folder / 'SKILL.md').read_bytes(), data['SKILL.md'])
        self.assertFalse((folder / 'scripts').exists())
        for path in (self.root / 'skills', folder, folder / 'references'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in (folder / 'SKILL.md', folder / 'references/empty.md'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
        value = prompt_value(saved, [], [], self.root)
        self.assertEqual(value['skill_context']['loaded_skills'][0]['instructions'], '本文を確認してください。')
        self.assertEqual(value['skill_context']['loaded_files'][0]['content'], '')
        self.assertNotIn('objects', value['skill_context'])
        self.assertNotIn('manifest_key', json.dumps(value))
        self.assertEqual(json_bytes(saved['workbench']['descriptor']), original)
        self.assertEqual(runner.envelope(self.root)['request']['descriptor_sha256'], saved['request']['descriptor_sha256'])
        self.assertEqual(validate_bound_proposal({'kind': 'read_skill_file', 'skill_id': VERSION, 'path': 'scripts/not-run.py'}, saved, [])['path'], 'scripts/not-run.py')
        with self.assertRaises(ProtocolError):
            validate_bound_proposal({'kind': 'read_skill_file', 'skill_id': VERSION, 'path': 'references/empty.md'}, saved, [])

    def test_bad_context_missing_bytes_and_unselected_paths_fail_closed(self):
        saved, data = object_fixture()
        for mutate in (lambda obj: obj['source'].update(manifest_key='https://other/secret'),
                       lambda obj: obj.update(loaded_paths=[]),
                       lambda obj: obj['files'][1].update(path='../secret'),
                       lambda obj: obj['source'].update(total_bytes=1)):
            invalid = copy.deepcopy(saved)
            mutate(invalid['workbench']['descriptor']['skill_context']['objects'][0])
            with self.assertRaises(ProtocolError):
                validate_envelope(rehash(invalid))
        runner.stage(self.root, encoded(saved))
        with self.assertRaises(FileNotFoundError):
            runner.seal(self.root, RUN_ID)
        self.assertFalse((self.root / 'sealed').exists())
        with self.assertRaises(ProtocolError):
            send(self.root, saved, 'references/empty.md', b'')
        with self.assertRaises(ProtocolError):
            send(self.root, saved, 'SKILL.md', b'wrong')
        send(self.root, saved, 'SKILL.md', data['SKILL.md'])
        runner.seal(self.root, RUN_ID)
        send(self.root, saved, 'SKILL.md', data['SKILL.md'])
        with self.assertRaises(ProtocolError):
            prompt_value(saved, [], [])

    def test_skill_file_modes_are_fixed_under_private_umask(self):
        previous = os.umask(0o077)
        try:
            saved, data = self.stage(True)
            runner.seal(self.root, RUN_ID)
            folder = self.root / 'skills' / f'skill-{VERSION}'
            for path in ('SKILL.md', 'references/empty.md'):
                materialized = folder / path
                self.assertEqual(stat.S_IMODE(materialized.stat().st_mode), 0o444)
                self.assertEqual(materialized.read_bytes(), data[path])
            for path in (self.root / 'skills', folder, folder / 'references'):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            self.assertEqual(hydrate_context(saved, self.root)['loaded_files'][0]['content'], '')
        finally:
            os.umask(previous)

    def test_path_prefix_collision_is_rejected_before_staging(self):
        saved, _ = object_fixture()
        item = saved['workbench']['descriptor']['skill_context']['objects'][0]
        item['files'][1]['path'] = 'references/a'
        item['files'][2]['path'] = 'references/a/b'
        with self.assertRaises(ProtocolError):
            validate_envelope(rehash(saved))

    def test_oversized_hydrated_prompt_finishes_with_known_zero_usage_before_sdk(self):
        saved, data = object_fixture(True)
        item = saved['workbench']['descriptor']['skill_context']['objects'][0]
        old_main = data['SKILL.md']
        header = old_main[:old_main.index('本文'.encode())]
        data['SKILL.md'] = header + b'x' * 16384 + b'\n'
        data['references/empty.md'] = b'y' * 32768
        for file in item['files']:
            raw = data[file['path']]
            file.update(size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        item['source']['total_bytes'] = item['source']['manifest_bytes'] + sum(map(len, data.values()))
        rehash(saved)
        self.assertLess(len(json_bytes(saved['workbench']['descriptor'])), 40960)
        runner.stage(self.root, encoded(saved))
        for path in item['loaded_paths']:
            send(self.root, saved, path, data[path])
        runner.seal(self.root, RUN_ID)
        runner.start(self.root, RUN_ID)
        with patch.object(runner.subprocess, 'Popen') as process:
            result = runner.execute(self.root)
            process.assert_not_called()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error_type'], 'skill_context_too_large')
        self.assertEqual(result['estimated_usd'], 0)
        self.assertEqual(set(result['usage'].values()), {0})
        self.assertFalse((self.root / 'mailbox').exists())
        self.assertEqual(runner.collect(self.root, RUN_ID)['result'], result)

    def test_tampered_materialization_symlinks_and_hardlinks_are_rejected(self):
        saved, data = self.stage()
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (self.root / 'skills').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            runner.seal(self.root, RUN_ID)
        (self.root / 'skills').unlink()
        runner.seal(self.root, RUN_ID)
        main = self.root / 'skills' / f'skill-{VERSION}' / 'SKILL.md'
        os.link(main, outside / 'hardlink')
        with self.assertRaises(ProtocolError):
            hydrate_context(saved, self.root)
        (outside / 'hardlink').unlink()
        main.chmod(0o644)
        with self.assertRaises(ProtocolError):
            runner.start(self.root, RUN_ID)
        main.write_text('changed')
        main.chmod(0o444)
        with self.assertRaises(ProtocolError):
            hydrate_context(saved, self.root)

    def test_same_fixed_version_can_be_materialized_into_a_new_task(self):
        saved, data = self.stage(True)
        runner.seal(self.root, RUN_ID)
        new_root = Path(self.temp.name) / 'resumed-task'
        runner.stage(new_root, encoded(saved))
        for path in saved['workbench']['descriptor']['skill_context']['objects'][0]['loaded_paths']:
            send(new_root, saved, path, data[path])
        runner.seal(new_root, RUN_ID)
        self.assertEqual(hydrate_context(saved, new_root), hydrate_context(saved, self.root))

    def test_replacing_readonly_file_cannot_change_hydrated_model_context(self):
        saved, data = self.stage()
        runner.seal(self.root, RUN_ID)
        main = self.root / 'skills' / f'skill-{VERSION}' / 'SKILL.md'
        main.unlink()
        main.write_bytes(b'x' * len(data['SKILL.md']))
        main.chmod(0o444)
        with self.assertRaisesRegex(ProtocolError, 'SkillFileDigestMismatch'):
            prompt_value(saved, [], [], self.root)
        with self.assertRaisesRegex(ProtocolError, 'SkillFileDigestMismatch'):
            runner.start(self.root, RUN_ID)

    def test_worker_can_remove_durable_skill_tree_at_every_cleanup_boundary_without_chmod(self):
        for state in ('staged', 'sealed', 'started', 'finished'):
            with self.subTest(state=state):
                saved, _ = self.stage(True)
                if state != 'staged':
                    runner.seal(self.root, RUN_ID)
                    self.assertEqual(hydrate_context(saved, self.root)['loaded_files'][0]['content'], '')
                if state in ('started', 'finished'):
                    runner.start(self.root, RUN_ID)
                if state == 'finished':
                    with patch.object(runner, 'check_prompt_capacity', side_effect=runner.SkillContextTooLarge('skill_context_too_large')):
                        with patch.object(runner.subprocess, 'Popen') as process:
                            result = runner.execute(self.root)
                            process.assert_not_called()
                    self.assertEqual(runner.collect(self.root, RUN_ID)['result'], result)
                shutil.rmtree(self.root)
                self.assertFalse(self.root.exists())


if __name__ == '__main__':
    unittest.main()
