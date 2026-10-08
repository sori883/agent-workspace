import hashlib
import json
import os
import stat

if __package__:
    from .mailbox import read_file
    from .workbench_protocol import ProtocolError, text, validate_skill_context
else:
    from mailbox import read_file
    from workbench_protocol import ProtocolError, text, validate_skill_context


def objects(saved):
    context = saved['workbench']['descriptor'].get('skill_context', {})
    return context.get('objects', [])


def chunk_name(skill_id, path):
    return f"skill-{skill_id}-{hashlib.sha256(path.encode('utf-8')).hexdigest()}-0"


def bound_file(saved, skill_id, path):
    for item in objects(saved):
        if item['id'] == skill_id and path in item['loaded_paths']:
            return next(file for file in item['files'] if file['path'] == path)
    raise ProtocolError('SkillFileNotBound')


def checked_bytes(raw, metadata):
    if len(raw) != metadata['size_bytes'] or hashlib.sha256(raw).hexdigest() != metadata['sha256']:
        raise ProtocolError('SkillFileDigestMismatch')
    try:
        value = raw.decode('utf-8')
        text(value, 32768, False)
    except (UnicodeError, ProtocolError):
        raise ProtocolError('InvalidSkillFileText') from None
    return value


def main_instructions(raw, item):
    value = checked_bytes(raw, item['files'][0])
    quoted = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    header = f"---\nname: {quoted(item['name'])}\ndescription: {quoted(item['description'])}\n---\n\n"
    if not value.startswith(header) or not value.endswith('\n'):
        raise ProtocolError('InvalidSkillMarkdown')
    return text(value[len(header):-1], 16384)


def open_tree(parent, parts, create=False):
    current = os.dup(parent)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def read_materialized(root, item, metadata):
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = None
    try:
        parts = ['skills', f"skill-{item['id']}", *metadata['path'].split('/')]
        directory = open_tree(parent, parts[:-1])
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o222 or info.st_size != metadata['size_bytes']:
                raise ProtocolError('UnsafeSkillFile')
            raw = source.read(metadata['size_bytes'] + 1)
        checked_bytes(raw, metadata)
        return raw
    finally:
        if directory is not None:
            os.close(directory)
        os.close(parent)


def materialize(root, saved):
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        collected = []
        directories = set()
        for item in objects(saved):
            for path in item['loaded_paths']:
                metadata = bound_file(saved, item['id'], path)
                raw = read_file(parent, chunk_name(item['id'], path), 32768)
                checked_bytes(raw, metadata)
                if path == 'SKILL.md':
                    main_instructions(raw, item)
                collected.append((item, metadata, raw))
        for item, metadata, raw in collected:
            parts = ['skills', f"skill-{item['id']}", *metadata['path'].split('/')]
            directory = open_tree(parent, parts[:-1], create=True)
            try:
                try:
                    file = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444, dir_fd=directory)
                except FileExistsError:
                    if read_materialized(root, item, metadata) != raw:
                        raise ProtocolError('SkillFileReplayConflict')
                else:
                    with os.fdopen(file, 'wb') as output:
                        output.write(raw)
                        output.flush()
                        os.fsync(output.fileno())
                    os.fsync(directory)
                for length in range(1, len(parts)):
                    directories.add(tuple(parts[:length]))
            finally:
                os.close(directory)
        for parts in sorted(directories, key=len, reverse=True):
            directory = open_tree(parent, parts)
            try:
                os.fchmod(directory, 0o700)
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        os.close(parent)


def hydrate_context(saved, root=None):
    original = saved['workbench']['descriptor']['skill_context']
    if original['version'] == 1:
        return original
    context = {key: value for key, value in original.items() if key != 'objects'}
    context['version'] = 1
    context['loaded_skills'] = list(original['loaded_skills'])
    context['loaded_files'] = list(original['loaded_files'])
    for item in objects(saved):
        if root is None:
            raise ProtocolError('SkillFilesUnavailable')
        main = read_materialized(root, item, item['files'][0])
        context['loaded_skills'].append({key: item[key] for key in ('id', 'name', 'description')} | {
            'instructions': main_instructions(main, item),
            'files': [{key: file[key] for key in ('path', 'size_bytes', 'sha256')} for file in item['files'][1:]]})
        for path in item['loaded_paths'][1:]:
            metadata = bound_file(saved, item['id'], path)
            raw = read_materialized(root, item, metadata)
            context['loaded_files'].append({key: metadata[key] for key in ('path', 'size_bytes', 'sha256')} | {
                'skill_id': item['id'], 'content': raw.decode('utf-8')})
    return validate_skill_context(context)
