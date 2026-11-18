"""Explicit runtime environment values; optional _FILE convention for secret managers."""
import os
from pathlib import Path


def secret(name, required=True):
    value = os.environ.get(name)
    if value is None and os.environ.get(name + '_FILE'):
        value = Path(os.environ[name + '_FILE']).read_text()
    value = (value or '').strip()
    if required and not value: raise ValueError('Missing ' + name)
    return value


def telegram_policy():
    """Whether Telegram is on. The owner, the owner's private chat and the served groups come from the app's served list
    (ADR-0252), and who else may talk in a group from the app's member directory (step 3), never from here."""
    enabled = os.environ.get('TELEGRAM_ENABLED', 'false')
    if enabled not in ('true', 'false'): raise ValueError('Invalid TELEGRAM_ENABLED')
    return {'enabled': enabled == 'true'}


def parallel(name, default, high=8):
    """Owner-set concurrency of 1 to high. A malformed value stops startup rather than guessing."""
    value = os.environ.get(name, '').strip() or str(default)
    if value not in tuple('12345678'[:high]): raise ValueError('Invalid ' + name)
    return int(value)
