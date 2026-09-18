"""Bounded configuration transfer for a quiesced, original-only installation reset.

The reset coordinator owns maintenance exclusion and control-catalog admission.
This module never copies native content or credentials and never grants a profile.
"""
import hashlib
import json
import os
import re
from pathlib import Path

import yaml

from .policy_config import effective, validate
from .profile_config import PREFERENCES, atomic_yaml, resolved
from .scopes import Scopes

FORMAT = 'nocheh-runtime-preferences-v1'
NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}')
CUSTOM = re.compile(r'profile-[a-f0-9]{48}')
SOURCE = re.compile(r'(nocheh-policy.yaml|profiles/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}/(config.yaml|space.json|nocheh-owner-profile.json))')


def _path(root, relative=''):
    root = Path(root)
    if root.is_symlink():
        raise ValueError('preference_path_denied')
    path = root
    for part in Path(relative).parts:
        if part in ('..', '.') or '/' in part:
            raise ValueError('preference_path_denied')
        path = path / part
        if path.is_symlink():
            raise ValueError('preference_path_denied')
    return path


def _bytes(root, relative):
    path = _path(root, relative)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError('invalid_preference_file')
    with path.open('rb') as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise ValueError('invalid_preference_file')
    return raw


def _directory(path):
    if path.exists():
        return
    _directory(path.parent)
    path.mkdir(mode=0o700)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _inventory(root):
    parent = _path(root, 'profiles')
    if not parent.exists():
        return []
    result = []
    for path in parent.iterdir():
        if path.is_symlink() or not path.is_dir() or not NAME.fullmatch(path.name):
            raise ValueError('preference_path_denied')
        result.append(path.name)
        if len(result) > 10000:
            raise ValueError('preference_profile_limit')
    return sorted(result)


def _label(value):
    if (not isinstance(value, str) or not NAME.fullmatch(value) or
            value.startswith('nocheh-') or CUSTOM.fullmatch(value) or
            value in ('default', 'current', 'all')):
        raise ValueError('profile_name_requires_mapping')
    return value


def _values(value):
    validate(value)
    if any(item is None for item in value.values()):
        raise ValueError('invalid_preference')
    return dict(value)


def _overrides(config):
    marker = config.get('nocheh', {})
    if not isinstance(marker, dict):
        raise ValueError('invalid_profile_config')
    inherited = marker.get('inherited_preferences', [])
    if (not isinstance(inherited, list) or any(not isinstance(key, str) for key in inherited) or
            set(inherited) - PREFERENCES.keys()):
        raise ValueError('invalid_preference_inheritance')
    result = {}
    for key in PREFERENCES:
        section, field = key.split('.')
        values = config.get(section, {})
        if not isinstance(values, dict):
            raise ValueError('invalid_profile_config')
        if key not in inherited and field in values:
            result[key] = values[field]
    return _values(result)


def capture(root, policy, catalog=None):
    """Read only allowed preferences; catalog=None selects legacy owner markers.

    For an original-only source, supply active control runtime_profiles rows.
    The caller must fence changes to both the filesystem and that catalog.
    """
    if not isinstance(policy.owner, str) or not policy.owner:
        raise ValueError('owner_required')
    inventory = _inventory(root)
    files = {}

    def read(relative, kind='yaml'):
        raw = _bytes(root, relative)
        files[relative] = None if raw is None else hashlib.sha256(raw).hexdigest()
        if raw is None:
            return {}
        value = json.loads(raw) if kind == 'json' else yaml.safe_load(raw)
        if not isinstance(value, dict):
            raise ValueError('invalid_preference_file')
        return value

    global_values = _values(read('nocheh-policy.yaml').get('global', {}))
    spaces = set([policy.owner, *policy.groups])
    custom = []
    if catalog is not None:
        if not isinstance(catalog, list) or len(catalog) > 100:
            raise ValueError('invalid_profile_catalog')
        for row in catalog:
            if (not isinstance(row, dict) or row.get('owner_id') != policy.owner or
                    row.get('state') != 'active' or not isinstance(row.get('id'), str) or
                    not CUSTOM.fullmatch(row['id'])):
                raise ValueError('invalid_profile_catalog')
            custom.append((row['id'], row['id'], _label(row.get('name'))))
    for name in inventory:
        binding = read(f'profiles/{name}/space.json', 'json')
        space = binding.get('space')
        if isinstance(space, str) and re.fullmatch(r'-\d{1,19}/topic/[1-9]\d{0,18}', space):
            if space.split('/topic/')[0] in policy.groups:
                spaces.add(space)
        if catalog is None:
            marker = read(f'profiles/{name}/nocheh-owner-profile.json', 'json')
            if marker:
                if marker != {'scope': 'owner'}:
                    raise ValueError('invalid_owner_profile_marker')
                label = _label(name)
                identity = 'profile-' + hashlib.sha256(('preserved-profile:' + policy.owner + ':' + label).encode()).hexdigest()[:48]
                custom.append((name, identity, label))
    profiles = []
    for space in sorted(spaces):
        identity = Scopes.profile(space)
        relative = f'profiles/{identity}/config.yaml'
        config = read(relative)
        # Absence means that a topic inherits its parent chat's preferences.
        if '/topic/' in space and files[relative] is None:
            continue
        profiles.append({'id': identity, 'space': space, 'name': None, 'overrides': _overrides(config)})
    for directory, identity, label in sorted(custom):
        profiles.append({'id': identity, 'space': policy.owner, 'name': label,
                         'overrides': _overrides(read(f'profiles/{directory}/config.yaml'))})
    snapshot = {'format': FORMAT, 'owner': policy.owner, 'groups': sorted(set(policy.groups)),
                'global': global_values, 'profiles': profiles, 'source_files': files,
                'source_inventory': inventory}
    validate_snapshot(snapshot)
    verify_source(root, snapshot)
    return snapshot


def validate_snapshot(snapshot):
    required = {'format', 'owner', 'groups', 'global', 'profiles', 'source_files', 'source_inventory'}
    if not isinstance(snapshot, dict) or set(snapshot) != required or snapshot['format'] != FORMAT:
        raise ValueError('invalid_preference_snapshot')
    owner, groups = snapshot['owner'], snapshot['groups']
    if (not isinstance(owner, str) or not re.fullmatch(r'[1-9]\d{0,18}', owner) or
            not isinstance(groups, list) or any(not isinstance(g, str) or not re.fullmatch(r'-\d{1,19}', g) for g in groups) or
            groups != sorted(set(groups))):
        raise ValueError('invalid_preference_scope')
    _values(snapshot['global'])
    profiles = snapshot['profiles']
    if not isinstance(profiles, list) or len(profiles) > 10100:
        raise ValueError('invalid_preference_profiles')
    identities, names, spaces = set(), set(), set()
    for row in profiles:
        if not isinstance(row, dict) or set(row) != {'id', 'space', 'name', 'overrides'}:
            raise ValueError('invalid_preference_profile')
        identity, space = row['id'], row['space']
        if not isinstance(identity, str) or not isinstance(space, str) or identity in identities:
            raise ValueError('invalid_preference_profile')
        if row['name'] is not None:
            label = _label(row['name'])
            if not CUSTOM.fullmatch(identity) or space != owner or label in names:
                raise ValueError('invalid_preference_profile')
            names.add(label)
        else:
            chat = space.split('/topic/')[0]
            if (chat not in [owner, *groups] or identity != Scopes.profile(space) or
                    space != chat and (chat == owner or not re.fullmatch(r'-\d{1,19}/topic/[1-9]\d{0,18}', space))):
                raise ValueError('invalid_preference_scope')
            spaces.add(space)
        identities.add(identity)
        _values(row['overrides'])
    if len(names) > 100 or not set([owner, *groups]).issubset(spaces):
        raise ValueError('invalid_preference_profiles')
    files, inventory = snapshot['source_files'], snapshot['source_inventory']
    if (not isinstance(inventory, list) or len(inventory) > 10000 or
            any(not isinstance(v, str) or not NAME.fullmatch(v) for v in inventory) or inventory != sorted(set(inventory)) or
            not isinstance(files, dict) or len(files) > 40101 or 'nocheh-policy.yaml' not in files):
        raise ValueError('invalid_preference_sources')
    for key, value in files.items():
        if not isinstance(key, str) or not SOURCE.fullmatch(key) or value is not None and (
                not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value)):
            raise ValueError('invalid_preference_sources')


def verify_source(root, snapshot):
    validate_snapshot(snapshot)
    if _inventory(root) != snapshot['source_inventory']:
        raise ValueError('preference_source_changed')
    for relative, expected in snapshot['source_files'].items():
        raw = _bytes(root, relative)
        if (None if raw is None else hashlib.sha256(raw).hexdigest()) != expected:
            raise ValueError('preference_source_changed')


def profile_commands(snapshot):
    """Requests for the explicit control repository, not filesystem authority."""
    validate_snapshot(snapshot)
    return [{'id': row['id'], 'name': row['name'], 'state': 'active', 'expected_revision': 0,
             'operation_id': 'restore-preferences:' + row['id']}
            for row in snapshot['profiles'] if row['name'] is not None]


def restore(root, snapshot, model, admitted_profiles):
    """Apply to empty native state after custom profiles are admitted in control.

    Exact partial configuration writes are safe to retry. Conflicts or native
    history fail before any writes. External credentials in root are untouched.
    """
    validate_snapshot(snapshot)
    expected = {row['id']: row for row in snapshot['profiles'] if row['name'] is not None}
    if (not isinstance(admitted_profiles, list) or len(admitted_profiles) != len(expected) or
            any(not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] not in expected or
                row.get('name') != expected[row['id']]['name'] or row.get('owner_id') != snapshot['owner'] or
                row.get('state') != 'active' for row in admitted_profiles) or
            {row['id'] for row in admitted_profiles} != set(expected)):
        raise ValueError('preference_catalog_not_admitted')
    root = Path(root)
    allowed = {row['id'] for row in snapshot['profiles']}
    if set(_inventory(root)) - allowed:
        raise ValueError('preference_target_not_empty')
    writes = {'nocheh-policy.yaml': {'global': snapshot['global']}}
    for row in snapshot['profiles']:
        config = {'nocheh': {'inherited_preferences': sorted(PREFERENCES.keys() - row['overrides'].keys())}}
        for key, value in row['overrides'].items():
            section, field = key.split('.')
            config.setdefault(section, {})[field] = value
        values, _ = effective(root, config, policy=writes['nocheh-policy.yaml'])
        for key, value in values.items():
            section, field = key.split('.')
            config.setdefault(section, {})[field] = value
        path = _path(root, 'profiles/' + row['id'])
        if path.exists() and any(item.name != 'config.yaml' for item in path.iterdir()):
            raise ValueError('preference_target_not_empty')
        writes[f'profiles/{row["id"]}/config.yaml'] = resolved(config, model)
    for relative, value in writes.items():
        raw = _bytes(root, relative)
        if raw is not None and yaml.safe_load(raw) != value:
            raise ValueError('preference_target_conflict')
    for relative, value in writes.items():
        path = _path(root, relative)
        if not path.exists():
            _directory(path.parent)
            atomic_yaml(path, value)
    return {'profiles': len(snapshot['profiles']), 'custom_profiles': len(expected), 'native_content_copied': False}
