"""Owner settings of the Telegram service, read from its environment. A malformed value stops startup."""
from __future__ import annotations

import os
from pathlib import Path


def secret(name, required=True):
    """A value from the environment, or from the file NAME_FILE points to (for secret managers)."""
    value = os.environ.get(name)
    if value is None and os.environ.get(name + '_FILE'):
        value = Path(os.environ[name + '_FILE']).read_text()
    value = (value or '').strip()
    if required and not value: raise ValueError('Missing ' + name)
    return value


def switch(name):
    """An on/off owner setting, on by default."""
    value = os.environ.get(name, '').strip() or 'true'
    if value not in ('true', 'false'): raise ValueError('Invalid ' + name)
    return value == 'true'


def typing_enabled():
    return switch('TELEGRAM_TYPING')


def reactions_enabled():
    return switch('TELEGRAM_REACTIONS')


def spool():
    return Path(os.environ.get('NOCHEH_SPOOL_DIR', '/data/spool'))


def state():
    return Path(os.environ.get('NOCHEH_TELEGRAM_STATE', '/telegram-state'))


def archive_url():
    return os.environ.get('ARCHIVE_URL', 'http://nocheh-app:8780')


class Policy:
    """Who the bot serves (ADR-0252). Whether it is on comes from its environment; the owner, the owner's private chat and
    the served groups come from the app's served list (services/chats.py), by their Telegram ids now and before. A list
    that cannot be read serves nothing. Who else may talk in a group is the app's member directory alone (step 3): this
    service never decides it."""
    def __init__(self, enabled, served=None):
        if not isinstance(enabled, bool): raise ValueError('invalid_assistant_policy')
        from services.chats import Fixed, Served, ServedList
        self.enabled = enabled
        self.served = Fixed(served) if isinstance(served, Served) else served or ServedList(archive_url, lambda: secret('SERVICE_TOKEN'))

    @classmethod
    def load(cls):
        enabled = os.environ.get('TELEGRAM_ENABLED', 'false')
        if enabled not in ('true', 'false'): raise ValueError('Invalid TELEGRAM_ENABLED')
        return cls(enabled == 'true')

    @classmethod
    def of(cls, enabled, owner, groups, topics=(), old=None, members=()):
        """Tests only: a fixed served list where the owner's chat and each group keep their Telegram id as their chat id,
        as chats stored before step 2b do; `groups` may also hold (chat id, Telegram id) pairs, and `members` lists members'
        own private chats that are open now (step 4) the same way."""
        from services.chats import Served
        return cls(enabled, Served.of(owner, groups=groups, topics=topics, old=old, members=members))

    def current(self, epoch=None, max_age=5.0, holds=None):
        """The served list as the app has it now: read again when older than `max_age` seconds, when a pass carries a
        newer guard epoch than it was read at, or when it does not hold what `holds` asks for (a topic or Telegram id the
        app recorded since)."""
        return self.served.get(epoch, max_age, holds)
