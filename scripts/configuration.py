"""One editable .env for local Compose; credentials never appear in command arguments."""
import json
import os
import re
import secrets
from pathlib import Path
try:
    from .embedding_config import DEFAULTS as EMBEDDING_DEFAULTS, embeddings
except ImportError:
    from embedding_config import DEFAULTS as EMBEDDING_DEFAULTS, embeddings

ROOT = Path(__file__).resolve().parents[1]
INSTALLATION_ROOT = Path(os.environ.get('NOCHEH_INSTALLATION_ROOT', ROOT)).resolve()
DEFAULT_STATE = INSTALLATION_ROOT / 'data/local'
DEFAULTS = {
    'NOCHEH_CONFIG_VERSION': '1', 'NOCHEH_PORT': '8780', 'NOCHEH_PROVIDER_MONITOR_PORT': '18317', 'NOCHEH_MODEL': 'gpt-5.6-sol',
    'NOCHEH_GUARD_MODE': 'on', 'NOCHEH_REASONING_ROUTE': 'shared', 'NOCHEH_SECURITY_RUNTIME': 'isolated', 'NOCHEH_MEMORY_CONTEXT': 'evidence',
    'NOCHEH_GUARD_TRUSTED_ENDPOINTS': '["https://chatgpt.com/backend-api/codex","http://cliproxy-api:8317/v1"]',
    'TELEGRAM_ENABLED': 'false', 'TELEGRAM_BOT_TOKEN': '', 'TELEGRAM_OWNER_ID': '',
    'TELEGRAM_GROUP_IDS': '', 'TELEGRAM_GROUP_ACCESS': '{}', 'POSTGRES_PASSWORD': '', 'SERVICE_TOKEN': '',
    'NOCHEH_STORAGE_LAYOUT': 'legacy',
    'NOCHEH_ARCHIVE_PASSWORD': '', 'NOCHEH_DERIVED_PASSWORD': '', 'NOCHEH_CONTROL_PASSWORD': '',
    'NOCHEH_WORKFLOW_UI_PORT': '8288',
    'NOCHEH_HONCHO_ENABLED': 'false',
    'INNGEST_EVENT_KEY': '', 'INNGEST_SIGNING_KEY': '', 'INNGEST_POSTGRES_PASSWORD': '',
    **EMBEDDING_DEFAULTS,
}


def env_path(state):
    state = Path(state).resolve()
    return INSTALLATION_ROOT / '.env' if state == DEFAULT_STATE else state / '.env'


def compose_command(state, project=None):
    command=['docker','compose','--env-file',str(env_path(state)),'-f',str(INSTALLATION_ROOT/'docker-compose.yml')]
    layout=read_env(env_path(state)).get('NOCHEH_STORAGE_LAYOUT','legacy')
    if layout not in ('legacy','original-only-v1'):raise ValueError('Invalid NOCHEH_STORAGE_LAYOUT')
    if layout=='original-only-v1':command+=['-f',str(INSTALLATION_ROOT/'deploy/original-only-compose.yml')]
    if project:command+=['-p',project]
    return command


def archive_url(state):
    return 'http://nocheh-app:8780' if os.environ.get('NOCHEH_CONTAINER')=='1' else 'http://127.0.0.1:'+load(state)['NOCHEH_PORT']


def native_endpoint(state):
    return ('hermes',8785) if os.environ.get('NOCHEH_CONTAINER')=='1' else ('127.0.0.1',int(os.environ.get('NOCHEH_NATIVE_ADMIN_PORT') or native_admin_port(state)))


def read_env(path):
    """Read literal, single-line dotenv settings; never execute or expand a value."""
    result = {}
    if not Path(path).exists(): return result
    for number, line in enumerate(Path(path).read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'): continue
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)', line)
        if not match: raise ValueError(f'Invalid environment setting on line {number}')
        key, value = match.groups()
        if value.startswith("'"):
            match = re.fullmatch(r"'((?:\\'|[^'])*)'\s*(?:#.*)?", value)
            if not match: raise ValueError(f'Invalid quoted setting on line {number}')
            value = match[1].replace("\\'", "'")
        elif value.startswith('"'):
            try:
                value, end = json.JSONDecoder().raw_decode(value)
                suffix = match[2][end:].strip()
                if suffix and not suffix.startswith('#'): raise ValueError()
            except ValueError: raise ValueError(f'Invalid quoted setting on line {number}') from None
        else: value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
        if '\n' in value or '\r' in value or '\0' in value: raise ValueError(f'Multiline setting on line {number} is unsupported')
        if key in result: raise ValueError(f'Duplicate environment setting: {key}')
        result[key] = value
    return result


def write_env(path, values):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lines = ['# Nocheh: edit this file, then run ./scripts/nocheh up.',
             '# Single quotes preserve literal values, including dollar signs.', '']
    for key, value in values.items():
        if not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key) or any(c in value for c in '\r\n\0'):
            raise ValueError('Invalid environment setting')
        lines.append(key + "='" + value.replace("'", "\\'") + "'")
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as file:
        temporary.chmod(0o600); file.write('\n'.join(lines) + '\n'); file.flush(); os.fsync(file.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def load(state):
    values = read_env(env_path(state))
    if values.get('NOCHEH_CONFIG_VERSION') != '1': raise ValueError('Run ./scripts/nocheh init to prepare the active .env')
    if 'OPENAI_API_KEY' not in values and 'NOCHEH_EMBEDDING_API_KEY' in values:values['OPENAI_API_KEY']=values['NOCHEH_EMBEDDING_API_KEY']
    values={**DEFAULTS,**values}
    values.pop('NOCHEH_WORKFLOWS_ENABLED',None)  # Retired migration setting.
    if values.get('NOCHEH_GUARD_MODE')=='auto': values['NOCHEH_GUARD_MODE']='on'
    return values


def group_access(values):
    try:
        access = json.loads(values.get('TELEGRAM_GROUP_ACCESS', '{}'))
    except (TypeError, ValueError):
        raise ValueError('Invalid TELEGRAM_GROUP_ACCESS') from None
    groups = {group.strip() for group in values.get('TELEGRAM_GROUP_IDS', '').split(',') if group.strip()}
    owner = values.get('TELEGRAM_OWNER_ID', '')
    if not isinstance(access, dict) or len(access) > 100:
        raise ValueError('Invalid TELEGRAM_GROUP_ACCESS')
    result = {}
    for group, entry in access.items():
        if group not in groups or not isinstance(entry, dict) or set(entry) != {'granted', 'denied'}:
            raise ValueError('Invalid TELEGRAM_GROUP_ACCESS')
        normalized = {}
        for decision in ('granted', 'denied'):
            users = entry[decision]
            if (not isinstance(users, list) or len(users) > 1000 or
                    any(not isinstance(user, str) or not re.fullmatch(r'[1-9]\d{0,18}', user) or user == owner for user in users)):
                raise ValueError('Invalid TELEGRAM_GROUP_ACCESS')
            normalized[decision] = sorted(set(users))
        result[group] = normalized
    return result


def validate(values):
    embeddings(values)
    layout=values.get('NOCHEH_STORAGE_LAYOUT','legacy')
    if layout not in ('legacy','original-only-v1'):raise ValueError('Invalid NOCHEH_STORAGE_LAYOUT')
    storage=[values.get('NOCHEH_'+name+'_PASSWORD','') for name in ('ARCHIVE','DERIVED','CONTROL')]
    if any(value and not re.fullmatch('[a-f0-9]{64}',value) for value in storage):raise ValueError('Invalid storage credential')
    if layout=='original-only-v1' and (not all(storage) or len(set(storage+[values.get('POSTGRES_PASSWORD'),values.get('INNGEST_POSTGRES_PASSWORD')]))!=5):raise ValueError('Separate storage credentials required')
    if values.get('NOCHEH_HONCHO_ENABLED','false') not in ('true','false'):raise ValueError('Invalid NOCHEH_HONCHO_ENABLED')
    if not str(values.get('NOCHEH_WORKFLOW_UI_PORT','8288')).isdigit() or not 1024<=int(values.get('NOCHEH_WORKFLOW_UI_PORT','8288'))<=65535:raise ValueError('Invalid NOCHEH_WORKFLOW_UI_PORT')
    for name in ('INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD'):
        if values.get(name) and not re.fullmatch('[a-f0-9]{64}',values[name]):raise ValueError('Invalid '+name)
        if not values.get(name):raise ValueError('Missing '+name)
    if values.get('NOCHEH_SECURITY_RUNTIME','legacy') not in ('legacy','isolated'):raise ValueError('NOCHEH_SECURITY_RUNTIME must be legacy or isolated')
    if values.get('NOCHEH_MEMORY_CONTEXT','legacy') not in ('legacy','evidence'):raise ValueError('NOCHEH_MEMORY_CONTEXT must be legacy or evidence')
    if values['TELEGRAM_ENABLED'] not in ('true', 'false'): raise ValueError('TELEGRAM_ENABLED must be true or false')
    owner = values['TELEGRAM_OWNER_ID']; groups = values['TELEGRAM_GROUP_IDS']
    if owner and not re.fullmatch(r'[1-9]\d{0,18}', owner): raise ValueError('TELEGRAM_OWNER_ID must be a numeric user ID')
    if groups and any(not re.fullmatch(r'-[1-9]\d{0,18}', g.strip()) for g in groups.split(',')): raise ValueError('TELEGRAM_GROUP_IDS must contain negative numeric IDs separated by commas')
    group_access(values)
    if values['TELEGRAM_ENABLED'] == 'true' and (not owner or not values['TELEGRAM_BOT_TOKEN']): raise ValueError('Enabling Telegram requires TELEGRAM_OWNER_ID and TELEGRAM_BOT_TOKEN')
    if values['NOCHEH_GUARD_MODE'] not in ('off', 'on'): raise ValueError('NOCHEH_GUARD_MODE must be off or on')
    if values['NOCHEH_REASONING_ROUTE'] not in ('native', 'shared'): raise ValueError('NOCHEH_REASONING_ROUTE must be native or shared')
    from urllib.parse import urlsplit
    endpoints = json.loads(values['NOCHEH_GUARD_TRUSTED_ENDPOINTS'])
    if not isinstance(endpoints, list) or any(not isinstance(v,str) or urlsplit(v).scheme not in ('http','https') or not urlsplit(v).netloc for v in endpoints): raise ValueError('Invalid trusted endpoints')
    if not values['NOCHEH_MODEL'].strip(): raise ValueError('NOCHEH_MODEL is required')
    if not values['NOCHEH_PORT'].isdigit() or not 1024 <= int(values['NOCHEH_PORT']) <= 65535: raise ValueError('Invalid NOCHEH_PORT')
    if not values['NOCHEH_PROVIDER_MONITOR_PORT'].isdigit() or not 1024 <= int(values['NOCHEH_PROVIDER_MONITOR_PORT']) <= 65535: raise ValueError('Invalid NOCHEH_PROVIDER_MONITOR_PORT')
    for name in ('POSTGRES_PASSWORD', 'SERVICE_TOKEN'):
        if len(values[name]) < 24: raise ValueError(f'{name} must contain at least 24 characters')


def initialize(state):
    state = Path(state).resolve()
    for name in ('files', 'spool', 'hermes', 'reports'): (state / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    path = env_path(state); existing = read_env(path)
    values = dict(DEFAULTS)
    # Preserve the already-tested rebuild's generated credentials during this
    # setup simplification. Unrelated legacy provider keys are never reused.
    active = existing.get('NOCHEH_CONFIG_VERSION') == '1'
    previous = {} if active else read_env(state / 'compose.env')
    values.update({k:v for k,v in previous.items() if k in DEFAULTS or k in ('NOCHEH_UID','NOCHEH_GID')})
    policy = state / 'assistant.json'
    if not active and policy.exists():
        data = json.loads(policy.read_text())
        values.update(TELEGRAM_ENABLED=str(data['enabled']).lower(), TELEGRAM_OWNER_ID=data.get('owner_id') or '', TELEGRAM_GROUP_IDS=','.join(data['group_ids']))
    for name, old in [('POSTGRES_PASSWORD','database_password'),('SERVICE_TOKEN','service_token'),('TELEGRAM_BOT_TOKEN','telegram_bot_token')]:
        file = state / 'secrets' / old
        if not active and file.exists(): values[name] = file.read_text().strip()
    if active: values.update(existing)
    values.pop('NOCHEH_WORKFLOWS_ENABLED',None)
    if active and 'OPENAI_API_KEY' not in existing and 'NOCHEH_EMBEDDING_API_KEY' in existing:values['OPENAI_API_KEY']=existing['NOCHEH_EMBEDDING_API_KEY']
    if values.get('NOCHEH_GUARD_MODE')=='auto': values['NOCHEH_GUARD_MODE']='on'
    values.setdefault('NOCHEH_UID', str(os.getuid())); values.setdefault('NOCHEH_GID', str(os.getgid()))
    for name in ('POSTGRES_PASSWORD','SERVICE_TOKEN','INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD','NOCHEH_ARCHIVE_PASSWORD','NOCHEH_DERIVED_PASSWORD','NOCHEH_CONTROL_PASSWORD'):
        if not values[name]: values[name] = secrets.token_hex(32)
    validate(values)
    (state/'workflows/redis').mkdir(parents=True,exist_ok=True,mode=0o700)
    if not active and existing:
        preserved = state / 'previous-configuration'; preserved.mkdir(exist_ok=True, mode=0o700)
        saved = preserved / 'legacy.env'
        if saved.exists(): raise ValueError('Legacy environment backup already exists; refusing to overwrite it')
        path.rename(saved); saved.chmod(0o600)
        print('Preserved the old environment in the private state directory; unrelated provider keys were not imported.')
    if values != existing: write_env(path, values)
    path.chmod(0o600)
    try: from .provider import initialize as initialize_provider
    except ImportError: from provider import initialize as initialize_provider
    initialize_provider(state)
    return values


def native_admin_port(state):
    port = int(load(state).get('NOCHEH_PORT', '8780'))
    return port + 5 if port <= 65530 else port - 5


def compose_environment(state):
    # Explicit settings win over stale shell exports. Only Compose's selected
    # variables enter service containers; the full host environment is not passed.
    result = dict(os.environ); result.update(load(state))
    result['NOCHEH_NATIVE_ADMIN_PORT'] = str(native_admin_port(state))
    result['NOCHEH_STATE_DIR'] = str(Path(state).resolve())
    result['NOCHEH_INSTALLATION_ROOT'] = str(INSTALLATION_ROOT)
    result['NOCHEH_DASHBOARD_PORT'] = load(state).get('NOCHEH_DASHBOARD_PORT') or str(int(result['NOCHEH_PORT'])+3 if int(result['NOCHEH_PORT'])<=65532 else int(result['NOCHEH_PORT'])-3)
    # Profiles are explicit per installation; a stale shell cannot activate workflows.
    profiles=[v for v in result.get('COMPOSE_PROFILES','').split(',') if v and v not in ('workflows','honcho','honcho-tools')]
    if result.get('NOCHEH_HONCHO_ENABLED')=='true' and not (Path(state)/'spool/.restore-inactive').exists():profiles.append('honcho')
    result['NOCHEH_HONCHO_STATE_DIR']=load(state).get('NOCHEH_HONCHO_STATE_DIR') or str(Path(state).resolve()/'honcho')
    result['COMPOSE_PROFILES']=','.join(profiles)
    return result
