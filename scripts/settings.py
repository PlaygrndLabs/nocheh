"""Validated owner configuration operations, shared by dashboard and CLI."""
import fcntl
import hashlib
import json
import os
import subprocess
from pathlib import Path
try:
    from .configuration import load, validate, write_env, env_path, DEFAULTS
except ImportError:
    from configuration import load, validate, write_env, env_path, DEFAULTS

WORKFLOW_INTERNAL={'INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD','NOCHEH_WORKFLOWS_ENABLED'}
SECRETS = {'TELEGRAM_BOT_TOKEN', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN','OPENAI_API_KEY'} | (WORKFLOW_INTERNAL-{'NOCHEH_WORKFLOWS_ENABLED'})
# These settings belong to the separately managed Honcho stack, not main Apply.
HONCHO_SETTINGS={'OPENAI_API_KEY','NOCHEH_EMBEDDING_PROVIDER','NOCHEH_EMBEDDING_MODEL'}
EDITABLE = set(DEFAULTS) - {'NOCHEH_CONFIG_VERSION', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN'} - HONCHO_SETTINGS - WORKFLOW_INTERNAL


def revision(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def view(state):
    values = load(state)
    applied = Path(state) / 'admin/applied.json'
    saved_revision = revision(values)
    active = json.loads(applied.read_text()).get('revision') if applied.exists() else None
    fields = [{'key': key, 'value': None if key in SECRETS else values[key],
               'configured': bool(values[key]), 'secret': key in SECRETS,
               'editable': key in EDITABLE, 'source': '.env', 'takes_effect': 'Honcho stack restart' if key in HONCHO_SETTINGS else 'apply / service restart'}
              for key in DEFAULTS]
    return {'revision': saved_revision, 'applied_revision': active,
            'apply_state': 'current' if active == saved_revision else 'pending' if active else 'unverified',
            'fields': fields}


def save(state, changes, expected):
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        if expected != revision(current): raise ValueError('configuration_conflict')
        if not isinstance(changes, dict) or set(changes) - EDITABLE: raise ValueError('unsupported_setting')
        if any(not isinstance(v, str) for v in changes.values()): raise ValueError('settings_must_be_strings')
        updated = {**current, **changes}; validate(updated)
        # Preserve the last applied baseline across multiple un-applied saves.
        previous = directory / 'previous.env'
        if not previous.exists(): write_env(previous, current)
        write_env(env_path(state), updated)
    return view(state)


def apply(state):
    try:
        from .operations import compose, environment
        from .configuration import read_env
    except ImportError:
        from operations import compose, environment
        from configuration import read_env
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        values = load(state); validate(values)
        command = compose(state) + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180',
                                    'nocheh-postgres', 'nocheh-app', 'nocheh-security', 'hermes-runtime']
        def run():
            return subprocess.run(command, env=environment(state), stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=420).returncode == 0
        try: ok = run()
        except subprocess.TimeoutExpired: ok = False
        previous = directory / 'previous.env'
        if not ok:
            rolled_back = False
            if previous.exists():
                write_env(env_path(state), read_env(previous))
                try: rolled_back = run()
                except subprocess.TimeoutExpired: pass
            return {'status': 'apply_failed', 'rolled_back': rolled_back}
        temporary = directory / 'applied.tmp'
        temporary.write_text(json.dumps({'revision': revision(values)})); temporary.chmod(0o600)
        temporary.replace(directory / 'applied.json')
        previous.unlink(missing_ok=True)
    return {'status': 'applied', **view(state)}
