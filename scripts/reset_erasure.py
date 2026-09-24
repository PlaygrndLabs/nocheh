"""Erase only preservation-bound installation files, containers and volumes.

The operation is resumable across loss of the PostgreSQL maintenance connection:
an fsynced intent precedes stopping databases, removing containers and removing
volumes. Exact Docker identities and foreign references are checked throughout.
There is no standalone destructive command.
"""
import json
import subprocess
from pathlib import Path

from . import (configuration, reset_files, reset_inventory, reset_preservation,
               reset_protocol, reset_quiescence)

FORMAT = 'nocheh-reset-erasure-v1'
STAGES = ('prepared', 'file_erase_intent', 'files_erased', 'database_stop_intent',
          'databases_stopped', 'container_remove_intent', 'containers_removed',
          'volume_remove_intent', 'volumes_removed')
CONTAINER_KEYS = ('id', 'name', 'image', 'project', 'service', 'working_dir', 'config_files', 'mounts')
VOLUME_KEYS = ('name', 'created_at', 'driver', 'options_count', 'project', 'compose_volume')


def run(arguments, environment):
    result = subprocess.run(arguments, env=environment, capture_output=True, text=True, timeout=180)
    if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
        raise RuntimeError('reset_erasure_docker_failed')
    return result.stdout


def _base(journal, preflight, artifacts):
    return {'format': FORMAT, 'reset_id': journal.value['reset_id'],
            'preflight_sha256': journal.value['preflight_sha256'],
            'preservation_sha256': reset_protocol.fingerprint(artifacts['receipt']),
            'file_manifest_sha256': artifacts['files']['manifest_sha256'],
            'containers': sorted(({key: row[key] for key in CONTAINER_KEYS} for row in preflight['containers']),
                                 key=lambda row: row['id']),
            'volumes': sorted(preflight['volumes'], key=lambda row: row['name']),
            'file_entries': artifacts['files']['manifest']['entries']}


def _record(journal, preflight, artifacts):
    path = journal.directory / 'erasure.json'; base = _base(journal, preflight, artifacts)
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        if (not isinstance(value, dict) or set(value) != {*base, 'stage'} or
                {key: value[key] for key in base} != base or value['stage'] not in STAGES):
            raise ValueError('reset_erasure_receipt_changed')
        return path, value
    value = {**base, 'stage': 'prepared'}
    reset_protocol.atomic(path, value, create=True)
    return path, value


def _advance(journal, path, value, stage):
    journal.assert_current()
    if reset_protocol.read(path) != value:
        raise RuntimeError('reset_erasure_receipt_changed')
    current = STAGES.index(value['stage']); target = STAGES.index(stage)
    if target == current:
        return value
    if target != current + 1:
        raise ValueError('reset_erasure_stage_invalid')
    updated = {**value, 'stage': stage}; reset_protocol.atomic(path, updated)
    if reset_protocol.read(path) != updated:
        raise RuntimeError('reset_erasure_receipt_changed')
    return updated


def _docker(preflight, runner, environment, *, allow_missing_containers=False,
            allow_missing_volumes=False, allow_running_databases=False):
    identifiers = runner(['docker', 'ps', '-a', '-q', '--no-trunc'], environment).split()
    if len(identifiers) > 4096:
        raise ValueError('reset_erasure_container_limit')
    containers = []
    for start in range(0, len(identifiers), 64):
        output = runner(['docker', 'inspect', '--format', reset_inventory.CONTAINER_FORMAT,
                         *identifiers[start:start + 64]], environment)
        containers.extend(reset_inventory.normalize_container(json.loads(line)) for line in output.splitlines() if line)
    current = {row['id']: row for row in containers}; expected = {row['id']: row for row in preflight['containers']}
    for identifier, row in expected.items():
        actual = current.get(identifier)
        if actual is None:
            if not allow_missing_containers:
                raise RuntimeError('reset_erasure_container_missing')
            continue
        if any(actual.get(key) != row[key] for key in CONTAINER_KEYS):
            raise RuntimeError('reset_erasure_container_changed')
        if reset_quiescence.restart_policy(actual.get('restart_policy')) != {'Name': 'no', 'MaximumRetryCount': 0}:
            raise RuntimeError('reset_erasure_restart_owner_enabled')
        if actual.get('state') not in ('exited', 'created') and not (
                allow_running_databases and row['service'] in reset_quiescence.DATABASES and actual.get('state') == 'running'):
            raise RuntimeError('reset_erasure_container_running')

    volume_names = runner(['docker', 'volume', 'ls', '-q'], environment).split()
    if len(volume_names) > 4096:
        raise ValueError('reset_erasure_volume_limit')
    expected_volumes = {row['name']: row for row in preflight['volumes']}; volumes = {}
    for name in sorted(set(volume_names) & set(expected_volumes)):
        volumes[name] = json.loads(runner(['docker', 'volume', 'inspect', '--format', reset_inventory.VOLUME_FORMAT, name], environment))
    for name, row in expected_volumes.items():
        if name not in volumes:
            if not allow_missing_volumes:
                raise RuntimeError('reset_erasure_volume_missing')
        elif any(volumes[name].get(key) != row.get(key) for key in VOLUME_KEYS):
            raise RuntimeError('reset_erasure_volume_changed')

    protected_roots = [Path(preflight['installation'][key]) for key in ('state', 'memory_state')]
    protected_roots.extend(Path(row['path']) for row in preflight.get('external_archives', []))
    protected_roots.extend(Path(row['path']) for row in preflight.get('paths', []) if row.get('action') == 'review_restore')
    for row in containers:
        if row['id'] in expected:
            continue
        for mount in row.get('mounts', []):
            if mount.get('Type') == 'volume' and mount.get('Name') in expected_volumes:
                raise RuntimeError('reset_erasure_foreign_volume_reference')
            if mount.get('Type') == 'bind' and mount.get('RW') and any(
                    reset_inventory.overlap(mount['Source'], root) for root in protected_roots):
                raise RuntimeError('reset_erasure_foreign_state_writer')
    return {'containers': current, 'volumes': volumes}


def erase(journal, preflight, recovery, ownership_review, *, inspect,
          runner=run, environment=None):
    """Execute the reviewed erasure and advance only the ``erased`` phase."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (4, 5) or
            journal.value['steps'][3]['step'] != 'preservation_frozen' or
            len(journal.value['steps']) == 5 and journal.value['steps'][4]['step'] != 'erased'):
        raise ValueError('reset_erasure_phase_required')
    if journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight):
        raise ValueError('reset_preflight_changed')
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    artifacts = reset_preservation.assert_frozen(journal, preflight)
    path, value = _record(journal, preflight, artifacts)
    if len(journal.value['steps']) == 5:
        if value['stage'] != 'volumes_removed' or journal.value['steps'][4]['evidence_sha256'] != reset_protocol.fingerprint(value):
            raise ValueError('reset_erasure_evidence_changed')
        reset_preservation.verify_retained(journal, preflight)
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        return {'phase': 'erased', 'file_entries': value['file_entries'],
                'containers_removed': len(value['containers']), 'volumes_removed': len(value['volumes']),
                'preserved_setup_retained': True}

    allow_aof_drift = False

    def before_database_stop():
        journal.assert_current(); recovery.assert_maintenance()
        if reset_protocol.read(path) != value:
            raise RuntimeError('reset_erasure_receipt_changed')
        observed = inspect()
        reset_quiescence.verify_quiescent(journal, preflight, observed)
        if allow_aof_drift and any(row['service'] == 'inngest-redis' and
                                   row['state'] not in ('exited', 'created')
                                   for row in observed['containers']):
            raise RuntimeError('reset_workflow_redis_restarted')
        reset_preservation.assert_frozen(journal, preflight)
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        _docker(preflight, runner, environment, allow_running_databases=True)

    def after_database_intent(*, missing_containers=False, missing_volumes=False, running_databases=False):
        journal.assert_current(); reset_preservation.assert_frozen(journal, preflight)
        if reset_protocol.read(path) != value:
            raise RuntimeError('reset_erasure_receipt_changed')
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        reset_preservation.verify_retained(journal, preflight)
        return _docker(preflight, runner, environment, allow_missing_containers=missing_containers,
                       allow_missing_volumes=missing_volumes, allow_running_databases=running_databases)

    if value['stage'] == 'prepared':
        # This is the last point at which all source paths and databases exist.
        reset_preservation.freeze(journal, preflight, recovery, ownership_review,
                                  inspect=inspect)
        reset_preservation.verify_retained(journal, preflight); before_database_stop()
        value = _advance(journal, path, value, 'file_erase_intent')
    if value['stage'] == 'file_erase_intent':
        artifacts = reset_preservation.assert_frozen(journal, preflight)
        observed = inspect()
        reset_quiescence.verify_quiescent(journal, preflight, observed)
        redis = [row for row in observed['containers'] if row['service'] == 'inngest-redis']
        allow_aof_drift = len(redis) == 1 and redis[0]['state'] in ('exited', 'created')
        reset_files.erase(artifacts['files']['manifest'], before_database_stop,
                          allow_stopped_redis_aof_drift=allow_aof_drift)
        before_database_stop(); reset_preservation.verify_retained(journal, preflight)
        value = _advance(journal, path, value, 'files_erased')
    if value['stage'] == 'files_erased':
        before_database_stop(); reset_preservation.verify_retained(journal, preflight)
        value = _advance(journal, path, value, 'database_stop_intent')
    if value['stage'] == 'database_stop_intent':
        current = after_database_intent(running_databases=True)
        identifiers = [identifier for identifier, row in current['containers'].items()
                       if identifier in {item['id'] for item in preflight['containers']} and
                       row['service'] in reset_quiescence.DATABASES and row['state'] == 'running']
        if identifiers:
            runner(['docker', 'stop', '--time', '60', *identifiers], environment)
        after_database_intent()
        value = _advance(journal, path, value, 'databases_stopped')
    if value['stage'] == 'databases_stopped':
        after_database_intent()
        value = _advance(journal, path, value, 'container_remove_intent')
    if value['stage'] == 'container_remove_intent':
        current = after_database_intent(missing_containers=True)
        identifiers = sorted(set(current['containers']) & {row['id'] for row in preflight['containers']})
        if identifiers:
            runner(['docker', 'rm', *identifiers], environment)
        current = after_database_intent(missing_containers=True)
        if set(current['containers']) & {row['id'] for row in preflight['containers']}:
            raise RuntimeError('reset_erasure_container_remove_incomplete')
        value = _advance(journal, path, value, 'containers_removed')
    if value['stage'] == 'containers_removed':
        after_database_intent(missing_containers=True)
        value = _advance(journal, path, value, 'volume_remove_intent')
    if value['stage'] == 'volume_remove_intent':
        current = after_database_intent(missing_containers=True, missing_volumes=True)
        names = sorted(set(current['volumes']) & {row['name'] for row in preflight['volumes']})
        if names:
            runner(['docker', 'volume', 'rm', *names], environment)
        current = after_database_intent(missing_containers=True, missing_volumes=True)
        if set(current['volumes']) & {row['name'] for row in preflight['volumes']}:
            raise RuntimeError('reset_erasure_volume_remove_incomplete')
        value = _advance(journal, path, value, 'volumes_removed')

    after_database_intent(missing_containers=True, missing_volumes=True)
    evidence = reset_protocol.fingerprint(value); journal.complete('erased', evidence)
    return {'phase': 'erased', 'file_entries': value['file_entries'],
            'containers_removed': len(value['containers']), 'volumes_removed': len(value['volumes']),
            'preserved_setup_retained': True}
