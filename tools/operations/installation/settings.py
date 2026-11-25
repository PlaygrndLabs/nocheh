"""Validated owner configuration operations, shared by dashboard and CLI."""
import fcntl
import hashlib
import json
import os
import subprocess
from pathlib import Path
try:
    from tools.operations.installation.configuration import load, validate, write_env, env_path, DEFAULTS, GENERATED
except ImportError:
    from tools.operations.installation.configuration import load, validate, write_env, env_path, DEFAULTS, GENERATED

from tools.operations.installation import mini_app
WORKFLOW_INTERNAL={'INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD'}
STORE_INTERNAL={'NOCHEH_ARCHIVE_PASSWORD','NOCHEH_DERIVED_PASSWORD','NOCHEH_CONTROL_PASSWORD'}
from tools.operations.provider import routes as provider_routes
SECRETS = {'TELEGRAM_BOT_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN', 'AGENT_KEY', 'NOCHEH_HERMES_SESSION_TOKEN', 'NOCHEH_OFFSITE_SECRET_ACCESS_KEY', 'NOCHEH_OFFSITE_PASSPHRASE'} | provider_routes.KEY_SETTINGS | WORKFLOW_INTERNAL | STORE_INTERNAL
# Providers, keys and the provider and model of each part are chosen in
# Settings › Models; Apply also refreshes Honcho when its routes change.
MODEL_SETTINGS = {'NOCHEH_MODEL', 'NOCHEH_EMBEDDING_PROVIDER', 'NOCHEH_EMBEDDING_MODEL',
                  'NOCHEH_TRANSCRIPTION_PROVIDER', 'NOCHEH_TRANSCRIPTION_MODEL'} | set(provider_routes.DEFAULTS)
# A workspace keeps the name it got at setup (ADR-0245): everything else on the machine follows from it.
EDITABLE = set(DEFAULTS) - {'NOCHEH_CONFIG_VERSION', 'NOCHEH_WORKSPACE', 'POSTGRES_PASSWORD', 'SERVICE_TOKEN','NOCHEH_STORAGE_LAYOUT'} - WORKFLOW_INTERNAL - STORE_INTERNAL


# Read again by the dashboard at each check, so they work as soon as they are saved
# and never need Apply to restart the services.
LIVE = {'NOCHEH_BACKUP_SCHEDULE', 'NOCHEH_BACKUP_TIME', 'NOCHEH_BACKUP_TIME_ZONE', 'NOCHEH_BACKUP_KEEP', 'TELEGRAM_PROBLEM_NOTICES',
        'NOCHEH_MONTHLY_LIMIT_USD',
        'NOCHEH_OFFSITE', 'NOCHEH_OFFSITE_PROVIDER', 'NOCHEH_OFFSITE_ENDPOINT', 'NOCHEH_OFFSITE_BUCKET', 'NOCHEH_OFFSITE_REGION', 'NOCHEH_OFFSITE_ACCESS_KEY_ID',
        'NOCHEH_OFFSITE_SECRET_ACCESS_KEY', 'NOCHEH_OFFSITE_PASSPHRASE', 'NOCHEH_OFFSITE_KEEP'}


def revision(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


# A retired setting stays in an older .env, hidden and unsaveable, and no service reads it; at its old default it is still
# left out, so an upgrade does not ask for Apply. Another value was in the revision before and stays in it, for the same
# reason: the group list (ADR-0253), and the lists of who may talk in each group, which members replace (step 3).
RETIRED_DEFAULTS = {'TELEGRAM_GROUP_IDS': '', 'TELEGRAM_GROUP_ACCESS': '{}'}


def service_revision(values):
    """What the running services use; Apply records it. Settings that work live are left out, and so
    are settings at their default, so a newly added or retired setting does not ask for Apply. Generated keys are no
    settings: a cutover or rotate-keys (ADR-0295) applies them itself, so a new one never asks for Apply."""
    defaults = {**RETIRED_DEFAULTS, **DEFAULTS}
    return revision({key: value for key, value in values.items() if key not in LIVE and key not in GENERATED and defaults.get(key) != value})


def carry_keys(state, values):
    """A cutover's new keys also go into the last applied baseline that unapplied settings left, so a failed Apply or
    rotate-keys rolls back to keys the services can still start with (ADR-0295)."""
    from tools.operations.installation.configuration import ROTATED, read_env
    previous = Path(state) / 'admin/previous.env'
    if not previous.exists(): return
    write_env(previous, {**read_env(previous), **{name: values[name] for name in ROTATED if values.get(name)}})


def carry_applied(state, before):
    """Builds before ADR-0295 counted generated keys in the applied revision. When a cutover changes only those, the record
    follows the settings, so the cutover asks for no Apply: init, up or make dev restarts the services with the new keys."""
    applied = Path(state) / 'admin/applied.json'
    try: recorded = json.loads(applied.read_text()).get('revision')
    except (OSError, ValueError, AttributeError): return
    defaults = {**RETIRED_DEFAULTS, **DEFAULTS}
    if recorded != revision({key: value for key, value in before.items() if key not in LIVE and defaults.get(key) != value}): return
    temporary = applied.with_name('applied.tmp')
    temporary.write_text(json.dumps({'revision': service_revision(before)})); temporary.chmod(0o600)
    temporary.replace(applied)


def view(state):
    values = load(state)
    applied = Path(state) / 'admin/applied.json'
    saved_revision = revision(values)
    in_use = service_revision(values)
    active = json.loads(applied.read_text()).get('revision') if applied.exists() else None
    fields = [{'key': key, 'value': None if key in SECRETS else values[key],
               'configured': bool(values[key]), 'secret': key in SECRETS,
               'editable': key in EDITABLE and not (key == 'TELEGRAM_OWNER_ID' and values[key]), 'source': '.env',
               'takes_effect': 'right away' if key in LIVE else 'apply / service restart',
               **({'changes_from': 'cli'} if key == 'TELEGRAM_OWNER_ID' and values[key] else {})}
              for key in DEFAULTS]
    from tools.operations.provider.embedding_config import MODELS
    from tools.operations.provider.transcription_config import MODELS as VOICE_MODELS
    return {'revision': saved_revision, 'applied_revision': active,
            'models': {'embedding': sorted(MODELS), 'transcription': [{'model': model, 'usd_per_minute': price} for model, price in VOICE_MODELS.items()],
                       'embedding_locked': embedding_route(state),
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
    parts = [{'id': part, 'label': label, 'provider_setting': provider, 'model_setting': model,
              'defaults': provider_routes.PART_DEFAULTS.get(part, {})}
             for part, (label, provider, model) in provider_routes.PARTS.items()]
    return {'list': rows, 'parts': parts}


def provider_models(state, provider, url=None, key=None, try_v1=False):
    """Models an external provider lists, fetched server-side with the key being typed
    or its saved key, so the list follows the provider while it is still being edited.
    The provider dialog sets `try_v1` to find an address typed without /v1."""
    if not isinstance(provider, str): raise ValueError('unknown_provider')
    return provider_routes.list_models(load(state), provider, url=url or None, secret=key or None, try_v1=try_v1 is True)


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
        revision = api.call('/v1/memory/longterm')['connection']['revision']
        # The operation ID is fixed at confirmation, so a retry after a lost answer replaces memory once.
        api.call('/v1/memory/longterm/fresh-start', {'expected_revision': revision, 'operation_id': pending['operation_id'],
                                                   'from_archive': True})
    except Exception:
        return 'failed'
    marker.unlink(missing_ok=True)
    return 'started'


OWNER_FROM_CLI = 'Your Telegram user ID changes only from the command line: ./bin/nocheh config set TELEGRAM_OWNER_ID <id>'


def save(state, changes, expected, rebuild_memory=False, owner_change=False):
    """Save settings. The owner's Telegram user ID is set here the first time; a saved one changes only with
    `owner_change`, which only the command line passes (ADR-0244)."""
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        if expected != revision(current): raise ValueError('configuration_conflict')
        if not isinstance(changes, dict) or set(changes) - EDITABLE: raise ValueError('unsupported_setting')
        if any(not isinstance(v, str) for v in changes.values()): raise ValueError('settings_must_be_strings')
        if not owner_change and current.get('TELEGRAM_OWNER_ID') and changes.get('TELEGRAM_OWNER_ID', current['TELEGRAM_OWNER_ID']) != current['TELEGRAM_OWNER_ID']:
            raise ValueError(OWNER_FROM_CLI)
        updated = {**current, **changes}
        # The browser sends only newly typed provider keys; stored keys stay, and
        # keys of removed custom providers are dropped.
        updated['NOCHEH_PROVIDER_KEYS'] = provider_routes.merge_keys(current, changes)
        validate(updated)
        # Another workspace on this machine never shares this one's bot, mini app address or tunnel.
        from tools.operations.installation.workspaces import check_settings
        check_settings(updated, current)
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


def apply(state, progress=lambda step: None, restart_cached_services=True):
    """Restarts the services with the saved settings. `progress` hears each step so
    the dashboard can say what is happening while services restart. A new agent login alone passes
    `restart_cached_services=False`: the dashboard and executor keep theirs, and a marker left by an earlier key change
    stays for the next up or Apply."""
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
            # nocheh-telegram holds the bot token and the typing and reaction settings.
            services = ['nocheh-db', 'nocheh-app', 'nocheh-security', 'hermes', 'hermes-agent-sb', 'nocheh-telegram']
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
        menu = mini_app.menu_button(values, telegram_api, shown_before=mini_app.enabled(before),
                                    former_owner=before.get('TELEGRAM_OWNER_ID'))
        # A rebuild that did not start leaves the settings waiting to apply, so Apply tries it again.
        if memory != 'failed':
            temporary = directory / 'applied.tmp'
            temporary.write_text(json.dumps({'revision': service_revision(values)})); temporary.chmod(0o600)
            temporary.replace(directory / 'applied.json')
        previous.unlink(missing_ok=True)
    from tools.operations.installation.configuration import RESTART_MARKER
    # A key change since the last up (a cutover or rotate-keys) also restarts the dashboard and executor, which keep
    # the keys they read once. Apply pressed in the dashboard restarts the dashboard itself last.
    if restart_cached_services and (Path(state) / RESTART_MARKER).exists(): restart_cached(state)
    return {'status': 'applied', 'honcho': honcho, 'memory_rebuild': memory, 'mini_app': menu, **view(state)}


def restart_cached(state):
    """The dashboard and executor read the keys once (ADR-0295) and up does not recreate them, so after a key change they
    restart here. A stopped one stays stopped; the marker goes either way."""
    from tools.operations.installation.operations import compose, environment
    from tools.operations.installation.configuration import RESTART_MARKER
    # Compose's restart would start a stopped one too, such as an executor stopped on purpose.
    listed = subprocess.run(compose(state) + ['ps', '--status', 'running', '--services'], env=environment(state),
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=60)
    running = [name for name in ('nocheh-executor', 'nocheh-dashboard') if name in (listed.stdout or '').split()]
    # One at a time, the dashboard last: Apply run inside it ends there. Should it end before the marker goes, the
    # next up restarts both once more, which is harmless.
    for name in running:
        subprocess.run(compose(state) + ['restart', name], env=environment(state),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
    (Path(state) / RESTART_MARKER).unlink(missing_ok=True)


ROTATED_NOTICE = ('New SERVICE_TOKEN, AGENT_KEY and Hermes session token are in use. Anything signed with the old key stops '
                  'working: turns and scheduled or background runs in progress fail, Answer privately buttons on replies still '
                  'being delivered fail (buttons already sent may too), and replies Nocheh was still delivering are not sent. '
                  'Ask again where needed.')


def rotate_keys(state, print=print):
    """./bin/nocheh rotate-keys: new master key, agent login and Hermes session token, applied at once. Apply rolls back
    to the old keys when the services do not come back with the new ones."""
    import secrets
    from tools.operations.installation.configuration import ROTATED, mark_restart
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        previous = directory / 'previous.env'
        # The last applied baseline stays when unapplied settings already left one.
        if not previous.exists(): write_env(previous, current)
        updated = {**current, **{name: secrets.token_hex(32) for name in ROTATED}}
        validate(updated)
        write_env(env_path(state), updated)
        mark_restart(state)
    # Apply restarts the dashboard and executor too, since the marker is set.
    result = apply(state)
    if result.get('status') == 'applied':
        print(ROTATED_NOTICE)
        return 0
    print('Rotation failed; the old keys are back' if result.get('rolled_back') else
          'Rotation failed and the services did not come back: run ./bin/nocheh up')
    return 1


def rotate_agent_login(state, progress=lambda step: None, close_keys=None):
    """The dashboard's "Stop everything now" (ADR-0307): a new agent login alone, applied at once. The master key and
    Hermes's session token stay, so the dashboard and executor keep working and are not restarted; Hermes and the services
    that check the agent login restart with the new one. Apply rolls back to the old login when they do not come back.
    Saved settings not yet applied would be applied with it, so it waits for them (`settings_pending_apply`): Apply or
    discard them first. Once the new login is in use, every key the old one could still open is closed again
    (`keys_closed`), since it could start work until the services restarted."""
    import secrets
    directory = Path(state) / 'admin'; directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / 'settings.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load(state)
        # Waiting settings are what the running services do not use yet. A previous.env left by a failed Apply, or by
        # saves that came back to what is applied, waits for nothing: it is replaced by the current baseline.
        if pending_rebuild(state) or view(state)['apply_state'] == 'pending':
            return {'status': 'settings_pending_apply'}
        write_env(directory / 'previous.env', current)
        updated = {**current, 'AGENT_KEY': secrets.token_hex(32)}
        validate(updated)
        write_env(env_path(state), updated)
    result = apply(state, progress, restart_cached_services=False)
    if result.get('status') != 'applied':
        # Back on the old login, .env is the baseline again whether or not the services came back: nothing waits to apply.
        from tools.operations.installation.configuration import read_env
        previous = directory / 'previous.env'
        if previous.exists() and dict(read_env(previous)) == dict(read_env(env_path(state))): previous.unlink(missing_ok=True)
        return result
    progress('closing_keys')
    try:
        (close_keys or close_old_keys)()
        closed = True
    except Exception:
        closed = False
    return {**result, 'keys_closed': closed}


def close_old_keys():
    """Closes every key again through storage, adding to the stop that the new agent login finishes."""
    import uuid
    from tools.operations.archive.archive import API
    API().call('/v1/keys/stop', {'operation_id': 'agent-login:' + str(uuid.uuid4()), 'again': True})


def telegram_api(token, method, **params):
    from tools.operations.archive.telegram_directory import _bot_api
    return _bot_api(token, method, **params)


def refresh_honcho(state, values):
    """Rewrite Honcho's generated settings from the saved routes and bring its containers in line with them."""
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
        changed = generated() != before
        # Compose recreates only containers whose settings differ from the files, so this
        # also repairs a container left on an older route by an earlier failed start.
        if operate(state, 'up') != 0: return 'failed'
        return 'refreshed' if changed else 'unchanged'
    except Exception:
        return 'failed'
