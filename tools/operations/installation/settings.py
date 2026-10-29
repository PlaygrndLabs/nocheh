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

from tools.operations.installation import mini_app
WORKFLOW_INTERNAL={'INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD'}
STORE_INTERNAL={'NOCHEH_ARCHIVE_PASSWORD','NOCHEH_DERIVED_PASSWORD','NOCHEH_CONTROL_PASSWORD'}
from tools.operations.provider import routes as provider_routes
SECRETS = {'TELEGRAM_BOT_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN'} | provider_routes.KEY_SETTINGS | WORKFLOW_INTERNAL | STORE_INTERNAL
# Providers, keys and the provider and model of each part are chosen in
# Settings › Models; Apply also refreshes Honcho when its routes change.
MODEL_SETTINGS = {'NOCHEH_MODEL', 'NOCHEH_EMBEDDING_PROVIDER', 'NOCHEH_EMBEDDING_MODEL'} | set(provider_routes.DEFAULTS)
EDITABLE = set(DEFAULTS) - {'NOCHEH_CONFIG_VERSION', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN','NOCHEH_STORAGE_LAYOUT'} - WORKFLOW_INTERNAL - STORE_INTERNAL


# Read again by the dashboard at each check, so they work as soon as they are saved
# and never need Apply to restart the services.
LIVE = {'NOCHEH_BACKUP_SCHEDULE', 'NOCHEH_BACKUP_TIME', 'NOCHEH_BACKUP_TIME_ZONE', 'NOCHEH_BACKUP_KEEP', 'TELEGRAM_PROBLEM_NOTICES'}


def revision(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def service_revision(values):
    """What the running services use; Apply records it. Settings that work live are left out, and so
    are settings at their default, so a newly added setting does not ask for Apply."""
    return revision({key: value for key, value in values.items() if key not in LIVE and DEFAULTS.get(key) != value})


def view(state):
    values = load(state)
    applied = Path(state) / 'admin/applied.json'
    saved_revision = revision(values)
    in_use = service_revision(values)
    active = json.loads(applied.read_text()).get('revision') if applied.exists() else None
    fields = [{'key': key, 'value': None if key in SECRETS else values[key],
               'configured': bool(values[key]), 'secret': key in SECRETS,
               'editable': key in EDITABLE, 'source': '.env',
               'takes_effect': 'right away' if key in LIVE else 'apply / service restart'}
              for key in DEFAULTS]
    from tools.operations.provider.embedding_config import MODELS
    return {'revision': saved_revision, 'applied_revision': active,
            'models': {'embedding': sorted(MODELS), 'embedding_locked': embedding_route(state),
                       'embedding_rebuild': (pending_rebuild(state) or {}).get('model')},
            'providers': provider_view(values),
            'apply_state': 'current' if active == in_use else 'pending' if active else 'unverified',
            'fields': fields}


def provider_view(values):
    """Providers and parts for Settings › Models, without any key value."""
    try: known = provider_routes.providers(values)
    except ValueError: known = provider_routes.providers({})
    try: stored = provider_routes.keys(values)
    except ValueError: stored = {}
    rows = [{**row, 'has_key': bool(
        (values.get(provider_routes.PRESETS[row['id']]['key']) if row['id'] in provider_routes.PRESETS else stored.get(row['id'])) or '')}
            for row in known.values()]
    parts = [{'id': part, 'label': label, 'provider_setting': provider, 'model_setting': model}
             for part, (label, provider, model) in provider_routes.PARTS.items()]
    return {'list': rows, 'parts': parts}


def provider_models(state, provider, url=None, key=None):
    """Models an external provider lists, fetched server-side with the key being typed
    or its saved key, so the list follows the provider while it is still being edited."""
    if not isinstance(provider, str): raise ValueError('unknown_provider')
    return provider_routes.list_models(load(state), provider, url=url or None, secret=key or None)


def embedding_route(state):
    """The embedding model Honcho's ledger has committed to, or None before any embedding."""
    import sqlite3
    try:
        from tools.operations.memory.honcho_setup import state_for
        ledger = state_for(state) / 'ledger/budget.sqlite'
        if not ledger.is_file(): return None
        with sqlite3.connect('file:' + str(ledger) + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT model FROM embedding_route WHERE id=1').fetchone()
            # Ledgers from before the route was recorded embedded with the small model.
            if not row and db.execute("SELECT 1 FROM calls WHERE route='/v1/embeddings' LIMIT 1").fetchone():
                row = ('text-embedding-3-small',)
        return row[0] if row else None
    except Exception:
        return None


REBUILD = 'admin/memory-rebuild.json'


def pending_rebuild(state):
    """The confirmed memory search model change that Apply still has to rebuild memory for."""
    try: return json.loads((Path(state) / REBUILD).read_text())
    except (OSError, ValueError): return None


def rebuild_memory(state, values, honcho):
    """After Honcho restarts with a newly confirmed memory search model, move its ledger to that
    model and replace long-term memory from the archive, so vectors of two models never mix.
    Old workspaces are deleted with their vectors; the archive keeps every message."""
    marker = Path(state) / REBUILD
    pending = pending_rebuild(state)
    if not pending: return None
    if values.get('NOCHEH_EMBEDDING_MODEL') != pending.get('model'):
        marker.unlink(missing_ok=True); return None
    if honcho not in ('refreshed', 'unchanged'): return 'waiting' if honcho in ('disabled', 'skipped_unowned_state') else 'failed'
    try:
        from services.honcho.meter import Ledger
        from tools.operations.archive.archive import API
        from tools.operations.memory.honcho_setup import state_for
        from tools.operations.provider.embedding_config import embeddings
        Ledger(state_for(state) / 'ledger/budget.sqlite').switch_embedding(embeddings(values))
        api = API()
        revision = api.call('/v1/memory/honcho')['connection']['revision']
        # The operation ID is fixed at confirmation, so a retry after a lost answer replaces memory once.
        api.call('/v1/memory/honcho/fresh-start', {'expected_revision': revision, 'operation_id': pending['operation_id'],
                                                   'from_archive': True})
    except Exception:
        return 'failed'
    marker.unlink(missing_ok=True)
    return 'started'


def save(state, changes, expected, rebuild_memory=False):
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        if expected != revision(current): raise ValueError('configuration_conflict')
        if not isinstance(changes, dict) or set(changes) - EDITABLE: raise ValueError('unsupported_setting')
        if any(not isinstance(v, str) for v in changes.values()): raise ValueError('settings_must_be_strings')
        updated = {**current, **changes}
        # The browser sends only newly typed provider keys; stored keys stay, and
        # keys of removed custom providers are dropped.
        updated['NOCHEH_PROVIDER_KEYS'] = provider_routes.merge_keys(current, changes)
        validate(updated)
        locked = embedding_route(state)
        model = updated['NOCHEH_EMBEDDING_MODEL']
        marker = directory / 'memory-rebuild.json'
        if locked and model != current['NOCHEH_EMBEDDING_MODEL']:
            if model == locked: marker.unlink(missing_ok=True)
            # Honcho already holds vectors from another model; switching needs the owner's
            # confirmed memory rebuild, which Apply runs, so the two are never mixed.
            elif not rebuild_memory: raise ValueError('embedding_model_change_requires_rebuild')
            else:
                import uuid
                temporary = directory / 'memory-rebuild.tmp'
                temporary.write_text(json.dumps({'model': model, 'operation_id': str(uuid.uuid4())})); temporary.chmod(0o600)
                temporary.replace(marker)
        # Preserve the last applied baseline across multiple un-applied saves.
        previous = directory / 'previous.env'
        if not previous.exists() and service_revision(updated) != service_revision(current): write_env(previous, current)
        write_env(env_path(state), updated)
    return view(state)


def apply(state, progress=lambda step: None):
    """Restarts the services with the saved settings. `progress` hears each step so
    the dashboard can say what is happening while services restart."""
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
        previous = directory / 'previous.env'
        before = {**DEFAULTS, **read_env(previous)} if previous.exists() else values
        def run():
            current = load(state)
            services = ['nocheh-db', 'nocheh-app', 'nocheh-security', 'hermes', 'hermes-agent-sb']
            if mini_app.enabled(current): services += list(mini_app.SERVICES)
            # Compose stops and restarts each changed service in dependency order: the
            # app may take its whole 300 s grace to finish work in flight and Hermes its
            # 120 s, each then waits to report healthy, and the last wait is up to 180 s.
            ok = subprocess.run(compose(state) + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', *services],
                                env=environment(state), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=900).returncode == 0
            if ok and not mini_app.enabled(current):
                # Turning the mini app off also closes its tunnel.
                ok = subprocess.run(compose(state) + ['rm', '-s', '-f', *mini_app.SERVICES], env=environment(state),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120).returncode == 0
            return ok
        progress('restarting')
        try: ok = run()
        except subprocess.TimeoutExpired: ok = False
        if not ok:
            rolled_back = False
            if previous.exists():
                progress('rolling_back')
                write_env(env_path(state), read_env(previous))
                try: rolled_back = run()
                except subprocess.TimeoutExpired: pass
            return {'status': 'apply_failed', 'rolled_back': rolled_back}
        progress('memory')
        honcho = refresh_honcho(state, values)
        memory = rebuild_memory(state, values, honcho)
        progress('telegram')
        menu = mini_app.menu_button(values, telegram_api, shown_before=mini_app.enabled(before))
        # A rebuild that did not start leaves the settings waiting to apply, so Apply tries it again.
        if memory != 'failed':
            temporary = directory / 'applied.tmp'
            temporary.write_text(json.dumps({'revision': service_revision(values)})); temporary.chmod(0o600)
            temporary.replace(directory / 'applied.json')
        previous.unlink(missing_ok=True)
    return {'status': 'applied', 'honcho': honcho, 'memory_rebuild': memory, 'mini_app': menu, **view(state)}


def telegram_api(token, method, **params):
    from tools.operations.archive.telegram_directory import _bot_api
    return _bot_api(token, method, **params)


def refresh_honcho(state, values):
    """Rewrite Honcho's generated settings from the saved routes and restart it when they changed."""
    if values.get('NOCHEH_HONCHO_ENABLED') != 'true': return 'disabled'
    try:
        from tools.operations.memory.honcho_setup import initialize, state_for
        from tools.operations.installation.configuration import owns_project
        from tools.operations.memory.honcho_runtime import operate
        if not owns_project(state): return 'skipped_unowned_state'
        honcho = state_for(state)
        def generated():
            digest = hashlib.sha256()
            for name in ('honcho.env', 'meter.env', 'temporary_embedding_key'):
                path = honcho / name
                digest.update(path.read_bytes() if path.is_file() else b'-')
            return digest.hexdigest()
        before = generated()
        initialize(state)
        if generated() == before: return 'unchanged'
        return 'refreshed' if operate(state, 'up') == 0 else 'failed'
    except Exception:
        return 'failed'
