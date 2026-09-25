"""Rebind one verified app image replacement during reset acceptance mode."""
from . import configuration, reset_acceptance, reset_acceptance_refresh, reset_protocol, settings

FORMAT = 'nocheh-reset-acceptance-code-refresh-v1'
SERVICE = 'nocheh-app'
NAME = 'acceptance-code-refresh.json'


def _image(identifier, runner, environment):
    value = runner(['docker', 'inspect', '--format', '{{.Image}}', identifier], environment).strip()
    if not value.startswith('sha256:') or len(value) != 71:
        raise ValueError('reset_code_refresh_image_invalid')
    return value


def _current(journal, runner, environment):
    activation = reset_acceptance_refresh._activation(journal)
    if (SERVICE not in activation['plan']['desired'] or
            SERVICE in activation['plan']['initial_containers']):
        raise ValueError('reset_code_refresh_service_plan_changed')
    containers = reset_acceptance_refresh._containers(journal, activation, runner, environment)
    config = configuration.load(journal.state)
    if settings.view(journal.state)['apply_state'] != 'current':
        raise ValueError('reset_code_refresh_settings_unapplied')
    return activation, containers, reset_protocol.fingerprint(config)


def prepare(journal, image_id, *, runner=reset_acceptance.run, environment=None):
    """Persist the intended replacement and image before Compose acts."""
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    activation, containers, config_hash = _current(journal, runner, environment)
    if containers != activation['containers']:
        raise RuntimeError('reset_code_refresh_container_identity_changed')
    old = next(row['id'] for row in containers if row['service'] == SERVICE)
    if _image(old, runner, environment) == image_id or not image_id.startswith('sha256:') or len(image_id) != 71:
        raise ValueError('reset_code_refresh_new_image_required')
    intent = {'format': FORMAT, 'reset_id': journal.value['reset_id'],
              'generation': journal.value['generation'], 'stage': 'prepared',
              'activation_before_sha256': reset_protocol.fingerprint(activation),
              'containers_before': containers, 'configuration_sha256': config_hash,
              'image_id': image_id, 'containers_after': None, 'activation_after_sha256': None}
    path = journal.directory / NAME
    if path.exists() or path.is_symlink():
        if reset_protocol.read(path) != intent:
            raise ValueError('reset_code_refresh_intent_changed')
    else:
        reset_protocol.atomic(path, intent, create=True)
    return {'stage': 'prepared', 'service': SERVICE}


def finish(journal, *, runner=reset_acceptance.run, environment=None):
    """Rebind only when exactly the intended healthy app image replaced its predecessor."""
    environment = configuration.compose_environment(journal.state) if environment is None else environment
    activation, containers, config_hash = _current(journal, runner, environment)
    path = journal.directory / NAME
    intent = reset_protocol.read(path)
    if (intent.get('format') != FORMAT or intent.get('reset_id') != journal.value['reset_id'] or
            intent.get('generation') != journal.value['generation'] or
            intent.get('stage') not in ('prepared', 'validated', 'complete') or
            intent.get('configuration_sha256') != config_hash):
        raise ValueError('reset_code_refresh_intent_changed')
    old = {row['service']: row['id'] for row in intent['containers_before']}
    new = {row['service']: row['id'] for row in containers}
    if set(old) != set(new) or {name for name in old if old[name] != new[name]} != {SERVICE}:
        raise RuntimeError('reset_code_refresh_unexpected_container_replacement')
    if _image(new[SERVICE], runner, environment) != intent['image_id']:
        raise RuntimeError('reset_code_refresh_unexpected_image')
    updated = {**activation, 'containers': containers}
    expected_hash = reset_protocol.fingerprint(updated)
    if intent['stage'] == 'prepared':
        if reset_protocol.fingerprint(activation) != intent['activation_before_sha256']:
            raise ValueError('reset_code_refresh_activation_changed')
        intent = {**intent, 'stage': 'validated', 'containers_after': containers,
                  'activation_after_sha256': expected_hash}
        reset_protocol.atomic(path, intent)
    if intent['containers_after'] != containers or intent['activation_after_sha256'] != expected_hash:
        raise ValueError('reset_code_refresh_intent_changed')
    if activation['containers'] == intent['containers_before']:
        reset_protocol.atomic(journal.directory / 'acceptance-mode.json', updated)
    elif activation != updated:
        raise ValueError('reset_code_refresh_activation_changed')
    if intent['stage'] != 'complete':
        reset_protocol.atomic(path, {**intent, 'stage': 'complete'})
    return {'stage': 'complete', 'service': SERVICE, 'restart_ownership': False}
