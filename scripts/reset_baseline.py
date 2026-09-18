"""Verify and record a content-empty installation before the Telegram boundary.

The fresh database/cache services remain fenced and have restart ownership
disabled.  After all independent store, cache, native-state, filesystem and
resource checks pass, detailed private preservation/settlement artifacts are
retired under a durable intent.  Only content-free phase evidence remains.
"""
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path

from . import (configuration, reset_initialization, reset_inventory,
               reset_protocol, reset_quiescence)

FORMAT = 'nocheh-reset-empty-baseline-v1'
STAGES = ('verified', 'retirement_intent', 'retired')
PRIVATE = ('configuration.json', 'preferences.json', 'accounting.json',
           'preserved.json', 'ownership.json', 'files.json', 'settlement.json',
           'setup.json')
LIMIT = 64 * 1024 * 1024
ALLOWED_JOURNAL = frozenset({
    'coordinator.lock', 'progress.json', 'quiescence.json', 'settlement.json',
    'configuration.json', 'preferences.json', 'accounting.json', 'preserved.json',
    'ownership.json', 'files.json', 'preservation.json', 'erasure.json',
    'setup.json', 'initialization.json', 'baseline.json'})


def run(arguments, environment):
    result = subprocess.run(arguments, env=environment, capture_output=True,
                            text=True, timeout=240)
    if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
        raise RuntimeError('reset_baseline_docker_failed')
    return result.stdout


def _compose(command, profiles, arguments):
    result = list(command)
    for profile in profiles:
        result += ['--profile', profile]
    return result + list(arguments)


def _store_result(raw, generation):
    lines = [line for line in raw.splitlines() if line.strip()]
    try:
        value = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        raise RuntimeError('reset_baseline_store_verification_failed') from None
    required = {'event', 'generation', 'archive_rows', 'derived_rows', 'control_setup_rows',
                'profiles', 'setup_only', 'source_content_present',
                'derivative_content_present', 'history_present'}
    if (not isinstance(value, dict) or set(value) != required or
            value['event'] != 'reset_baseline_verified' or value['generation'] != generation or
            value['archive_rows'] != 0 or value['derived_rows'] != 0 or
            value['setup_only'] is not True or value['source_content_present'] is not False or
            value['derivative_content_present'] is not False or value['history_present'] is not False or
            type(value['control_setup_rows']) is not int or value['control_setup_rows'] < 0 or
            type(value['profiles']) is not int or value['profiles'] < 0):
        raise RuntimeError('reset_baseline_store_verification_failed')
    return value


def _postgres_empty(identifier, user, database, runner, environment):
    sql = ("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
           "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
           "AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','S','v','m','f')")
    raw = runner(['docker', 'exec', identifier, 'psql', '-U', user, '-d', database,
                  '-Atqc', sql], environment).strip()
    if raw != '0':
        raise RuntimeError('reset_baseline_native_database_not_empty')


def _redis_empty(identifier, runner, environment):
    raw = runner(['docker', 'exec', identifier, 'redis-cli', '--raw', 'INFO', 'keyspace'], environment)
    if any(line.startswith('db') for line in raw.splitlines()):
        raise RuntimeError('reset_baseline_cache_not_empty')


def _regular_hash(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > LIMIT:
            raise ValueError('reset_baseline_private_artifact_invalid')
        digest = hashlib.sha256(); size = 0
        while chunk := source.read(1024 * 1024):
            digest.update(chunk); size += len(chunk)
        if size != metadata.st_size:
            raise ValueError('reset_baseline_private_artifact_changed')
    return {'name': Path(path).name, 'sha256': digest.hexdigest(), 'size': size}


def _private_inventory(directory):
    names = {path.name for path in Path(directory).iterdir()}
    if not names.issubset(ALLOWED_JOURNAL):
        raise ValueError('reset_baseline_private_artifact_unknown')
    values = []
    for name in PRIVATE:
        path = Path(directory) / name
        if not path.exists() and not path.is_symlink():
            raise ValueError('reset_baseline_private_artifact_missing')
        values.append(_regular_hash(path))
    return values


def _verify_private(directory, inventory, allow_missing):
    expected = {row['name']: row for row in inventory}
    if set(expected) != set(PRIVATE):
        raise ValueError('reset_baseline_private_artifact_changed')
    for name in PRIVATE:
        path = Path(directory) / name
        if not path.exists() and not path.is_symlink():
            if allow_missing:
                continue
            raise ValueError('reset_baseline_private_artifact_missing')
        if _regular_hash(path) != expected[name]:
            raise ValueError('reset_baseline_private_artifact_changed')


def _native_files(state, memory, preferences):
    state = Path(state); files = state / 'files'; spool = state / 'spool'; native = state / 'hermes'
    if files.is_symlink() or not files.is_dir() or any(files.iterdir()):
        raise RuntimeError('reset_baseline_original_files_not_empty')
    if spool.is_symlink() or not spool.is_dir() or sorted(path.name for path in spool.iterdir()) != ['.restore-inactive']:
        raise RuntimeError('reset_baseline_spool_not_empty')
    memory = Path(memory)
    if memory.is_symlink() or not memory.is_dir():
        raise RuntimeError('reset_baseline_native_memory_not_empty')
    allowed_top = {'auth.json', 'auth.lock', 'nocheh-policy.yaml', 'profiles', 'scheduler-inactive'}
    if native.is_symlink() or not native.is_dir() or any(path.name not in allowed_top for path in native.iterdir()):
        raise RuntimeError('reset_baseline_native_state_not_empty')
    expected = {row['id'] for row in preferences['profiles']}
    profiles = native / 'profiles'
    policy = native / 'nocheh-policy.yaml'
    if (policy.is_symlink() or not policy.is_file() or policy.stat().st_nlink != 1 or
            (native / 'scheduler-inactive').is_symlink() or not (native / 'scheduler-inactive').is_file()):
        raise RuntimeError('reset_baseline_native_state_not_empty')
    if profiles.is_symlink() or not profiles.is_dir() or {path.name for path in profiles.iterdir()} != expected:
        raise RuntimeError('reset_baseline_native_state_not_empty')
    for path in profiles.iterdir():
        if path.is_symlink() or not path.is_dir() or sorted(item.name for item in path.iterdir()) != ['config.yaml']:
            raise RuntimeError('reset_baseline_native_state_not_empty')
        config = path / 'config.yaml'
        if config.is_symlink() or not config.is_file() or config.stat().st_nlink != 1:
            raise RuntimeError('reset_baseline_native_state_not_empty')
    for relative in ('baseline', 'reports'):
        path = memory / relative
        if path.exists() or path.is_symlink():
            raise RuntimeError('reset_baseline_native_memory_not_empty')
    return {'original_files': 0, 'spool_entries': 1, 'native_profiles': len(expected),
            'native_content_present': False}


def _resource_exclusion(value, preflight, runner, environment):
    plan = value['plan']; resources = value['resources']
    all_containers = reset_initialization._all_containers(runner, environment)
    selected = {row['id'] for row in resources['containers']}
    volume_names = {row['name'] for row in resources['volumes']}
    roots = [Path(preflight['installation'][key]) for key in ('state', 'memory_state')]
    for row in all_containers:
        if row['id'] in selected:
            continue
        if row.get('project') == plan['project']:
            raise RuntimeError('reset_baseline_unexpected_installation_service')
        for mount in row.get('mounts', []):
            if mount.get('Type') == 'volume' and mount.get('Name') in volume_names:
                raise RuntimeError('reset_baseline_foreign_volume_reference')
            if mount.get('Type') == 'bind' and mount.get('RW') and any(
                    isinstance(mount.get('Source'), str) and reset_inventory.overlap(mount['Source'], root) for root in roots):
                raise RuntimeError('reset_baseline_foreign_state_writer')


def _record(journal, initialization, stores, caches, native, private):
    path = journal.directory / 'baseline.json'
    base = {'format': FORMAT, 'reset_id': journal.value['reset_id'],
            'generation': journal.value['generation'],
            'preflight_sha256': journal.value['preflight_sha256'],
            'initialization_sha256': reset_protocol.fingerprint(initialization),
            'stores': stores, 'caches': caches, 'native': native,
            'private_artifacts': private, 'stage': 'verified'}
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        fixed = {key: value.get(key) for key in base if key != 'stage'}
        if not isinstance(value, dict) or set(value) != set(base) or fixed != {key: base[key] for key in fixed} or value.get('stage') not in STAGES:
            raise ValueError('reset_baseline_evidence_changed')
        return path, value
    reset_protocol.atomic(path, base, create=True); return path, base


def _advance(journal, path, value, stage):
    journal.assert_current()
    if reset_protocol.read(path) != value:
        raise RuntimeError('reset_baseline_evidence_changed')
    current = STAGES.index(value['stage']); target = STAGES.index(stage)
    if target == current:
        return value
    if target != current + 1:
        raise ValueError('reset_baseline_stage_invalid')
    updated = {**value, 'stage': stage}; reset_protocol.atomic(path, updated)
    if reset_protocol.read(path) != updated:
        raise RuntimeError('reset_baseline_evidence_changed')
    return updated


def verify(journal, preflight, *, runner=run, environment=None, command=None):
    """Advance only ``empty_baseline`` and leave every runtime owner fenced."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (6, 7) or
            journal.value['steps'][5]['step'] != 'initialized' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_baseline_phase_required')
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    initialization = reset_initialization.assert_initialized(
        journal, preflight, runner=runner, environment=environment, command=command)
    if len(journal.value['steps']) == 7:
        value = reset_protocol.read(journal.directory / 'baseline.json')
        if (value.get('stage') != 'retired' or reset_protocol.fingerprint(value) !=
                journal.value['steps'][6]['evidence_sha256']):
            raise ValueError('reset_baseline_evidence_changed')
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        _resource_exclusion(initialization, preflight, runner, environment)
        if any((journal.directory / name).exists() or (journal.directory / name).is_symlink() for name in PRIVATE):
            raise ValueError('reset_baseline_private_artifact_changed')
        if not {path.name for path in journal.directory.iterdir()}.issubset(ALLOWED_JOURNAL):
            raise ValueError('reset_baseline_private_artifact_unknown')
        return {'phase': 'empty_baseline', **value['stores'], **value['caches'], **value['native']}
    profiles = ['reset', *(['honcho'] if environment.get('NOCHEH_HONCHO_ENABLED') == 'true' else [])]
    path = journal.directory / 'baseline.json'
    recorded_now = False
    by_service = {row['service']: row['id'] for row in initialization['resources']['containers']}

    def current_checks():
        raw = runner(_compose(command, profiles, ['run', '--rm', '--no-deps', '--pull', 'never',
                                                   'nocheh-reset-baseline']), environment)
        stores = _store_result(raw, journal.value['generation'])
        _postgres_empty(by_service['nocheh-postgres'], 'nocheh', 'nocheh_inngest', runner, environment)
        _redis_empty(by_service['inngest-redis'], runner, environment)
        caches = {'inngest_postgres_relations': 0, 'inngest_redis_keys': 0,
                  'honcho_postgres_relations': 0, 'honcho_redis_keys': 0}
        if 'honcho-postgres' in by_service:
            _postgres_empty(by_service['honcho-postgres'], 'experiment', 'honcho_experiment', runner, environment)
            _redis_empty(by_service['honcho-redis'], runner, environment)
        native = _native_files(journal.state, preflight['installation']['memory_state'],
                               reset_protocol.read(journal.directory / 'preferences.json')['snapshot'])
        return stores, caches, native

    if not path.exists() and not path.is_symlink():
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        _resource_exclusion(initialization, preflight, runner, environment)
        stores, caches, native = current_checks()
        private = _private_inventory(journal.directory)
        path, value = _record(journal, initialization, stores, caches, native, private)
        recorded_now = True
    else:
        value = reset_protocol.read(path)
        if not isinstance(value, dict) or value.get('format') != FORMAT or value.get('stage') not in STAGES:
            raise ValueError('reset_baseline_evidence_changed')
    reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
    _resource_exclusion(initialization, preflight, runner, environment)
    if value['stage'] == 'verified':
        if not recorded_now:
            stores, caches, native = current_checks()
            if (stores != value['stores'] or caches != value['caches'] or native != value['native']):
                raise RuntimeError('reset_baseline_evidence_changed')
        _verify_private(journal.directory, value['private_artifacts'], False)
        value = _advance(journal, path, value, 'retirement_intent')
    if value['stage'] == 'retirement_intent':
        _verify_private(journal.directory, value['private_artifacts'], True)
        for name in PRIVATE:
            artifact = journal.directory / name
            if artifact.exists() or artifact.is_symlink():
                if _regular_hash(artifact) != {row['name']: row for row in value['private_artifacts']}[name]:
                    raise ValueError('reset_baseline_private_artifact_changed')
                artifact.unlink(); reset_protocol.sync_directory(journal.directory)
        _verify_private(journal.directory, value['private_artifacts'], True)
        value = _advance(journal, path, value, 'retired')
    evidence = reset_protocol.fingerprint(value); journal.complete('empty_baseline', evidence)
    return {'phase': 'empty_baseline', **value['stores'], **value['caches'], **value['native']}
