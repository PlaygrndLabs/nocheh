"""Stage the fresh installation for live acceptance without resuming it.

This is an internal reset-coordinator primitive.  It is intentionally separate
from the fresh evidence gate and from final resumption.  All fresh containers
retain restart policy ``no`` while the live checks run.
"""
import json
import time
from pathlib import Path

from . import (configuration, reset_baseline, reset_initialization,
               reset_protocol, reset_quiescence)

FORMAT = 'nocheh-reset-acceptance-mode-v1'
STAGES = ('prepared', 'containers_created', 'fences_release_intent',
          'acceptance_running')


def run(arguments, environment):
    import subprocess
    result = subprocess.run(arguments, env=environment, capture_output=True,
                            text=True, timeout=240)
    if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
        raise RuntimeError('reset_acceptance_docker_failed')
    return result.stdout


def _compose(command, profiles, arguments):
    value = list(command)
    for profile in profiles:
        value += ['--profile', profile]
    return value + list(arguments)


def _render(command, profiles, environment, runner):
    value = json.loads(runner(_compose(command, profiles,
                                      ['config', '--format', 'json']), environment))
    if not isinstance(value, dict) or not isinstance(value.get('services'), dict):
        raise ValueError('reset_acceptance_compose_invalid')
    return value


def _dependencies(rendered, roots):
    services = rendered['services']; selected = set()

    def include(name):
        if name in selected:
            return
        service = services.get(name)
        if not isinstance(service, dict):
            raise ValueError('reset_acceptance_service_missing')
        selected.add(name)
        depends = service.get('depends_on', {})
        if not isinstance(depends, dict):
            raise ValueError('reset_acceptance_compose_invalid')
        for dependency in depends:
            include(dependency)

    for root in roots:
        include(root)
    return sorted(selected)


def _topological(rendered, selected):
    selected = set(selected); pending = set(selected); result = []
    while pending:
        ready = sorted(name for name in pending if not (
            set(rendered['services'][name].get('depends_on', {})) & pending))
        if not ready:
            raise ValueError('reset_acceptance_dependency_cycle')
        result.extend(ready); pending.difference_update(ready)
    return result


def _profiles(environment, desired):
    values = []
    if environment.get('NOCHEH_HONCHO_ENABLED') == 'true' or any(
            name.startswith('honcho-') for name in desired):
        values.append('honcho')
    return values


def _receipt(journal):
    value = reset_protocol.read(journal.directory / 'quiescence.json')
    if (not isinstance(value, dict) or value.get('format') != 'nocheh-reset-quiescence-v1' or
            value.get('reset_id') != journal.value['reset_id'] or
            value.get('preflight_sha256') != journal.value['preflight_sha256'] or
            not isinstance(value.get('containers'), list)):
        raise ValueError('reset_acceptance_quiescence_changed')
    seen = set()
    for row in value['containers']:
        if (not isinstance(row, dict) or set(row) != {'id', 'service', 'state', 'restart_policy'} or
                not isinstance(row['service'], str) or not row['service'] or row['service'] in seen or
                row['state'] not in ('running', 'exited', 'created')):
            raise ValueError('reset_acceptance_quiescence_changed')
        reset_quiescence.restart_policy(row['restart_policy']); seen.add(row['service'])
    return value


def _initialization_receipt(journal):
    value = reset_protocol.read(journal.directory / 'initialization.json')
    if (not isinstance(value, dict) or value.get('format') != reset_initialization.FORMAT or
            value.get('stage') != reset_initialization.STAGES[-1] or
            value.get('reset_id') != journal.value['reset_id'] or
            reset_protocol.fingerprint(value) != journal.value['steps'][5]['evidence_sha256'] or
            not isinstance(value.get('resources'), dict)):
        raise ValueError('reset_acceptance_initialization_changed')
    return value


def _plan(journal, preflight, initialization, rendered, receipt, profiles):
    desired = sorted(row['service'] for row in receipt['containers']
                     if row['state'] == 'running')
    if not desired:
        raise ValueError('reset_acceptance_no_enabled_services')
    services = _dependencies(rendered, desired)
    # Reset-only helpers never become part of an acceptance installation.
    if any(name.startswith('nocheh-reset-') for name in services):
        raise ValueError('reset_acceptance_service_invalid')
    initial = {row['service']: row['id']
               for row in initialization['resources']['containers']}
    if not set(initial).issubset(services):
        raise ValueError('reset_acceptance_database_not_enabled')
    old = {row['id'] for row in preflight['containers']}
    policies = {row['service']: row['restart_policy'] for row in receipt['containers']}
    return {'project': rendered['name'], 'profiles': profiles,
            'desired': desired, 'services': services,
            'order': _topological(rendered, services),
            'initial_containers': initial, 'old_container_ids': sorted(old),
            'restart_policies': {name: policies[name] for name in desired}}


def _base(journal, plan):
    return {'format': FORMAT, 'reset_id': journal.value['reset_id'],
            'generation': journal.value['generation'],
            'preflight_sha256': journal.value['preflight_sha256'],
            'telegram_sha256': journal.value['steps'][7]['evidence_sha256'],
            'plan': plan, 'stage': 'prepared', 'containers': None,
            'activated_at': None}


def _record(journal, plan):
    path = journal.directory / 'acceptance-mode.json'; base = _base(journal, plan)
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        fixed = {key: value.get(key) for key in base
                 if key not in ('stage', 'containers', 'activated_at')}
        if (not isinstance(value, dict) or set(value) != set(base) or
                fixed != {key: base[key] for key in fixed} or
                value.get('stage') not in STAGES):
            raise ValueError('reset_acceptance_receipt_changed')
        return path, value
    reset_protocol.atomic(path, base, create=True)
    return path, base


def _advance(journal, path, value, stage, **changes):
    journal.assert_current()
    if reset_protocol.read(path) != value:
        raise RuntimeError('reset_acceptance_receipt_changed')
    current = STAGES.index(value['stage']); target = STAGES.index(stage)
    if target == current:
        return value
    if target != current + 1:
        raise ValueError('reset_acceptance_stage_invalid')
    updated = {**value, **changes, 'stage': stage}
    reset_protocol.atomic(path, updated)
    if reset_protocol.read(path) != updated:
        raise RuntimeError('reset_acceptance_receipt_changed')
    return updated


def _owned(plan, runner, environment):
    rows = [row for row in reset_initialization._all_containers(runner, environment)
            if row.get('project') == plan['project']]
    by_service = {}
    for row in rows:
        service = row.get('service')
        if service in by_service or service not in plan['services']:
            raise RuntimeError('reset_acceptance_resource_changed')
        by_service[service] = row
    if set(by_service) != set(plan['services']):
        raise RuntimeError('reset_acceptance_resource_missing')
    if ({row['id'] for row in rows} & set(plan['old_container_ids']) or
            any(by_service[name]['id'] != identifier
                for name, identifier in plan['initial_containers'].items())):
        raise RuntimeError('reset_acceptance_resource_changed')
    return by_service


def _container_identity(by_service):
    return [{'service': name, 'id': row['id']}
            for name, row in sorted(by_service.items())]


def _assert_no_restart(by_service):
    if any(reset_quiescence.restart_policy(row['restart_policy']) !=
           {'Name': 'no', 'MaximumRetryCount': 0} for row in by_service.values()):
        raise RuntimeError('reset_acceptance_restart_owner_enabled')


def _fence_state(state, reset_id):
    expected = ('nocheh-reset:' + reset_id + '\n').encode(); present = 0
    for relative in reset_quiescence.FENCES:
        path = Path(state) / relative
        if path.exists() or path.is_symlink():
            reset_quiescence.verify_fence(path, expected); present += 1
    if present not in (0, len(reset_quiescence.FENCES)):
        raise RuntimeError('reset_acceptance_fence_release_interrupted')
    return present


def _release_fences(journal):
    expected = ('nocheh-reset:' + journal.value['reset_id'] + '\n').encode()
    for relative in reset_quiescence.FENCES:
        path = journal.state / relative
        if not path.exists() and not path.is_symlink():
            continue
        reset_quiescence.verify_fence(path, expected)
        path.unlink(); reset_protocol.sync_directory(path.parent)


def _state(identifier, runner, environment):
    return json.loads(runner(['docker', 'inspect', '--format',
                              '{{json .State}}', identifier], environment))


def _condition(value, condition):
    status = value.get('Status'); health = value.get('Health', {}).get('Status')
    if condition == 'service_completed_successfully':
        return status == 'exited' and value.get('ExitCode') == 0
    if condition == 'service_healthy':
        return status == 'running' and health == 'healthy'
    return status in ('running', 'exited')


def _wait(identifier, condition, runner, environment, timeout):
    deadline = time.monotonic() + timeout
    while True:
        value = _state(identifier, runner, environment)
        if _condition(value, condition):
            return value
        if value.get('Status') == 'exited' and value.get('ExitCode') not in (None, 0):
            raise RuntimeError('reset_acceptance_service_failed')
        if time.monotonic() >= deadline:
            raise RuntimeError('reset_acceptance_health_timeout')
        time.sleep(1)


def _start(plan, rendered, by_service, runner, environment, timeout):
    required = {}
    for service in plan['services']:
        for dependency, settings in rendered['services'][service].get('depends_on', {}).items():
            condition = settings.get('condition', 'service_started') if isinstance(settings, dict) else 'service_started'
            required.setdefault(dependency, set()).add(condition)
    for service in plan['order']:
        row = by_service[service]; state = _state(row['id'], runner, environment)
        conditions = required.get(service, {'service_healthy' if state.get('Health') else 'service_started'})
        if state.get('Status') not in ('running',) and not (
                state.get('Status') == 'exited' and
                'service_completed_successfully' in conditions and state.get('ExitCode') == 0):
            runner(['docker', 'start', row['id']], environment)
        for condition in sorted(conditions):
            _wait(row['id'], condition, runner, environment, timeout)
    for service in plan['desired']:
        value = _state(by_service[service]['id'], runner, environment)
        if value.get('Status') != 'running' or value.get('Health', {}).get('Status', 'healthy') != 'healthy':
            raise RuntimeError('reset_acceptance_service_not_running')


def activate(journal, preflight, *, runner=run, environment=None, command=None,
             timeout=180):
    """Enter live acceptance with all automatic restart ownership disabled."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (8, 9) or
            journal.value['steps'][7]['step'] != 'telegram_boundary' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_acceptance_phase_required')
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    path = journal.directory / 'acceptance-mode.json'
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path); recorded_plan = value.get('plan')
        if not isinstance(recorded_plan, dict):
            raise ValueError('reset_acceptance_receipt_changed')
        receipt = _receipt(journal); initialization = _initialization_receipt(journal)
        desired = [row['service'] for row in receipt['containers'] if row['state'] == 'running']
        profiles = _profiles(environment, desired)
        rendered = _render(command, profiles, environment, runner)
        plan = _plan(journal, preflight, initialization, rendered, receipt, profiles)
        if plan != recorded_plan:
            raise ValueError('reset_acceptance_plan_changed')
        path, value = _record(journal, plan)
    else:
        # This is the final empty-baseline validation.  After activation, fresh
        # live evidence is expected to make the installation non-empty.
        reset_baseline.verify(journal, preflight, runner=runner,
                              environment=environment, command=command)
        initialization = reset_initialization.assert_initialized(
            journal, preflight, runner=runner, environment=environment, command=command)
        receipt = _receipt(journal)
        desired = [row['service'] for row in receipt['containers'] if row['state'] == 'running']
        profiles = _profiles(environment, desired)
        rendered = _render(command, profiles, environment, runner)
        plan = _plan(journal, preflight, initialization, rendered, receipt, profiles)
        path, value = _record(journal, plan)

    if value['stage'] == 'prepared':
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        runner(_compose(command, profiles, ['create', '--no-build', *plan['desired']]), environment)
        by_service = _owned(plan, runner, environment)
        runner(['docker', 'update', '--restart=no',
                *[row['id'] for row in by_service.values()]], environment)
        by_service = _owned(plan, runner, environment); _assert_no_restart(by_service)
        value = _advance(journal, path, value, 'containers_created',
                         containers=_container_identity(by_service))
    by_service = _owned(plan, runner, environment); _assert_no_restart(by_service)
    if _container_identity(by_service) != value['containers']:
        raise RuntimeError('reset_acceptance_resource_changed')
    if value['stage'] == 'containers_created':
        reset_quiescence.assert_fences(journal.state, journal.value['reset_id'])
        value = _advance(journal, path, value, 'fences_release_intent')
    if value['stage'] == 'fences_release_intent':
        _release_fences(journal)
        if _fence_state(journal.state, journal.value['reset_id']) != 0:
            raise RuntimeError('reset_acceptance_fence_release_interrupted')
        _start(plan, rendered, by_service, runner, environment, timeout)
        by_service = _owned(plan, runner, environment); _assert_no_restart(by_service)
        value = _advance(journal, path, value, 'acceptance_running',
                         activated_at=reset_protocol.now())
    if value['stage'] == 'acceptance_running':
        if _fence_state(journal.state, journal.value['reset_id']) != 0:
            raise RuntimeError('reset_acceptance_fence_changed')
        _start(plan, rendered, by_service, runner, environment, timeout)
        by_service = _owned(plan, runner, environment); _assert_no_restart(by_service)
    return {'phase': 'acceptance_running', 'services': len(plan['desired']),
            'containers': len(by_service), 'restart_ownership': False,
            'fresh_acceptance': False, 'resumed': False}


def _fresh_result(raw, request):
    lines = [line for line in raw.splitlines() if line.strip()]
    try:
        value = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        raise RuntimeError('reset_fresh_acceptance_verification_failed') from None
    names = ('owner_dm', 'dedicated_group', 'reply', 'human_reaction',
             'subscription_transcription', 'learned_recall', 'owner_correction',
             'isolation', 'intentional_silence', 'exact_approval',
             'restart_recovery', 'honcho')
    required = {'event', 'reset_id', 'generation', 'mode', 'boundary_confirmed_at',
                'checks', 'source_events', 'live_only', 'historical_evidence',
                'fixtures_accepted', 'dedicated_group_sha256',
                'human_participant_sha256'}
    if (not isinstance(value, dict) or set(value) != required or
            value['event'] != 'reset_fresh_acceptance_verified' or
            value['reset_id'] != request['reset_id'] or
            value['generation'] != request['generation'] or
            value['mode'] != 'live' or
            value['boundary_confirmed_at'] != request['boundary_confirmed_at'] or
            value['checks'] != {name: 'passed' for name in names} or
            type(value['source_events']) is not int or value['source_events'] < 8 or
            value['live_only'] is not True or value['historical_evidence'] is not False or
            value['fixtures_accepted'] is not False or
            value['dedicated_group_sha256'] != request['dedicated_group_sha256'] or
            value['human_participant_sha256'] != request['human_participant_sha256']):
        raise RuntimeError('reset_fresh_acceptance_verification_failed')
    return value


def _request(journal, evidence):
    if (not isinstance(evidence, dict) or evidence.get('format') != 'nocheh-fresh-acceptance-v1' or
            evidence.get('mode') != 'live' or evidence.get('reset_id') != journal.value['reset_id'] or
            evidence.get('generation') != journal.value['generation'] or
            evidence.get('boundary_confirmed_at') != journal.value['telegram']['confirmed_at']):
        raise ValueError('reset_fresh_acceptance_request_invalid')
    # The store verifier applies the complete closed schema.  Reject obvious
    # attempts to label historical or fixture evidence before creating a file.
    if any(key in evidence for key in ('fixture', 'synthetic', 'historical')):
        raise ValueError('reset_fresh_acceptance_request_invalid')
    return evidence


def verify_fresh(journal, preflight, evidence, *, runner=run, environment=None,
                 command=None, timeout=180):
    """Advance only ``fresh_acceptance`` after current live store verification."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (8, 9) or
            journal.value['steps'][7]['step'] != 'telegram_boundary' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_fresh_acceptance_phase_required')
    request = _request(journal, evidence)
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    activate(journal, preflight, runner=runner, environment=environment,
             command=command, timeout=timeout)
    activation = reset_protocol.read(journal.directory / 'acceptance-mode.json')
    if activation.get('stage') != 'acceptance_running':
        raise ValueError('reset_fresh_acceptance_activation_changed')
    request_path = journal.directory / 'fresh-acceptance-request.json'
    if request_path.exists() or request_path.is_symlink():
        if reset_protocol.read(request_path) != request:
            raise ValueError('reset_fresh_acceptance_request_changed')
    else:
        reset_protocol.atomic(request_path, request, create=True)
    profiles = ['reset', *activation['plan']['profiles']]
    raw = runner(_compose(command, profiles, ['run', '--rm', '--no-deps', '--pull',
                                               'never', 'nocheh-reset-acceptance']), environment)
    verified = _fresh_result(raw, request)
    receipt = {'format': 'nocheh-reset-fresh-acceptance-v1',
               'reset_id': journal.value['reset_id'],
               'generation': journal.value['generation'],
               'telegram_sha256': journal.value['steps'][7]['evidence_sha256'],
               'activation_sha256': reset_protocol.fingerprint(activation),
               'request_sha256': reset_protocol.fingerprint(request),
               'verified': verified}
    path = journal.directory / 'fresh-acceptance.json'
    if path.exists() or path.is_symlink():
        if reset_protocol.read(path) != receipt:
            raise ValueError('reset_fresh_acceptance_evidence_changed')
    else:
        reset_protocol.atomic(path, receipt, create=True)
    evidence_sha256 = reset_protocol.fingerprint(receipt)
    journal.complete('fresh_acceptance', evidence_sha256)
    return {'phase': 'fresh_acceptance', 'checks': len(verified['checks']),
            'live_only': True, 'restart_ownership': False, 'resumed': False}


def _policy_argument(value):
    policy = reset_quiescence.restart_policy(value)
    if policy['Name'] == 'on-failure' and policy['MaximumRetryCount']:
        return 'on-failure:' + str(policy['MaximumRetryCount'])
    return policy['Name']


def _resumption_base(journal, activation, acceptance):
    return {'format': 'nocheh-reset-resumption-v1',
            'reset_id': journal.value['reset_id'],
            'generation': journal.value['generation'],
            'acceptance_sha256': reset_protocol.fingerprint(acceptance),
            'activation_sha256': reset_protocol.fingerprint(activation),
            'containers': activation['containers'],
            'restart_policies': activation['plan']['restart_policies'],
            'stage': 'prepared'}


def resume(journal, preflight, *, runner=run, environment=None, command=None,
           timeout=180):
    """Restore only saved restart ownership after the fresh live gate passes."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (9, 10) or
            journal.value['steps'][8]['step'] != 'fresh_acceptance' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_resumption_phase_required')
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    command = configuration.compose_command(journal.state) if command is None else command
    activation = reset_protocol.read(journal.directory / 'acceptance-mode.json')
    acceptance = reset_protocol.read(journal.directory / 'fresh-acceptance.json')
    if (activation.get('stage') != 'acceptance_running' or
            acceptance.get('format') != 'nocheh-reset-fresh-acceptance-v1' or
            reset_protocol.fingerprint(acceptance) != journal.value['steps'][8]['evidence_sha256']):
        raise ValueError('reset_resumption_evidence_changed')
    plan = activation['plan']; profiles = plan['profiles']
    rendered = _render(command, profiles, environment, runner)
    receipt = _receipt(journal); initialization = _initialization_receipt(journal)
    expected = _plan(journal, preflight, initialization, rendered, receipt, profiles)
    if expected != plan:
        raise ValueError('reset_resumption_plan_changed')
    by_service = _owned(plan, runner, environment)
    if _container_identity(by_service) != activation['containers']:
        raise RuntimeError('reset_resumption_resource_changed')
    if _fence_state(journal.state, journal.value['reset_id']) != 0:
        raise RuntimeError('reset_resumption_fence_changed')
    _start(plan, rendered, by_service, runner, environment, timeout)
    path = journal.directory / 'resumption.json'; base = _resumption_base(journal, activation, acceptance)
    if path.exists() or path.is_symlink():
        value = reset_protocol.read(path)
        if value != base and value != {**base, 'stage': 'policies_restored'}:
            raise ValueError('reset_resumption_receipt_changed')
    else:
        reset_protocol.atomic(path, base, create=True); value = base
    policies = plan['restart_policies']
    for service in plan['desired']:
        current = reset_quiescence.restart_policy(by_service[service]['restart_policy'])
        expected_policy = reset_quiescence.restart_policy(policies[service])
        if current not in ({'Name': 'no', 'MaximumRetryCount': 0}, expected_policy):
            raise RuntimeError('reset_resumption_restart_policy_changed')
        if current != expected_policy:
            runner(['docker', 'update', '--restart=' + _policy_argument(expected_policy),
                    by_service[service]['id']], environment)
            by_service = _owned(plan, runner, environment)
    if any(reset_quiescence.restart_policy(by_service[name]['restart_policy']) !=
           reset_quiescence.restart_policy(policies[name]) for name in plan['desired']):
        raise RuntimeError('reset_resumption_restart_policy_changed')
    if value['stage'] == 'prepared':
        value = {**base, 'stage': 'policies_restored'}; reset_protocol.atomic(path, value)
    evidence_sha256 = reset_protocol.fingerprint(value)
    journal.complete('resumed', evidence_sha256)
    return {'phase': 'resumed', 'services': len(plan['desired']),
            'fresh_acceptance': True, 'restart_ownership': True, 'resumed': True}
