"""Validated owner configuration operations, shared by dashboard and CLI."""
import fcntl
import hashlib
import json
import os
import subprocess
from pathlib import Path
try:
    from tools.operations.installation.configuration import load, validate, write_env, env_path, DEFAULTS
except ImportError:
    from tools.operations.installation.configuration import load, validate, write_env, env_path, DEFAULTS

WORKFLOW_INTERNAL={'INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD'}
STORE_INTERNAL={'NOCHEH_ARCHIVE_PASSWORD','NOCHEH_DERIVED_PASSWORD','NOCHEH_CONTROL_PASSWORD'}
SECRETS = {'TELEGRAM_BOT_TOKEN', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN','OPENAI_API_KEY'} | WORKFLOW_INTERNAL | STORE_INTERNAL
# These settings belong to the separately managed Honcho stack, not main Apply.
HONCHO_SETTINGS={'OPENAI_API_KEY','NOCHEH_EMBEDDING_PROVIDER','NOCHEH_EMBEDDING_MODEL'}
# The owner chooses both models in Settings; Apply also refreshes Honcho with them.
MODEL_SETTINGS={'NOCHEH_MODEL','NOCHEH_EMBEDDING_MODEL'}
EDITABLE = (set(DEFAULTS) - {'NOCHEH_CONFIG_VERSION', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN','NOCHEH_STORAGE_LAYOUT'} - HONCHO_SETTINGS - WORKFLOW_INTERNAL - STORE_INTERNAL) | MODEL_SETTINGS


def revision(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def view(state):
    values = load(state)
    applied = Path(state) / 'admin/applied.json'
    saved_revision = revision(values)
    active = json.loads(applied.read_text()).get('revision') if applied.exists() else None
    fields = [{'key': key, 'value': None if key in SECRETS else values[key],
               'configured': bool(values[key]), 'secret': key in SECRETS,
               'editable': key in EDITABLE, 'source': '.env', 'takes_effect': 'Honcho stack restart' if key in HONCHO_SETTINGS - MODEL_SETTINGS else 'apply / service restart'}
              for key in DEFAULTS]
    from tools.operations.provider.embedding_config import MODELS
    try:
        from tools.operations.provider.provider import models
        served = models(state)
    except Exception:
        served = []
    return {'revision': saved_revision, 'applied_revision': active,
            'models': {'reasoning': served, 'embedding': sorted(MODELS), 'embedding_locked': embedding_route(state)},
            'apply_state': 'current' if active == saved_revision else 'pending' if active else 'unverified',
            'fields': fields}


def embedding_route(state):
    """The embedding model Honcho's ledger has committed to, or None before any embedding."""
    import sqlite3
    try:
        from tools.operations.memory.honcho_setup import state_for
        ledger = state_for(state) / 'ledger/budget.sqlite'
        if not ledger.is_file(): return None
        with sqlite3.connect('file:' + str(ledger) + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT model FROM embedding_route WHERE id=1').fetchone()
        return row[0] if row else None
    except Exception:
        return None


def save(state, changes, expected):
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        if expected != revision(current): raise ValueError('configuration_conflict')
        if not isinstance(changes, dict) or set(changes) - EDITABLE: raise ValueError('unsupported_setting')
        if any(not isinstance(v, str) for v in changes.values()): raise ValueError('settings_must_be_strings')
        updated = {**current, **changes}; validate(updated)
        locked = embedding_route(state)
        if locked and updated['NOCHEH_EMBEDDING_MODEL'] != current['NOCHEH_EMBEDDING_MODEL'] and updated['NOCHEH_EMBEDDING_MODEL'] != locked:
            # Honcho's ledger already holds vectors from another model; mixing them is refused.
            raise ValueError('embedding_model_change_requires_rebuild')
        # Preserve the last applied baseline across multiple un-applied saves.
        previous = directory / 'previous.env'
        if not previous.exists(): write_env(previous, current)
        write_env(env_path(state), updated)
    return view(state)


def apply(state):
    try:
        from tools.operations.installation.operations import compose, environment
        from tools.operations.installation.configuration import read_env
    except ImportError:
        from tools.operations.installation.operations import compose, environment
        from tools.operations.installation.configuration import read_env
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        values = load(state); validate(values)
        command = compose(state) + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180',
                                    'nocheh-db', 'nocheh-app', 'nocheh-security', 'hermes']
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
        honcho = refresh_honcho(state, values)
        temporary = directory / 'applied.tmp'
        temporary.write_text(json.dumps({'revision': revision(values)})); temporary.chmod(0o600)
        temporary.replace(directory / 'applied.json')
        previous.unlink(missing_ok=True)
    return {'status': 'applied', 'honcho': honcho, **view(state)}


def refresh_honcho(state, values):
    """Rewrite Honcho's generated settings from the saved models and restart it if it runs."""
    if values.get('NOCHEH_HONCHO_ENABLED') != 'true': return 'disabled'
    try:
        from tools.operations.installation.configuration import read_env
        from tools.operations.memory.honcho_setup import initialize, state_for
        from tools.operations.memory.honcho_runtime import operate
        honcho = state_for(state)
        current = (read_env(honcho / 'honcho.env').get('DERIVER_MODEL_CONFIG__MODEL'),
                   read_env(honcho / 'meter.env').get('NOCHEH_EMBEDDING_MODEL'))
        if current == (values['NOCHEH_MODEL'], values['NOCHEH_EMBEDDING_MODEL']): return 'unchanged'
        initialize(state)
        return 'refreshed' if operate(state, 'up') == 0 else 'failed'
    except Exception:
        return 'failed'
