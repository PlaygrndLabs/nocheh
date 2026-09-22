"""Explicit runtime environment values; optional _FILE convention for secret managers."""
import os
import json
from pathlib import Path


def secret(name, required=True):
    value = os.environ.get(name)
    if value is None and os.environ.get(name + '_FILE'):
        value = Path(os.environ[name + '_FILE']).read_text()
    value = (value or '').strip()
    if required and not value: raise ValueError('Missing ' + name)
    return value


def telegram_policy():
    enabled = os.environ.get('TELEGRAM_ENABLED', 'false')
    if enabled not in ('true', 'false'): raise ValueError('Invalid TELEGRAM_ENABLED')
    return {'enabled': enabled == 'true', 'owner_id': os.environ.get('TELEGRAM_OWNER_ID') or None,
            'group_ids': [v.strip() for v in os.environ.get('TELEGRAM_GROUP_IDS', '').split(',') if v.strip()],
            'group_access': json.loads(os.environ.get('TELEGRAM_GROUP_ACCESS', '{}'))}
