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


_AGENT_KEY = None


def agent_key():
    """The agent login (ADR-0295): Nocheh and Hermes call each other with it. Kept here once read, so a process may drop
    it from its environment before starting children that must not hold it."""
    global _AGENT_KEY
    if _AGENT_KEY is None or 'AGENT_KEY' in os.environ or 'AGENT_KEY_FILE' in os.environ:
        value = secret('AGENT_KEY')
        if len(value) < 32: raise ValueError('AGENT_KEY must contain at least 32 characters')
        _AGENT_KEY = value
    return _AGENT_KEY


def refuse_master_key():
    """Nocheh's master key signs every pass and is its admin bearer; Hermes's processes must never hold it."""
    if 'SERVICE_TOKEN' in os.environ or 'SERVICE_TOKEN_FILE' in os.environ:
        raise SystemExit('SERVICE_TOKEN must not reach Hermes; run ./bin/nocheh up to recreate its containers')


def session_token():
    """The Hermes dashboard's own session token: at least 32 characters and never the agent login."""
    value = secret('NOCHEH_HERMES_SESSION_TOKEN', False)
    if len(value) < 32 or value == agent_key():
        raise SystemExit('NOCHEH_HERMES_SESSION_TOKEN must contain at least 32 characters and differ from AGENT_KEY; run ./bin/nocheh up')
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
