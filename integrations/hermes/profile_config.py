"""Native preferences with explicit Nocheh-owned runtime policy."""
import hashlib
import json
import os
import tempfile
import fcntl
from pathlib import Path
import yaml

PREFERENCES = {
    'agent.reasoning_effort': {'default': 'low', 'choices': ['low', 'medium', 'high']},
    'agent.max_iterations': {'default': 8, 'min': 1, 'max': 16},
    'agent.run_budget_seconds': {'default': 180, 'min': 30, 'max': 180},
    'memory.memory_char_limit': {'default': 2200, 'min': 100, 'max': 20000},
    'memory.user_char_limit': {'default': 1375, 'min': 100, 'max': 20000},
}


def read(path):
    if not path.exists(): return {}
    value = yaml.safe_load(path.read_text())
    if not isinstance(value, dict): raise ValueError('invalid_profile_config')
    return value


def atomic_yaml(path, value):
    descriptor, name = tempfile.mkstemp(prefix='.config-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            yaml.safe_dump(value, file, allow_unicode=True, sort_keys=False)
            file.flush(); os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def preferences(config):
    result = {}
    for key, spec in PREFERENCES.items():
        section, field = key.split('.')
        value = config.get(section, {}).get(field, spec['default'])
        if 'choices' in spec:
            if value not in spec['choices']: raise ValueError('invalid_preference_' + key)
        elif type(value) is not int or not spec['min'] <= value <= spec['max']:
            raise ValueError('invalid_preference_' + key)
        result[key] = value
    return result


def resolved(config, model):
    """Keep native fields, but never delegate route/tool policy to mutable YAML."""
    config = json.loads(json.dumps(config))
    values = preferences(config)
    for key, value in values.items():
        section, field = key.split('.')
        config.setdefault(section, {})[field] = value
    config['model'] = {'provider': 'openai-codex', 'default': model}
    config['plugins'] = {'enabled': ['nocheh']}
    config['fallback_models'] = []
    config.setdefault('tools', {})['tool_search'] = {'enabled': 'off'}
    config.setdefault('memory', {}).update(memory_enabled=True, user_profile_enabled=True, provider='')
    config['auxiliary'] = {'session_search': {'provider': 'openai-codex', 'model': model}}
    return config


def revision(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def configure_profile(profile, model, changes=None, expected=None):
    profile = Path(profile); profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = profile / 'config.yaml'
    with (profile / '.config.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        original = read(path)
        if changes is not None:
            if expected != revision(original): raise ValueError('configuration_conflict')
            if not isinstance(changes, dict) or set(changes) - PREFERENCES.keys():
                raise ValueError('unsupported_preference')
            for key, value in changes.items():
                section, field = key.split('.')
                original.setdefault(section, {})[field] = value
        result = resolved(original, model)
        if not path.exists() or result != read(path): atomic_yaml(path, result)
        return {'revision': revision(result), 'values': preferences(result), 'schema': PREFERENCES,
                'source': 'Hermes profile config.yaml', 'takes_effect': 'next turn',
                'managed': ['model', 'plugins', 'fallback_models', 'tools', 'auxiliary', 'memory.provider']}
