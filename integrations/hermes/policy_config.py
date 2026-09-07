"""Revisioned native-preference inheritance. Runtime capabilities stay explicit."""
import fcntl
import re
from pathlib import Path
from .profile_config import PREFERENCES, atomic_yaml, read, revision


def validate(changes):
    if not isinstance(changes, dict) or set(changes) - PREFERENCES.keys():
        raise ValueError('unsupported_preference')
    for key, value in changes.items():
        if value is None: continue
        spec = PREFERENCES[key]
        if ('choices' in spec and value not in spec['choices']) or ('min' in spec and
                (type(value) is not int or not spec['min'] <= value <= spec['max'])):
            raise ValueError('invalid_preference')


def document(root):
    value = read(Path(root) / 'nocheh-policy.yaml')
    if set(value) - {'global', 'jobs'}: raise ValueError('invalid_policy')
    validate(value.get('global', {}))
    for job, prefs in value.get('jobs', {}).items():
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', job): raise ValueError('invalid_job')
        validate(prefs)
    return value


def effective(root, config, job=None, policy=None):
    policy = document(root) if policy is None else policy
    inherited = config.get('nocheh', {}).get('inherited_preferences', [])
    values, origins = {}, {}
    for key, spec in PREFERENCES.items():
        value, origin = spec['default'], 'default'
        if key in policy.get('global', {}): value, origin = policy['global'][key], 'global'
        section, field = key.split('.')
        if key not in inherited and field in config.get(section, {}):
            value, origin = config[section][field], 'profile'
        if job and key in policy.get('jobs', {}).get(job, {}):
            value, origin = policy['jobs'][job][key], 'job:' + job
        values[key], origins[key] = value, origin
    validate(values)
    return values, origins


def view(root, config=None, job=None):
    value = document(root)
    values, origins = effective(root, config or {}, job)
    return {'revision': revision(value), 'global': value.get('global', {}),
            'jobs': value.get('jobs', {}), 'values': values, 'origins': origins,
            'schema': PREFERENCES, 'takes_effect': 'next managed turn',
            'job_status': 'stored; scheduled execution becomes available in P6',
            'external_actions': 'review each action; broader tools remain unavailable until P5'}


def save(root, changes, expected, job=None):
    root = Path(root); root.mkdir(parents=True, exist_ok=True, mode=0o700)
    validate(changes)
    if job and not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', job): raise ValueError('invalid_job')
    with (root / '.policy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        value = document(root)
        if expected != revision(value): raise ValueError('configuration_conflict')
        target = value.setdefault('jobs', {}).setdefault(job, {}) if job else value.setdefault('global', {})
        for key, item in changes.items():
            if item is None: target.pop(key, None)
            else: target[key] = item
        atomic_yaml(root / 'nocheh-policy.yaml', value)
    return view(root, job=job)
