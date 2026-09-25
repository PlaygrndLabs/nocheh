"""Owner-authorized container refresh during the fresh live acceptance window.

The reset journal pins fresh container IDs. A saved group-access change needs new
application containers, so record the exact planned replacements before Compose
acts and rebind only after every replacement is healthy with restart policy no.
The initialized database/cache containers may never change here.
"""
import json
from pathlib import Path

from . import configuration, reset_acceptance, reset_protocol, settings

FORMAT = 'nocheh-reset-acceptance-refresh-v1'
SERVICES = ('hermes', 'nocheh-app', 'nocheh-dashboard', 'nocheh-security')


def _saved_group_grant(state):
    previous = Path(state) / 'admin/previous.env'
    if not previous.is_file() or previous.is_symlink():
        raise ValueError('reset_refresh_previous_configuration_missing')
    before = configuration.read_env(previous)
    after = configuration.load(state)
    if {key for key in set(before) | set(after) if before.get(key) != after.get(key)} != {'TELEGRAM_GROUP_ACCESS'}:
        raise ValueError('reset_refresh_unrelated_configuration_change')
    old = configuration.group_access(before)
    new = configuration.group_access(after)
    additions = []
    for group in set(old) | set(new):
        a = old.get(group, {'granted': [], 'denied': []})
        b = new.get(group, {'granted': [], 'denied': []})
        if a['denied'] != b['denied'] or not set(a['granted']).issubset(b['granted']):
            raise ValueError('reset_refresh_unrelated_group_access_change')
        additions.extend((group, user) for user in set(b['granted']) - set(a['granted']))
    if len(additions) != 1:
        raise ValueError('reset_refresh_single_grant_required')
    return before, after, additions[0]


def _activation(journal):
    journal.assert_current()
    if journal.value is None or len(journal.value['steps']) != 8 or journal.value['steps'][7]['step'] != 'telegram_boundary':
        raise ValueError('reset_refresh_phase_required')
    value = reset_protocol.read(journal.directory / 'acceptance-mode.json')
    if (value.get('format') != reset_acceptance.FORMAT or value.get('stage') != 'acceptance_running' or
            value.get('reset_id') != journal.value['reset_id'] or
            value.get('generation') != journal.value['generation']):
        raise ValueError('reset_refresh_activation_changed')
    return value


def _containers(journal, activation, runner, environment):
    by_service = reset_acceptance._owned(activation['plan'], runner, environment)
    reset_acceptance._assert_no_restart(by_service)
    for service in activation['plan']['desired']:
        state = reset_acceptance._state(by_service[service]['id'], runner, environment)
        if state.get('Status') != 'running' or state.get('Health', {}).get('Status', 'healthy') != 'healthy':
            raise RuntimeError('reset_refresh_service_not_healthy')
    if reset_acceptance._fence_state(journal.state, journal.value['reset_id']) != 0:
        raise RuntimeError('reset_refresh_fence_changed')
    return reset_acceptance._container_identity(by_service)


def prepare(journal, *, runner=reset_acceptance.run, environment=None):
    """Write the fail-closed intent before replacing the four named services."""
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    activation = _activation(journal)
    if not set(SERVICES).issubset(activation['plan']['desired']) or set(SERVICES) & set(activation['plan']['initial_containers']):
        raise ValueError('reset_refresh_service_plan_changed')
    before, after, (group, user) = _saved_group_grant(journal.state)
    containers = _containers(journal, activation, runner, environment)
    if containers != activation['containers']:
        raise RuntimeError('reset_refresh_container_identity_changed')
    intent = {'format': FORMAT, 'reset_id': journal.value['reset_id'],
              'generation': journal.value['generation'],
              'activation_before_sha256': reset_protocol.fingerprint(activation),
              'containers_before': containers, 'services': list(SERVICES),
              'configuration_before_sha256': reset_protocol.fingerprint(before),
              'configuration_after_sha256': reset_protocol.fingerprint(after),
              'saved_revision': settings.revision(after),
              'group_sha256': reset_protocol.fingerprint(group),
              'participant_sha256': reset_protocol.fingerprint(user),
              'stage': 'prepared', 'containers_after': None,
              'activation_after_sha256': None}
    path = journal.directory / 'acceptance-refresh.json'
    if path.exists() or path.is_symlink():
        if reset_protocol.read(path) != intent:
            raise ValueError('reset_refresh_intent_changed')
    else:
        reset_protocol.atomic(path, intent, create=True)
    return {'stage': 'prepared', 'services': list(SERVICES)}


def _assert_environment(activation, runner, environment, expected):
    by_service = reset_acceptance._owned(activation['plan'], runner, environment)
    for service in ('hermes', 'nocheh-app', 'nocheh-security'):
        raw = runner(['docker', 'inspect', '--format', '{{json .Config.Env}}', by_service[service]['id']], environment)
        values = dict(item.split('=', 1) for item in json.loads(raw) if '=' in item)
        if values.get('TELEGRAM_GROUP_ACCESS') != expected:
            raise RuntimeError('reset_refresh_container_configuration_changed')


def _mark_applied(state, revision):
    path = Path(state) / 'admin/applied.json'
    reset_protocol.atomic(path, {'revision': revision}, create=not path.exists())
    previous = Path(state) / 'admin/previous.env'
    previous.unlink(missing_ok=True)
    reset_protocol.sync_directory(previous.parent)


def finish(journal, *, runner=reset_acceptance.run, environment=None):
    """Rebind the journal only to the exact healthy replacements in the intent."""
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    activation = _activation(journal)
    path = journal.directory / 'acceptance-refresh.json'
    intent = reset_protocol.read(path)
    if (intent.get('format') != FORMAT or intent.get('reset_id') != journal.value['reset_id'] or
            intent.get('generation') != journal.value['generation'] or intent.get('services') != list(SERVICES) or
            intent.get('stage') not in ('prepared', 'validated', 'complete')):
        raise ValueError('reset_refresh_intent_changed')
    before, after, (group, user) = _saved_group_grant(journal.state) if intent['stage'] != 'complete' else (None, configuration.load(journal.state), (None, None))
    if (reset_protocol.fingerprint(after) != intent['configuration_after_sha256'] or
            settings.revision(after) != intent['saved_revision']):
        raise ValueError('reset_refresh_configuration_changed')
    if before is not None and (reset_protocol.fingerprint(before) != intent['configuration_before_sha256'] or
                               reset_protocol.fingerprint(group) != intent['group_sha256'] or
                               reset_protocol.fingerprint(user) != intent['participant_sha256']):
        raise ValueError('reset_refresh_configuration_changed')
    containers = _containers(journal, activation, runner, environment)
    old = {row['service']: row['id'] for row in intent['containers_before']}
    new = {row['service']: row['id'] for row in containers}
    if set(old) != set(new) or {name for name in old if old[name] != new[name]} != set(SERVICES):
        raise RuntimeError('reset_refresh_unexpected_container_replacement')
    _assert_environment(activation, runner, environment, after['TELEGRAM_GROUP_ACCESS'])
    updated = {**activation, 'containers': containers}
    expected_hash = reset_protocol.fingerprint(updated)
    if intent['stage'] == 'prepared':
        if reset_protocol.fingerprint(activation) != intent['activation_before_sha256']:
            raise ValueError('reset_refresh_activation_changed')
        intent = {**intent, 'stage': 'validated', 'containers_after': containers,
                  'activation_after_sha256': expected_hash}
        reset_protocol.atomic(path, intent)
    if intent['containers_after'] != containers or intent['activation_after_sha256'] != expected_hash:
        raise ValueError('reset_refresh_intent_changed')
    if activation['containers'] == intent['containers_before']:
        reset_protocol.atomic(journal.directory / 'acceptance-mode.json', updated)
    elif activation != updated:
        raise ValueError('reset_refresh_activation_changed')
    if intent['stage'] != 'complete':
        reset_protocol.atomic(path, {**intent, 'stage': 'complete'})
    _mark_applied(journal.state, intent['saved_revision'])
    return {'stage': 'complete', 'services': list(SERVICES), 'restart_ownership': False}
