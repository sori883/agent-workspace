import argparse
import asyncio
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

if __package__:
    from . import runner
    from .mailbox import read_file, write_once
    from .workbench_mailbox import WorkbenchMailbox
    from .workbench_protocol import CHUNK_BYTES, DEFINITION_BYTES, ProtocolError, decode_base64, decode_frame, fields, integer, json_bytes, load_json, validate_definition, validate_envelope, validate_result, validate_run_id
else:
    import runner
    from mailbox import read_file, write_once
    from workbench_mailbox import WorkbenchMailbox
    from workbench_protocol import CHUNK_BYTES, DEFINITION_BYTES, ProtocolError, decode_base64, decode_frame, fields, integer, json_bytes, load_json, validate_definition, validate_envelope, validate_result, validate_run_id


@contextmanager
def locked(root):
    runner._directory(root, create=True)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        lock = os.open('workbench.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        import stat
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ProtocolError('InvalidWorkbenchLock')
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def replay_write(directory, name, raw):
    try:
        existing = read_file(directory, name, max(DEFINITION_BYTES, len(raw)))
    except FileNotFoundError:
        write_once(directory, name, raw)
        return
    if existing != raw:
        raise ProtocolError('WorkbenchReplayConflict')


def envelope(root, run_id=None):
    value = validate_envelope(load_json(runner._read_bytes(root / 'workbench.json', 49152)))
    if value['workbench']['attempt_kind'] != 'runtime':
        raise ProtocolError('CodeRequiresIsolatedTask')
    if run_id is not None and value['request']['run_id'] != validate_run_id(run_id):
        raise ProtocolError('WorkbenchRunMismatch')
    if load_json(runner._read_bytes(root / 'request.json', 4096)) != value['request']:
        raise ProtocolError('WorkbenchRequestMismatch')
    return value


def stage(root, encoded):
    value = validate_envelope(decode_frame(encoded))
    if value['workbench']['attempt_kind'] != 'runtime':
        raise ProtocolError('CodeRequiresIsolatedTask')
    with locked(root) as directory:
        if (root / 'sealed').exists() or (root / 'start').exists():
            if envelope(root) != value:
                raise ProtocolError('WorkbenchReplayConflict')
        else:
            replay_write(directory, 'request.json', json_bytes(value['request']))
            replay_write(directory, 'workbench.json', json_bytes(value))
        replay_write(directory, 'staged', b'')
    return {'run_id': value['request']['run_id'], 'state': 'staged'}


def definition_chunk(root, encoded):
    value = fields(decode_frame(encoded), 'run_id version_id index content_base64')
    with locked(root) as directory:
        saved = envelope(root, value['run_id'])
        refs = saved['workbench']['descriptor']['definition_manifest']
        ref = next((ref for ref in refs if ref['id'] == value['version_id']), None)
        if ref is None:
            raise ProtocolError('DefinitionNotBound')
        count = (ref['size_bytes'] + CHUNK_BYTES - 1) // CHUNK_BYTES
        index = integer(value['index'], 0, count - 1)
        raw = decode_base64(value['content_base64'], CHUNK_BYTES)
        if len(raw) != min(CHUNK_BYTES, ref['size_bytes'] - CHUNK_BYTES * index):
            raise ProtocolError('DefinitionChunkSizeMismatch')
        name = f"definition-{ref['id']}-{index}"
        if (root / 'sealed').exists() or (root / 'start').exists():
            if read_file(directory, name, CHUNK_BYTES) != raw:
                raise ProtocolError('SealedDefinitionConflict')
        else:
            replay_write(directory, name, raw)
    return {'run_id': value['run_id'], 'state': 'staged'}


def definitions(root, saved):
    result = []
    descriptor = saved['workbench']['descriptor']
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for ref in descriptor['definition_manifest']:
            count = (ref['size_bytes'] + CHUNK_BYTES - 1) // CHUNK_BYTES
            raw = b''.join(read_file(directory, f"definition-{ref['id']}-{index}", CHUNK_BYTES) for index in range(count))
            if len(raw) != ref['size_bytes'] or hashlib.sha256(raw).hexdigest() != ref['sha256']:
                raise ProtocolError('DefinitionDigestMismatch')
            value = validate_definition(load_json(raw, DEFINITION_BYTES), ref['kind'])
            if json_bytes(value, DEFINITION_BYTES) != raw:
                raise ProtocolError('NonCanonicalDefinition')
            result.append({'id': ref['id'], 'kind': ref['kind'], 'sha256': ref['sha256'], 'content': value})
    finally:
        os.close(directory)
    if result and result[0]['kind'] == 'agent':
        if result[0]['content']['skill_version_ids'] != [item['id'] for item in result[1:]]:
            raise ProtocolError('DefinitionDependenciesMismatch')
    return result


def seal(root, run_id):
    with locked(root) as directory:
        saved = envelope(root, run_id)
        definitions(root, saved)
        replay_write(directory, 'sealed', saved['request']['descriptor_sha256'].encode('ascii'))
    return {'run_id': run_id, 'state': 'sealed'}


def require_sealed(root, saved):
    if runner._read_bytes(root / 'sealed', 64) != saved['request']['descriptor_sha256'].encode('ascii'):
        raise ProtocolError('WorkbenchSealMismatch')


def start(root, run_id):
    with locked(root) as directory:
        saved = envelope(root, run_id)
        require_sealed(root, saved)
        definitions(root, saved)
        if saved['workbench']['remaining_ms'] <= 0 or (root / 'attempted').exists():
            raise ProtocolError('WorkbenchNotStartable')
        write_once(directory, 'start', run_id.encode('ascii'))
    return {'run_id': run_id, 'state': 'started'}


def status(root, run_id):
    validate_run_id(run_id)
    if not root.exists() or not (root / 'workbench.json').exists():
        return {'run_id': run_id, 'state': 'waiting', 'attempted': False, 'result': None}
    saved = envelope(root, run_id)
    attempted = (root / 'attempted').exists()
    result = None
    if (root / 'result.json').exists():
        result = validate_result(load_json(runner._read_bytes(root / 'result.json', 16384)))
        if not attempted or result['run_id'] != run_id or result['adapter'] != saved['request']['adapter']:
            raise ProtocolError('WorkbenchResultMismatch')
        state = 'finished'
    elif attempted:
        state = 'running'
    elif (root / 'start').exists():
        state = 'started'
    else:
        state = 'staged'
    return {'run_id': run_id, 'state': state, 'attempted': attempted, 'result': result}


def collect(root, run_id):
    current = status(root, run_id)
    if current['state'] != 'finished':
        raise ProtocolError('WorkbenchNotFinished')
    return {'result': current['result'], 'artifact_base64': None}


def mailbox(root, run_id):
    envelope(root, run_id)
    return WorkbenchMailbox(root, run_id).pending()


def reply(root, encoded):
    value = load_json(decode_base64(encoded, 65536))
    if not isinstance(value, dict):
        raise ProtocolError('InvalidWorkbenchReply')
    run_id = validate_run_id(value.get('run_id'))
    envelope(root, run_id)
    return WorkbenchMailbox(root, run_id).respond(encoded)


def execute(root, timeout=300):
    with locked(root) as directory:
        saved = envelope(root)
        require_sealed(root, saved)
        run_id = saved['request']['run_id']
        if read_file(directory, 'start', 128) != run_id.encode('ascii'):
            raise ProtocolError('WorkbenchStartMismatch')
        write_once(directory, 'attempted', b'')
    result = {'schema_version': 2, 'run_id': run_id, 'adapter': 'interactive', 'status': 'failed', 'exit_code': 1,
              'error_type': None, 'summary': '', 'usage': None, 'estimated_usd': None}
    process = None
    try:
        (root / 'output').mkdir(mode=0o700)
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--root', str(root), '_adapter', run_id],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            result['exit_code'] = process.wait(timeout=min(timeout, saved['workbench']['remaining_ms'] / 1000))
            if result['exit_code'] < 0:
                result['exit_code'] = 128 - result['exit_code']
        except subprocess.TimeoutExpired:
            runner._kill_group(process)
            result.update(status='timed_out', exit_code=124, error_type='ExecutionTimeout')
        finally:
            runner._kill_group(process)
        receipt = runner._receipt(root)
        if receipt is not None:
            result['usage'] = receipt['usage']
            result['estimated_usd'] = receipt['estimated_usd']
        if result['status'] == 'timed_out':
            pass
        elif result['exit_code'] != 0:
            result['error_type'] = 'AdapterFailed'
        elif receipt is None or receipt['stop_reason'] not in ('UNSPECIFIED', 'MAX_MODEL_CALLS_EXCEEDED') or result['usage'] is None or result['estimated_usd'] is None:
            result.update(exit_code=1, error_type='UsageUnavailable')
        else:
            proposal = load_json(runner._read_bytes(root / 'proposal.json', 8192))
            if __package__:
                from .adapters.workbench import validate_bound_proposal
            else:
                from adapters.workbench import validate_bound_proposal
            validate_bound_proposal(proposal, saved, definitions(root, saved))
            result['summary'] = proposal.get('text', proposal.get('purpose', ''))
            result['status'] = 'succeeded'
        validate_result(result)
    except BaseException as error:
        if process is not None:
            runner._kill_group(process)
        result.update(status='failed', exit_code=1, error_type=type(error).__name__, summary='')
        try:
            validate_result(result)
        except ProtocolError:
            result.update(usage=None, estimated_usd=None)
    validate_result(result)
    with locked(root) as directory:
        write_once(directory, 'result.json', json_bytes(result))
    return result


def run_adapter(root, run_id):
    saved = envelope(root, run_id)
    require_sealed(root, saved)
    with locked(root) as directory:
        read_file(directory, 'attempted', 1)
        write_once(directory, 'adapter-attempted', b'')
    bundle = definitions(root, saved)
    output = root / 'output'
    runner._directory(output)
    os.chdir(output)
    if __package__:
        from .adapters.workbench import run
    else:
        from adapters.workbench import run
    asyncio.run(run(saved, bundle, output, root / 'receipt.json'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/workspace/task'))
    parser.add_argument('command', choices=('stage', 'definition-chunk', 'seal', 'start', 'status', 'collect', 'mailbox', 'reply', '_adapter'))
    parser.add_argument('value')
    args = parser.parse_args()
    root = args.root.absolute()
    try:
        if args.command == '_adapter':
            run_adapter(root, args.value)
            return 0
        operation = {'stage': stage, 'definition-chunk': definition_chunk, 'seal': seal, 'start': start, 'status': status,
                     'collect': collect, 'mailbox': mailbox, 'reply': reply}[args.command]
        print(json_bytes(operation(root, args.value)).decode('utf-8'))
        return 0
    except BaseException as error:
        print(json_bytes({'error_type': type(error).__name__}).decode('utf-8'), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
