"""The reset journal's acceptance activation and its containers, during the fresh live acceptance window.

The reset journal pins fresh container IDs. A runtime image replacement rebinds it through
reset_acceptance_code_refresh, which reads the activation and the healthy containers here. A member
change needs no replacement and no rebinding: members are live, and no setting names who may talk in a
group (step 3).
"""
from tools.acceptance import reset_acceptance, reset_protocol


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
