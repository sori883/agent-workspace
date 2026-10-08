import base64
import binascii
import hashlib
import re

if __package__:
    from .interactive_protocol import UUID_PATTERN, json_bytes, load_json
    from .protocol import IDENTIFIER_PATTERN, ProtocolError, _text_size, is_nonnegative_number, validate_run_id
else:
    from interactive_protocol import UUID_PATTERN, json_bytes, load_json
    from protocol import IDENTIFIER_PATTERN, ProtocolError, _text_size, is_nonnegative_number, validate_run_id

CHUNK_BYTES = 32768
DEFINITION_BYTES = 131072
FILE_BYTES = 8388608
POLICY = 'workbench-trial-2026-10-07-v1'
MODEL_PROFILE = 'gemini-3.1-flash-lite-standard-2026-10-07-v1'
HASH = re.compile(r'[0-9a-f]{64}\Z')
ALIAS = re.compile(r'[a-z][a-z0-9_]{0,63}\Z')
OUTPUT = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,58}\.(csv|xlsx)\Z')
SKILL_PATH = re.compile(r'(references|scripts|assets)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\Z')
SKILL_NAME = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z')
BUILTIN_SKILLS = ('general-v1', 'tabular-v1')
USAGE_KEYS = {'prompt_token_count', 'candidates_token_count', 'thoughts_token_count', 'total_token_count', 'model_call_count'}


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names.split()):
        raise ProtocolError('InvalidWorkbenchFields')
    return value


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ProtocolError('InvalidWorkbenchNumber')
    return value


def text(value, limit, required=True):
    if _text_size(value) > limit or required and not value.strip():
        raise ProtocolError('InvalidWorkbenchText')
    return value


def pattern(value, regex):
    if not isinstance(value, str) or not regex.fullmatch(value):
        raise ProtocolError('InvalidWorkbenchIdentifier')
    return value


def array(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        raise ProtocolError('InvalidWorkbenchArray')
    return value


def unique(values):
    if len(values) != len(set(values)):
        raise ProtocolError('DuplicateWorkbenchValue')


def decode_base64(value, limit):
    if not isinstance(value, str) or len(value) > 4 * ((limit + 2) // 3):
        raise ProtocolError('WorkbenchFrameTooLarge')
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ProtocolError('InvalidWorkbenchEncoding') from None
    if len(raw) > limit or base64.b64encode(raw).decode('ascii') != value:
        raise ProtocolError('InvalidWorkbenchEncoding')
    return raw


def decode_frame(encoded):
    if not isinstance(encoded, str) or len(encoded) > 65536:
        raise ProtocolError('WorkbenchFrameTooLarge')
    return load_json(decode_base64(encoded, 49152), 49152)


def digest(value):
    return hashlib.sha256(json_bytes(value)).hexdigest()


def validate_request(value):
    fields(value, 'schema_version run_id root_id adapter checkpoint_revision descriptor_sha256')
    integer(value['schema_version'], 2, 2)
    validate_run_id(value['run_id'])
    pattern(value['root_id'], UUID_PATTERN)
    if value['adapter'] not in ('interactive', 'python'):
        raise ProtocolError('InvalidWorkbenchAdapter')
    integer(value['checkpoint_revision'], 0, 32)
    pattern(value['descriptor_sha256'], HASH)
    return value


def validate_proposal(value, unused=None):
    if not isinstance(value, dict):
        raise ProtocolError('InvalidWorkbenchProposal')
    if value.get('kind') == 'read_skills':
        fields(value, 'kind skill_ids')
        ids = array(value['skill_ids'], 8)
        if not ids:
            raise ProtocolError('MissingSkillReference')
        for skill_id in ids:
            if skill_id not in BUILTIN_SKILLS:
                pattern(skill_id, UUID_PATTERN)
        unique(ids)
    elif value.get('kind') == 'read_skill_file':
        fields(value, 'kind skill_id path')
        pattern(value['skill_id'], UUID_PATTERN)
        pattern(value['path'], SKILL_PATH)
        text(value['path'], 255)
    elif value.get('kind') != 'python':
        fields(value, 'kind text')
        if value['kind'] not in ('question', 'output', 'unsupported'):
            raise ProtocolError('InvalidWorkbenchProposal')
        text(value['text'], 2048)
    else:
        fields(value, 'kind source input_aliases outputs purpose')
        text(value['source'], 4096)
        text(value['purpose'], 2048)
        aliases = array(value['input_aliases'], 4)
        for alias in aliases:
            pattern(alias, ALIAS)
        unique(aliases)
        outputs = array(value['outputs'], 4)
        if not outputs:
            raise ProtocolError('MissingWorkbenchOutput')
        total = 0
        for output in outputs:
            fields(output, 'name size_limit_bytes')
            pattern(output['name'], OUTPUT)
            total += integer(output['size_limit_bytes'], 1, FILE_BYTES)
        unique([output['name'] for output in outputs])
        if total > FILE_BYTES:
            raise ProtocolError('WorkbenchOutputTooLarge')
    return value


def validate_skill_context(value):
    version = value.get('version') if isinstance(value, dict) else None
    fields(value, 'version catalog omitted_count loaded_skills loaded_files builtin_skill_ids' + (' objects' if version == 2 else ''))
    integer(value['version'], 1, 2)
    integer(value['omitted_count'], 0, 2147483647)
    catalog = array(value['catalog'], 32)
    if len(json_bytes(catalog)) > 8192:
        raise ProtocolError('SkillCatalogTooLarge')
    loaded = array(value['loaded_skills'], 8)
    for entries, names in ((catalog, 'id name description'), (loaded, 'id name description instructions files')):
        for item in entries:
            fields(item, names)
            pattern(item['id'], UUID_PATTERN)
            pattern(item['name'], SKILL_NAME)
            text(item['name'], 64)
            text(item['description'], 1024, False)
    unique([item['id'] for item in catalog])
    unique([item['id'] for item in loaded])
    summaries = {item['id']: item for item in catalog}
    file_refs = {}
    for item in loaded:
        if item['id'] in summaries and any(item[key] != summaries[item['id']][key] for key in ('name', 'description')):
            raise ProtocolError('SkillSummaryMismatch')
        text(item['instructions'], 16384)
        files = array(item['files'], 16)
        for ref in files:
            fields(ref, 'path size_bytes sha256')
            pattern(ref['path'], SKILL_PATH)
            text(ref['path'], 255)
            integer(ref['size_bytes'], 0, 32768)
            pattern(ref['sha256'], HASH)
            file_refs[(item['id'], ref['path'])] = ref
        unique([ref['path'] for ref in files])
    loaded_files = array(value['loaded_files'], 128)
    for item in loaded_files:
        fields(item, 'skill_id path content size_bytes sha256')
        pattern(item['skill_id'], UUID_PATTERN)
        pattern(item['path'], SKILL_PATH)
        text(item['path'], 255)
        text(item['content'], 32768, False)
        integer(item['size_bytes'], 0, 32768)
        pattern(item['sha256'], HASH)
        raw = item['content'].encode('utf-8')
        ref = file_refs.get((item['skill_id'], item['path']))
        if ref is None or any(ref[key] != item[key] for key in ('size_bytes', 'sha256')) or len(raw) != item['size_bytes'] or hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ProtocolError('SkillFileMismatch')
    unique([(item['skill_id'], item['path']) for item in loaded_files])
    builtins = array(value['builtin_skill_ids'], 2)
    if any(item not in BUILTIN_SKILLS for item in builtins):
        raise ProtocolError('UnknownBuiltinSkill')
    unique(builtins)
    objects = array(value['objects'], 8) if version == 2 else []
    for item in objects:
        validate_skill_object(item)
        if item['id'] in summaries and any(item[key] != summaries[item['id']][key] for key in ('name', 'description')):
            raise ProtocolError('SkillSummaryMismatch')
    unique([item['id'] for item in loaded + objects])
    if len(loaded) + len(objects) + ('tabular-v1' in builtins) > 8:
        raise ProtocolError('TooManySkills')
    return value


def validate_skill_object(value):
    fields(value, 'id name description content_sha256 source files loaded_paths')
    pattern(value['id'], UUID_PATTERN)
    pattern(value['name'], SKILL_NAME)
    text(value['name'], 64)
    text(value['description'], 1024, False)
    pattern(value['content_sha256'], HASH)
    source = fields(value['source'], 'type store_id revision_id manifest_key manifest_sha256 manifest_bytes total_bytes')
    if source['type'] != 'skill-object-v1':
        raise ProtocolError('InvalidSkillSource')
    pattern(source['store_id'], re.compile(r'[a-z0-9][a-z0-9-]{0,63}\Z'))
    pattern(source['revision_id'], UUID_PATTERN)
    pattern(source['manifest_sha256'], HASH)
    integer(source['manifest_bytes'], 1, 16384)
    integer(source['total_bytes'], 1, 163840)
    key = pattern(source['manifest_key'], re.compile(r'workspaces/([0-9a-f-]{36})/skills/([0-9a-f-]{36})/revisions/([0-9a-f-]{36})/manifest\.json\Z'))
    parts = key.split('/')
    for index in (1, 3, 5):
        pattern(parts[index], UUID_PATTERN)
    if parts[5] != source['revision_id']:
        raise ProtocolError('SkillRevisionMismatch')
    files = array(value['files'], 17)
    if not files or files[0].get('path') != 'SKILL.md' or files[0].get('size_bytes', 0) < 1:
        raise ProtocolError('SkillMainMissing')
    for file in files:
        fields(file, 'path size_bytes media_type sha256')
        if file['path'] != 'SKILL.md':
            pattern(file['path'], SKILL_PATH)
            text(file['path'], 255)
        integer(file['size_bytes'], 0, 32768)
        pattern(file['sha256'], HASH)
        if file['media_type'] != 'text/plain; charset=utf-8':
            raise ProtocolError('SkillMediaTypeMismatch')
    unique([file['path'] for file in files])
    paths = [file['path'] for file in files]
    if any(left.startswith(right + '/') for left in paths for right in paths if left != right):
        raise ProtocolError('SkillPathCollision')
    paths = array(value['loaded_paths'], 17)
    if not paths or paths[0] != 'SKILL.md' or any(path not in [file['path'] for file in files] for path in paths):
        raise ProtocolError('SkillFileNotBound')
    unique(paths)
    if sum(file['size_bytes'] for file in files) + source['manifest_bytes'] != source['total_bytes']:
        raise ProtocolError('SkillSizeMismatch')
    return value


def validate_envelope(value):
    fields(value, 'request workbench')
    request = validate_request(value['request'])
    workbench = fields(value['workbench'], 'version attempt_kind execution_policy mode profile_id remaining_ms descriptor')
    integer(workbench['version'], 2, 2)
    if workbench['execution_policy'] != POLICY:
        raise ProtocolError('InvalidWorkbenchPolicy')
    if (workbench['mode'], workbench['profile_id']) not in (('preview', 'preview-v1'), ('model', MODEL_PROFILE)):
        raise ProtocolError('InvalidWorkbenchMode')
    integer(workbench['remaining_ms'], 0, 300000)
    descriptor = workbench['descriptor']
    has_skills = isinstance(descriptor, dict) and 'skill_context' in descriptor
    fields(descriptor, 'version root_id instruction definition_manifest code_profile inputs outputs history code' + (' skill_context' if has_skills else ''))
    integer(descriptor['version'], 2, 2)
    if descriptor['root_id'] != request['root_id'] or len(json_bytes(descriptor)) > 40960 or digest(descriptor) != request['descriptor_sha256']:
        raise ProtocolError('WorkbenchDescriptorMismatch')
    text(descriptor['instruction'], 2048)
    refs = array(descriptor['definition_manifest'], 9)
    agents = 0
    for index, ref in enumerate(refs):
        fields(ref, 'id sha256 size_bytes kind')
        pattern(ref['id'], UUID_PATTERN)
        pattern(ref['sha256'], HASH)
        integer(ref['size_bytes'], 1, DEFINITION_BYTES)
        if ref['kind'] == 'agent' and index == 0:
            agents += 1
        elif ref['kind'] != 'skill':
            raise ProtocolError('InvalidDefinitionOrder')
    if len(refs) - agents > 8:
        raise ProtocolError('TooManySkills')
    unique([ref['id'] for ref in refs])
    if has_skills:
        if refs or workbench['attempt_kind'] != 'runtime':
            raise ProtocolError('InvalidSkillContextBinding')
        validate_skill_context(descriptor['skill_context'])
    inputs = array(descriptor['inputs'], 16)
    for item in inputs:
        fields(item, 'alias file_id name size_bytes sha256')
        pattern(item['alias'], ALIAS)
        pattern(item['file_id'], UUID_PATTERN)
        pattern(item['sha256'], HASH)
        text(item['name'], 255)
        if item['name'].strip() != item['name'] or any(ord(c) < 32 or ord(c) == 127 or c in '/\\' for c in item['name']) or not item['name'].lower().endswith(('.csv', '.xlsx')):
            raise ProtocolError('InvalidWorkbenchFilename')
        integer(item['size_bytes'], 1, FILE_BYTES)
    unique([item['alias'] for item in inputs])
    unique([item['file_id'] for item in inputs])
    outputs = array(descriptor['outputs'], 4)
    for item in outputs:
        fields(item, 'alias name size_limit_bytes')
        pattern(item['alias'], ALIAS)
        pattern(item['name'], OUTPUT)
        integer(item['size_limit_bytes'], 1, FILE_BYTES)
    unique([item['alias'] for item in outputs])
    unique([item['name'] for item in outputs])
    if sum(item['size_limit_bytes'] for item in outputs) > FILE_BYTES:
        raise ProtocolError('WorkbenchOutputTooLarge')
    history = array(descriptor['history'], 17)
    if len(json_bytes(history)) > 16384:
        raise ProtocolError('WorkbenchHistoryTooLarge')
    for item in history:
        fields(item, 'kind text')
        pattern(item['kind'], IDENTIFIER_PATTERN)
        text(item['text'], 8192, False)
    if workbench['attempt_kind'] == 'runtime':
        if request['adapter'] != 'interactive' or descriptor['code_profile'] is not None or descriptor['code'] is not None or outputs:
            raise ProtocolError('InvalidRuntimeDescriptor')
    elif workbench['attempt_kind'] == 'python':
        if request['adapter'] != 'python' or descriptor['code_profile'] != 'host-quota-8m-v1' or not outputs or len(inputs) > 4 or sum(item['size_bytes'] for item in inputs) > FILE_BYTES:
            raise ProtocolError('InvalidCodeDescriptor')
        proposal = validate_proposal(descriptor['code'])
        if proposal['kind'] != 'python' or proposal['input_aliases'] != [item['alias'] for item in inputs] or proposal['outputs'] != [{k: item[k] for k in ('name', 'size_limit_bytes')} for item in outputs]:
            raise ProtocolError('CodeDescriptorMismatch')
    else:
        raise ProtocolError('InvalidWorkbenchAttempt')
    return value


def validate_definition(value, kind):
    if kind == 'agent':
        fields(value, 'name instructions skill_version_ids allowed_tools')
        text(value['name'], 256)
        for version_id in array(value['skill_version_ids'], 8):
            pattern(version_id, UUID_PATTERN)
        unique(value['skill_version_ids'])
        if value['allowed_tools'] not in ([], ['python']):
            raise ProtocolError('InvalidDefinitionTools')
    elif kind == 'skill':
        fields(value, 'name description instructions files')
        pattern(value['name'], re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z'))
        text(value['name'], 64)
        text(value['description'], 1024, False)
        for item in array(value['files'], 16):
            fields(item, 'path content')
            pattern(item['path'], SKILL_PATH)
            text(item['path'], 255)
            text(item['content'], 32768, False)
        unique([item['path'] for item in value['files']])
    else:
        raise ProtocolError('InvalidDefinitionKind')
    text(value['instructions'], 16384)
    json_bytes(value, DEFINITION_BYTES)
    return value


def validate_result(value):
    fields(value, 'schema_version run_id adapter status exit_code error_type summary usage estimated_usd')
    integer(value['schema_version'], 2, 2)
    validate_run_id(value['run_id'])
    if value['adapter'] not in ('interactive', 'python') or value['status'] not in ('succeeded', 'failed', 'timed_out'):
        raise ProtocolError('InvalidWorkbenchResult')
    integer(value['exit_code'], 0, 255)
    text(value['summary'], 8192, False)
    if value['error_type'] is not None:
        pattern(value['error_type'], IDENTIFIER_PATTERN)
    if value['usage'] is not None:
        if not isinstance(value['usage'], dict) or set(value['usage']) != USAGE_KEYS:
            raise ProtocolError('InvalidWorkbenchUsage')
        for count in value['usage'].values():
            integer(count, 0, 1000000)
    if value['estimated_usd'] is not None and not is_nonnegative_number(value['estimated_usd']):
        raise ProtocolError('InvalidWorkbenchCost')
    if value['status'] == 'succeeded':
        if value['exit_code'] != 0 or value['error_type'] is not None or value['usage'] is None or value['estimated_usd'] is None:
            raise ProtocolError('InvalidWorkbenchSuccess')
    elif value['exit_code'] == 0:
        raise ProtocolError('InvalidWorkbenchFailure')
    return value
