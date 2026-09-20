"""Create fresh reset infrastructure and restore setup without activating runtime.

This is an internal coordinator primitive.  It runs only after scoped erasure,
records intent before creating Docker resources, starts database/cache services
with restart ownership disabled, restores current setup through the reset-only
repository service, and then restores bounded native preferences.  Capture,
workflow execution, providers, pollers, and agents remain stopped.
"""
import json
import hashlib
import os
import stat
import subprocess
import time
from pathlib import Path

from integrations.hermes import preference_transfer

from . import (configuration, reset_configuration, reset_erasure, reset_inventory,
               reset_preservation, reset_protocol, reset_quiescence)

FORMAT = 'nocheh-reset-initialization-v1'
LAYOUT_FORMAT = 'nocheh-reset-layout-transition-v1'
TARGET_LAYOUT = 'original-only-v1'
STAGES = ('prepared', 'resource_create_intent', 'resources_created',
          'services_ready', 'setup_restored', 'preferences_restored')
VOLUME_FORMAT = ('{"name":{{json .Name}},"created_at":{{json .CreatedAt}},'
                 '"driver":{{json .Driver}},"options":{{json .Options}},'
                 '"labels":{{json .Labels}}}')
DATABASE_SERVICES = ('nocheh-db', 'inngest-redis')
HONCHO_SERVICES = ('honcho-postgres', 'honcho-redis')


def run(arguments, environment):
    result = subprocess.run(arguments, env=environment, capture_output=True,
                            text=True, timeout=240)
    if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
        raise RuntimeError('reset_initialization_docker_failed')
    return result.stdout


def _compose(command, profiles, arguments):
    result = list(command)
    for profile in profiles:
        result += ['--profile', profile]
    return result + list(arguments)


def _safe_directory(root, relative):
    current = Path(root)
    if current.is_symlink() or not current.is_dir():
        raise ValueError('reset_initialization_state_invalid')
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('reset_initialization_path_denied')
        current.mkdir(exist_ok=True, mode=0o700)
        if not current.is_dir():
            raise ValueError('reset_initialization_path_denied')
        current.chmod(0o700)
        reset_protocol.sync_directory(current.parent)
    return current


def _render(command, profiles, environment, runner):
    value = json.loads(runner(_compose(command, profiles, ['config', '--format', 'json']), environment))
    if not isinstance(value, dict) or not isinstance(value.get('services'), dict) or not isinstance(value.get('volumes', {}), dict):
        raise ValueError('reset_initialization_compose_invalid')
    return value


def _plan(preflight, rendered, honcho, command):
    if rendered.get('name') != preflight['installation']['project']:
        raise ValueError('reset_initialization_project_changed')
    services = [*DATABASE_SERVICES, *(HONCHO_SERVICES if honcho else ())]
    if any(name not in rendered['services'] for name in services + ['nocheh-reset-setup']):
        raise ValueError('reset_initialization_service_missing')
    volumes = []
    for service in services:
        target = reset_inventory.VOLUME_TARGETS.get(service)
        if target is None:
            continue
        configured = [row for row in rendered['services'][service].get('volumes', [])
                      if row.get('target') == target]
        if len(configured) != 1 or configured[0].get('type') != 'volume':
            raise ValueError('reset_initialization_volume_missing')
        logical = configured[0].get('source'); definition = rendered['volumes'].get(logical)
        if not isinstance(definition, dict) or not isinstance(definition.get('name'), str):
            raise ValueError('reset_initialization_volume_missing')
        volumes.append({'service': service, 'target': target, 'logical': logical,
                        'name': definition['name'], 'external': definition.get('external') is True})
    if len({row['name'] for row in volumes}) != len(volumes):
        raise ValueError('reset_initialization_volume_conflict')
    redis = [row for row in rendered['services']['inngest-redis'].get('volumes', [])
             if row.get('target') == '/data']
    expected_redis = str(Path(preflight['installation']['state']) / 'workflows/redis')
    if (len(redis) != 1 or redis[0].get('type') != 'bind' or
            str(Path(redis[0].get('source', '')).resolve()) != expected_redis):
        raise ValueError('reset_initialization_redis_binding_changed')
    files = sorted(str(Path(command[index + 1]).resolve()) for index, value in enumerate(command[:-1]) if value == '-f')
    if not files:
        raise ValueError('reset_initialization_compose_invalid')
    return {'project': rendered['name'], 'services': services,
            'volumes': sorted(volumes, key=lambda row: row['name']),
            'working_dir': preflight['installation']['root'], 'config_files': files,
            'redis_bind': expected_redis}


def _all_containers(runner, environment):
    identifiers = runner(['docker', 'ps', '-a', '-q', '--no-trunc'], environment).split()
    if len(identifiers) > 4096:
        raise ValueError('reset_initialization_container_limit')
    rows = []
    for start in range(0, len(identifiers), 64):
        output = runner(['docker', 'inspect', '--format', reset_inventory.CONTAINER_FORMAT,
                         *identifiers[start:start + 64]], environment)
        rows.extend(reset_inventory.normalize_container(json.loads(line)) for line in output.splitlines() if line)
    return rows


def _volume(runner, environment, name):
    return json.loads(runner(['docker', 'volume', 'inspect', '--format', VOLUME_FORMAT, name], environment))


def _volume_names(runner, environment):
    names = runner(['docker', 'volume', 'ls', '-q'], environment).split()
    if len(names) > 4096:
        raise ValueError('reset_initialization_volume_limit')
    return set(names)


def _assert_old_absent(preflight, runner, environment):
    identifiers = {row['id'] for row in _all_containers(runner, environment)}
    if identifiers & {row['id'] for row in preflight['containers']}:
        raise RuntimeError('reset_initialization_old_container_present')
    if _volume_names(runner, environment) & {row['name'] for row in preflight['volumes']}:
        raise RuntimeError('reset_initialization_old_volume_present')


def _inspect_resources(journal, preflight, plan, runner, environment):
    old_containers = {row['id'] for row in preflight['containers']}
    containers = [row for row in _all_containers(runner, environment)
                  if row.get('project') == plan['project'] and row.get('service') in plan['services']]
    if len(containers) != len(plan['services']) or {row['service'] for row in containers} != set(plan['services']):
        raise RuntimeError('reset_initialization_resource_missing')
    if any(row['id'] in old_containers or
           str(Path(row.get('working_dir') or '').resolve()) != plan['working_dir'] or
           sorted(str(Path(path).resolve()) for path in (row.get('config_files') or '').split(',') if path) != plan['config_files'] or
           reset_quiescence.restart_policy(row['restart_policy']) != {'Name': 'no', 'MaximumRetryCount': 0}
           for row in containers):
        raise RuntimeError('reset_initialization_resource_changed')
    redis = next(row for row in containers if row['service'] == 'inngest-redis')
    mounts = [row for row in redis.get('mounts', []) if row.get('Destination') == '/data']
    if (len(mounts) != 1 or mounts[0].get('Type') != 'bind' or mounts[0].get('RW') is not True or
            str(Path(mounts[0].get('Source') or '').resolve()) != plan['redis_bind']):
        raise RuntimeError('reset_initialization_resource_changed')
    old_volumes = {row['name']: row for row in preflight['volumes']}
    volumes = []
    for expected in plan['volumes']:
        actual = _volume(runner, environment, expected['name'])
        container = next(row for row in containers if row['service'] == expected['service'])
        mounts = [row for row in container.get('mounts', []) if row.get('Destination') == expected['target']]
        if (len(mounts) != 1 or mounts[0].get('Type') != 'volume' or
                mounts[0].get('Name') != expected['name'] or mounts[0].get('RW') is not True):
            raise RuntimeError('reset_initialization_resource_changed')
        old = old_volumes.get(expected['name'])
        if (actual.get('driver') != 'local' or actual.get('options') not in ({}, None) or
                old and actual.get('created_at') == old.get('created_at')):
            raise RuntimeError('reset_initialization_resource_changed')
        labels = actual.get('labels') or {}
        if expected['external']:
            if labels.get('nocheh.reset.id') != journal.value['reset_id']:
                raise RuntimeError('reset_initialization_resource_changed')
        elif (labels.get('com.docker.compose.project') != plan['project'] or
              labels.get('com.docker.compose.volume') != expected['logical']):
            raise RuntimeError('reset_initialization_resource_changed')
        volumes.append({**expected, **actual})
    return {'containers': sorted(containers, key=lambda row: row['service']),
            'volumes': sorted(volumes, key=lambda row: row['name'])}


def _resource_identity(value):
    return {'containers': [{key: item[key] for key in item if key != 'state'}
                           for item in value['containers']],
            'volumes': value['volumes']}


def _base(journal, preflight, artifacts, request, plan, layout):
    return {'format': FORMAT, 'reset_id': journal.value['reset_id'],
            'preflight_sha256': journal.value['preflight_sha256'],
            'erasure_sha256': journal.value['steps'][4]['evidence_sha256'],
            'preservation_sha256': reset_protocol.fingerprint(artifacts['receipt']),
            'configuration_sha256': artifacts['configuration']['snapshot_sha256'],
            'preferences_sha256': artifacts['preferences']['snapshot_sha256'],
            'setup_request_sha256': reset_protocol.fingerprint(request),
            'layout': layout,
            'plan': plan, 'stage': 'prepared', 'resources': None,
            'setup': None, 'preferences': None}


def _record(journal, preflight, artifacts, request, plan, layout):
    path = journal.directory / 'initialization.json'; base = _base(journal, preflight, artifacts, request, plan, layout)
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        fixed = {key: value.get(key) for key in base if key not in ('stage', 'resources', 'setup', 'preferences')}
        expected = {key: base[key] for key in fixed}
        if (not isinstance(value, dict) or set(value) != set(base) or fixed != expected or
                value.get('stage') not in STAGES):
            raise ValueError('reset_initialization_receipt_changed')
        return path, value
    reset_protocol.atomic(path, base, create=True)
    return path, base


def _advance(journal, path, value, stage, **changes):
    journal.assert_current()
    if reset_protocol.read(path) != value:
        raise RuntimeError('reset_initialization_receipt_changed')
    current = STAGES.index(value['stage']); target = STAGES.index(stage)
    if target == current:
        return value
    if target != current + 1:
        raise ValueError('reset_initialization_stage_invalid')
    updated = {**value, **changes, 'stage': stage}; reset_protocol.atomic(path, updated)
    if reset_protocol.read(path) != updated:
        raise RuntimeError('reset_initialization_receipt_changed')
    return updated


def _request(journal, artifacts, values):
    snapshot = reset_configuration.original_only(
        artifacts['configuration']['snapshot'], values,
        artifacts['preferences']['snapshot'], journal.value['reset_id'])
    return {'snapshot': snapshot, 'generation': journal.value['generation'],
            'reset_id': journal.value['reset_id'],
            'profile_commands': preference_transfer.profile_commands(artifacts['preferences']['snapshot'])}


def _configuration_sha(values):
    return hashlib.sha256(reset_protocol.canonical(values)).hexdigest()


def _layout_base(journal, preflight, current):
    source = dict(current); source['NOCHEH_STORAGE_LAYOUT'] = preflight['installation']['storage_layout']
    target = {**source, 'NOCHEH_STORAGE_LAYOUT': TARGET_LAYOUT}
    configuration.validate(source); configuration.validate(target)
    if (_configuration_sha(source) != preflight['installation']['configuration_sha256'] or
            preflight['installation']['storage_layout'] not in ('legacy', TARGET_LAYOUT) or
            str(configuration.env_path(journal.state)) != preflight['installation']['config_path']):
        raise ValueError('reset_initialization_configuration_changed')
    return {'format': LAYOUT_FORMAT, 'reset_id': journal.value['reset_id'],
            'preflight_sha256': journal.value['preflight_sha256'],
            'path': preflight['installation']['config_path'],
            'source_layout': preflight['installation']['storage_layout'],
            'target_layout': TARGET_LAYOUT,
            'source_sha256': _configuration_sha(source),
            'target_sha256': _configuration_sha(target), 'stage': 'prepared'}, target


def _transition_layout(journal, preflight):
    """Record intent, then change only the saved layout selector."""
    path = journal.directory / 'layout.json'; current = configuration.load(journal.state)
    base, target = _layout_base(journal, preflight, current)
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        if value not in (base, {**base, 'stage': 'applied'}):
            raise ValueError('reset_initialization_layout_receipt_changed')
    else:
        reset_protocol.atomic(path, base, create=True); value = base
    current_sha = _configuration_sha(current)
    if current_sha not in (base['source_sha256'], base['target_sha256']):
        raise ValueError('reset_initialization_configuration_changed')
    if current_sha == base['source_sha256'] and base['source_sha256'] != base['target_sha256']:
        journal.assert_current(); reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        configuration.write_env(configuration.env_path(journal.state), target)
    observed = configuration.load(journal.state)
    if (_configuration_sha(observed) != base['target_sha256'] or
            observed['NOCHEH_STORAGE_LAYOUT'] != TARGET_LAYOUT):
        raise RuntimeError('reset_initialization_layout_transition_failed')
    if value['stage'] == 'prepared':
        value = {**base, 'stage': 'applied'}; reset_protocol.atomic(path, value)
    return value, observed


def _assert_layout(journal, preflight, value):
    layout = value.get('layout')
    if (not isinstance(layout, dict) or layout.get('format') != LAYOUT_FORMAT or
            layout.get('stage') != 'applied' or layout.get('reset_id') != journal.value['reset_id'] or
            layout.get('preflight_sha256') != journal.value['preflight_sha256'] or
            layout.get('source_layout') != preflight['installation']['storage_layout'] or
            layout.get('target_layout') != TARGET_LAYOUT or
            layout.get('source_sha256') != preflight['installation']['configuration_sha256'] or
            layout.get('path') != preflight['installation']['config_path']):
        raise ValueError('reset_initialization_layout_receipt_changed')
    current = configuration.load(journal.state)
    if (_configuration_sha(current) != layout.get('target_sha256') or
            current['NOCHEH_STORAGE_LAYOUT'] != TARGET_LAYOUT):
        raise ValueError('reset_initialization_configuration_changed')


def _setup_result(raw, request):
    lines = [line for line in raw.splitlines() if line.strip()]
    try:
        value = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        raise RuntimeError('reset_initialization_setup_failed') from None
    required = {'event', 'generation', 'binding', 'configuration_records', 'projects',
                'assignments', 'sharing_rules', 'profiles', 'source_content_copied', 'history_copied'}
    if (not isinstance(value, dict) or set(value) != required or value['event'] != 'reset_setup_restored' or
            value['generation'] != request['generation'] or not isinstance(value['binding'], dict) or
            value['binding'].get('generation') != request['generation'] or
            value['profiles'] != len(request['profile_commands']) or
            value['source_content_copied'] is not False or value['history_copied'] is not False):
        raise RuntimeError('reset_initialization_setup_failed')
    return value


def _wait_healthy(resources, runner, environment, timeout=180):
    deadline = time.monotonic() + timeout
    identifiers = [row['id'] for row in resources['containers']]
    while True:
        ready = True
        for identifier in identifiers:
            value = json.loads(runner(['docker', 'inspect', '--format', '{{json .State}}', identifier], environment))
            if value.get('Status') != 'running' or value.get('Health', {}).get('Status', 'healthy') != 'healthy':
                ready = False; break
        if ready:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('reset_initialization_health_timeout')
        time.sleep(1)


def assert_initialized(journal, preflight, *, runner=run, environment=None, command=None):
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) < 6 or
            journal.value['steps'][5]['step'] != 'initialized'):
        raise ValueError('reset_initialization_phase_required')
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    value = reset_protocol.read(journal.directory / 'initialization.json')
    if (not isinstance(value, dict) or value.get('format') != FORMAT or value.get('stage') != 'preferences_restored' or
            value.get('reset_id') != journal.value['reset_id'] or
            reset_protocol.fingerprint(value) != journal.value['steps'][5]['evidence_sha256']):
        raise ValueError('reset_initialization_evidence_changed')
    _assert_layout(journal, preflight, value)
    reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
    current = _inspect_resources(journal, preflight, value['plan'], runner, environment)
    if _resource_identity(current) != _resource_identity(value['resources']):
        raise RuntimeError('reset_initialization_resource_changed')
    if any(row['state'] != 'running' for row in current['containers']):
        raise RuntimeError('reset_initialization_service_stopped')
    return value


def initialize(journal, preflight, *, runner=run, environment=None, command=None):
    """Advance only ``initialized``; the empty-baseline gate remains separate."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (5, 6) or
            journal.value['steps'][4]['step'] != 'erased' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_initialization_phase_required')
    if len(journal.value['steps']) == 6:
        value = assert_initialized(journal, preflight, runner=runner, environment=environment, command=command)
        return {'phase': 'initialized', 'services': len(value['resources']['containers']),
                'volumes': len(value['resources']['volumes']), 'profiles': value['preferences']['profiles'],
                'native_content_copied': False, 'runtime_activated': False}
    artifacts = reset_preservation.assert_frozen(journal, preflight)
    erasure = reset_protocol.read(journal.directory / 'erasure.json')
    if (erasure.get('stage') != reset_erasure.STAGES[-1] or
            reset_protocol.fingerprint(erasure) != journal.value['steps'][4]['evidence_sha256']):
        raise ValueError('reset_erasure_evidence_changed')
    reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
    layout, values = _transition_layout(journal, preflight)
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    request = _request(journal, artifacts, values)
    setup_path = journal.directory / 'setup.json'
    if setup_path.exists() or setup_path.is_symlink():
        if reset_protocol.read(setup_path) != request:
            raise ValueError('reset_initialization_setup_changed')
    else:
        reset_protocol.atomic(setup_path, request, create=True)
    profiles = ['reset', *(['honcho'] if environment.get('NOCHEH_HONCHO_ENABLED') == 'true' else [])]
    rendered = _render(command, profiles, environment, runner)
    plan = _plan(preflight, rendered, 'honcho' in profiles, command)
    path, value = _record(journal, preflight, artifacts, request, plan, layout)

    if value['stage'] == 'prepared':
        _assert_old_absent(preflight, runner, environment)
        value = _advance(journal, path, value, 'resource_create_intent')
    if value['stage'] == 'resource_create_intent':
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        _safe_directory(journal.state, 'workflows/redis')
        _safe_directory(journal.state, 'files')
        present = _volume_names(runner, environment)
        for volume in plan['volumes']:
            if volume['external']:
                if volume['name'] in present:
                    labels = (_volume(runner, environment, volume['name']).get('labels') or {})
                    if labels.get('nocheh.reset.id') != journal.value['reset_id']:
                        raise RuntimeError('reset_initialization_resource_changed')
                else:
                    runner(['docker', 'volume', 'create', '--driver', 'local', '--label',
                            'nocheh.reset.id=' + journal.value['reset_id'], volume['name']], environment)
        runner(_compose(command, profiles, ['create', '--no-build', *plan['services']]), environment)
        rows = [row for row in _all_containers(runner, environment)
                if row.get('project') == plan['project'] and row.get('service') in plan['services']]
        if len(rows) != len(plan['services']):
            raise RuntimeError('reset_initialization_resource_missing')
        runner(['docker', 'update', '--restart=no', *[row['id'] for row in rows]], environment)
        resources = _inspect_resources(journal, preflight, plan, runner, environment)
        value = _advance(journal, path, value, 'resources_created', resources=resources)
    if value['stage'] == 'resources_created':
        resources = _inspect_resources(journal, preflight, plan, runner, environment)
        if _resource_identity(resources) != _resource_identity(value['resources']):
            raise RuntimeError('reset_initialization_resource_changed')
        stopped = [row['id'] for row in resources['containers'] if row['state'] != 'running']
        if stopped:
            runner(['docker', 'start', *stopped], environment)
        _wait_healthy(resources, runner, environment)
        resources = _inspect_resources(journal, preflight, plan, runner, environment)
        value = _advance(journal, path, value, 'services_ready', resources=resources)
    if value['stage'] == 'services_ready':
        resources = _inspect_resources(journal, preflight, plan, runner, environment)
        if _resource_identity(resources) != _resource_identity(value['resources']):
            raise RuntimeError('reset_initialization_resource_changed')
        raw = runner(_compose(command, profiles, ['run', '--rm', '--no-deps', '--pull', 'never',
                                                   'nocheh-reset-setup']), environment)
        setup = _setup_result(raw, request)
        value = _advance(journal, path, value, 'setup_restored', setup=setup)
    if value['stage'] == 'setup_restored':
        commands = request['profile_commands']; owner = artifacts['preferences']['snapshot']['owner']
        admitted = [{'id': row['id'], 'name': row['name'], 'state': 'active',
                     'revision': 1, 'owner_id': owner} for row in commands]
        result = preference_transfer.restore(journal.state / 'hermes', artifacts['preferences']['snapshot'],
                                             environment['NOCHEH_MODEL'], admitted)
        value = _advance(journal, path, value, 'preferences_restored', preferences=result)
    resources = _inspect_resources(journal, preflight, plan, runner, environment)
    if (_resource_identity(resources) != _resource_identity(value['resources']) or
            value['preferences'].get('native_content_copied') is not False):
        raise RuntimeError('reset_initialization_verification_failed')
    evidence = reset_protocol.fingerprint(value); journal.complete('initialized', evidence)
    return {'phase': 'initialized', 'services': len(resources['containers']),
            'volumes': len(resources['volumes']), 'profiles': value['preferences']['profiles'],
            'native_content_copied': False, 'runtime_activated': False}
