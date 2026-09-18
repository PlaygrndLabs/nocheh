"""Stop only reviewed installation owners, retaining database access for settlement.

The full reset coordinator supplies verified acceptance, its locked journal, and
the live database maintenance lock. There is deliberately no standalone CLI.
"""
import os
import re
import subprocess
from pathlib import Path

from . import reset_inventory, reset_protocol
from .configuration import compose_environment

DATABASES = frozenset(('nocheh-postgres', 'honcho-postgres', 'honcho-redis', 'inngest-redis'))
FENCES = ('spool/.restore-inactive', 'hermes/scheduler-inactive',
          'admin/tools/inactive', 'workflows/inactive')
IDENTIFIER = re.compile(r'[a-f0-9]{64}')


def run(arguments, environment):
    result = subprocess.run(arguments, env=environment, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=90)
    if result.returncode:
        raise RuntimeError('reset_owner_shutdown_failed')


def binding(preflight):
    """Mutable service status/restart flags and unfrozen content are not identity."""
    installation = preflight['installation']
    keys = ('root', 'state', 'memory_state', 'project', 'storage_layout', 'config_path', 'configuration_sha256', 'state_anchor')
    container_keys = ('id', 'name', 'image', 'project', 'service', 'working_dir', 'config_files', 'mounts')
    return {'installation': {key: installation[key] for key in keys},
            'containers': sorted(({key: row[key] for key in container_keys} for row in preflight['containers']), key=lambda row: row['id']),
            'volumes': sorted(preflight['volumes'], key=lambda row: row['name'])}


def restart_policy(value):
    if (not isinstance(value, dict) or set(value) != {'Name', 'MaximumRetryCount'} or
            value['Name'] not in ('no', 'always', 'unless-stopped', 'on-failure') or
            type(value['MaximumRetryCount']) is not int or value['MaximumRetryCount'] < 0):
        raise ValueError('reset_restart_policy_invalid')
    return value


def assert_preflight(preflight, current):
    if current.get('blockers') or binding(current) != binding(preflight):
        raise RuntimeError('reset_installation_ownership_changed')


def fence(state, reset_id, *, repair_partial=False):
    expected = ('nocheh-reset:' + reset_id + '\n').encode()
    for relative in FENCES:
        path = state
        for part in Path(relative).parts[:-1]:
            path = path / part
            if path.is_symlink():
                raise ValueError('reset_fence_path_denied')
            path.mkdir(exist_ok=True, mode=0o700)
            reset_protocol.sync_directory(path.parent)
        path = state / relative
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if repair_partial:
                # The immutable shutdown receipt proves all four paths were
                # absent before this reset. Repair only our incomplete prefix;
                # unrelated restore/reset markers remain a conflict.
                fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, 'r+b') as output:
                    reset_protocol.regular(fd)
                    prior = output.read(len(expected) + 1)
                    if not expected.startswith(prior):
                        raise ValueError('reset_fence_owned_elsewhere')
                    if prior != expected:
                        output.seek(0); output.write(expected); output.flush(); os.fsync(fd)
                reset_protocol.sync_directory(path.parent)
            else:
                verify_fence(path, expected)
        else:
            with os.fdopen(fd, 'wb') as output:
                output.write(expected); output.flush(); os.fsync(output.fileno())
            reset_protocol.sync_directory(path.parent)


def verify_fence(path, expected):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        if reset_protocol.regular(fd).st_size != len(expected) or source.read(len(expected) + 1) != expected:
            raise ValueError('reset_fence_owned_elsewhere')


def assert_fences(state, reset_id):
    expected = ('nocheh-reset:' + reset_id + '\n').encode()
    for relative in FENCES:
        path = state
        for part in Path(relative).parts:
            path = path / part
            if path.is_symlink():
                raise ValueError('reset_fence_path_denied')
        verify_fence(path, expected)


def verify_quiescent(journal, preflight, current):
    journal.assert_current(); assert_preflight(preflight, current)
    assert_fences(journal.state, journal.value['reset_id'])
    for container in current['containers']:
        policy = restart_policy(container['restart_policy'])
        if policy != {'Name': 'no', 'MaximumRetryCount': 0}:
            raise RuntimeError('reset_restart_owner_still_enabled')
        if container['service'] not in DATABASES and container['state'] not in ('exited', 'created'):
            raise RuntimeError('reset_owner_still_running')
    return {'containers': len(current['containers']),
            'remaining_services': sorted(row['service'] for row in current['containers'] if row['state'] == 'running')}


def quiesce(journal, preflight, assert_maintenance, *, inspect=None, runner=run, environment=None):
    """Preserve exact prior restart settings before any owner mutation.

    Do not resume on failure. Retrying revalidates identity and repeats only the
    restart suppression and stop operations. The saved pre-reset service inventory
    stays unchanged; in-flight effect settlement remains the next separate phase.
    """
    journal.assert_current()
    if (journal.value is None or not journal.value['steps'] or
            journal.value['steps'][0]['step'] != 'isolated_acceptance' or
            len(journal.value['steps']) > 2):
        raise ValueError('reset_shutdown_phase_required')
    if hashlib_preflight(preflight) != journal.value['preflight_sha256']:
        raise ValueError('reset_preflight_changed')
    assert_maintenance()
    state = journal.state
    inspect = inspect or (lambda: reset_inventory.inspect(state))
    environment = compose_environment(state) if environment is None else environment
    current = inspect(); assert_preflight(preflight, current)
    receipt_path = journal.directory / 'quiescence.json'
    if receipt_path.exists() or receipt_path.is_symlink():
        receipt = reset_protocol.read(receipt_path)
        if (receipt.get('format') != 'nocheh-reset-quiescence-v1' or receipt.get('reset_id') != journal.value['reset_id'] or
                receipt.get('preflight_sha256') != journal.value['preflight_sha256'] or
                receipt.get('binding_sha256') != reset_protocol.fingerprint(binding(preflight)) or
                receipt.get('fences_absent_at_start') is not True):
            raise ValueError('reset_shutdown_receipt_changed')
    else:
        # A changed restart policy since review is a configuration change, not a
        # reason to silently save the new policy as the original one.
        policies = {row['id']: restart_policy(row['restart_policy']) for row in preflight['containers']}
        for row in current['containers']:
            if restart_policy(row['restart_policy']) != policies[row['id']]:
                raise ValueError('reset_restart_policy_changed')
        for relative in FENCES:
            path = state / relative
            if path.exists() or path.is_symlink():
                raise ValueError('reset_fence_owned_elsewhere')
        receipt = {'format': 'nocheh-reset-quiescence-v1', 'reset_id': journal.value['reset_id'],
                   'preflight_sha256': journal.value['preflight_sha256'],
                   'binding_sha256': reset_protocol.fingerprint(binding(preflight)),
                   'fences_absent_at_start': True,
                   'containers': [{'id': row['id'], 'service': row['service'], 'state': row['state'],
                                   'restart_policy': policies[row['id']]} for row in current['containers']]}
        reset_protocol.atomic(receipt_path, receipt, create=True)
    recorded = receipt.get('containers')
    if (not isinstance(recorded, list) or len(recorded) != len(current['containers']) or
            {row['id'] for row in recorded} != {row['id'] for row in current['containers']}):
        raise ValueError('reset_shutdown_receipt_changed')
    prior = {row['id']: row for row in recorded}
    reviewed = {row['id']: row for row in preflight['containers']}
    for row in current['containers']:
        if (set(prior[row['id']]) != {'id', 'service', 'state', 'restart_policy'} or
                not IDENTIFIER.fullmatch(row['id']) or row['service'] != prior[row['id']]['service'] or
                prior[row['id']]['state'] not in ('running', 'exited', 'created') or
                restart_policy(prior[row['id']]['restart_policy']) != restart_policy(reviewed[row['id']]['restart_policy']) or
                restart_policy(row['restart_policy']) not in (restart_policy(prior[row['id']]['restart_policy']), {'Name': 'no', 'MaximumRetryCount': 0})):
            raise ValueError('reset_shutdown_receipt_changed')
    def assert_held():
        journal.assert_current(); assert_maintenance()
        if reset_protocol.read(receipt_path) != receipt:
            raise RuntimeError('reset_shutdown_receipt_changed')
    # Enforce all inactive markers before stopping owners; retain them throughout
    # erasure and fresh database initialization.
    assert_held(); fence(state, journal.value['reset_id'], repair_partial=True)
    for container in current['containers']:
        assert_held()
        runner(['docker', 'update', '--restart=no', container['id']], environment)
    # First stop ingress and native scheduling, then host executors/launchers,
    # then all other writers and credential refresh owners. Databases/cache
    # servers remain available solely for reconciliation and later scoped erasure.
    groups = [('hermes-runtime',), ('nocheh-executor', 'hermes-agent-launcher')]
    groups.append(tuple(sorted({row['service'] for row in current['containers']} - DATABASES -
                               {name for group in groups for name in group})))
    for services in groups:
        ids = [row['id'] for row in current['containers'] if row['service'] in services]
        if ids:
            assert_held()
            runner(['docker', 'stop', '--time', '60', *ids], environment)
    assert_held()
    result = verify_quiescent(journal, preflight, inspect())
    # Hash the immutable original settings, not mutable timestamps or states.
    journal.complete('quiesced', reset_protocol.fingerprint(receipt))
    return {**result, 'phase': 'quiesced', 'effects_settled': False, 'resumed': False}


def hashlib_preflight(preflight):
    import hashlib
    return hashlib.sha256(reset_protocol.canonical(preflight) + b'\n').hexdigest()
