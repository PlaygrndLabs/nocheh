"""Owner settings of the Telegram service, read from its environment. A malformed value stops startup."""
from __future__ import annotations

import json
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
    """Who the bot serves (ADR-0251). Whether it is on and each group's member access come from its environment; the
    owner, the owner's private chat and the served groups come from the app's served list (services/chats.py), by
    their Telegram ids now and before. A list that cannot be read serves nothing."""
    def __init__(self, enabled, group_access, served=None):
        if not isinstance(enabled, bool): raise ValueError('invalid_assistant_policy')
        # Keyed by any Telegram id a group has had; a key that names no served group grants nothing.
        if not isinstance(group_access, dict) or len(group_access) > 100: raise ValueError('invalid_group_access')
        for group, entry in group_access.items():
            if not isinstance(group, str) or not 0 < len(group) <= 32 or not isinstance(entry, dict) or set(entry) != {'granted', 'denied'}:
                raise ValueError('invalid_group_access')
            for users in entry.values():
                if not isinstance(users, list) or len(users) > 1000 or any(not telegram_user(user) for user in users): raise ValueError('invalid_group_access')
        from services.chats import Fixed, Served, ServedList
        self.enabled, self.group_access = enabled, group_access
        self.served = Fixed(served) if isinstance(served, Served) else served or ServedList(archive_url, lambda: secret('SERVICE_TOKEN'))

    @classmethod
    def load(cls):
        enabled = os.environ.get('TELEGRAM_ENABLED', 'false')
        if enabled not in ('true', 'false'): raise ValueError('Invalid TELEGRAM_ENABLED')
        return cls(enabled == 'true', json.loads(os.environ.get('TELEGRAM_GROUP_ACCESS', '{}')))

    @classmethod
    def of(cls, enabled, owner, groups, group_access, topics=(), old=None):
        """Tests only: a fixed served list where the owner's chat and each group keep their Telegram id as their chat id,
        as chats stored before step 2b do; `groups` may also hold (chat id, Telegram id) pairs."""
        from services.chats import Served
        return cls(enabled, group_access, Served.of(owner, groups=groups, topics=topics, old=old))

    def current(self, epoch=None, max_age=5.0, holds=None):
        """The served list as the app has it now: read again when older than `max_age` seconds, when a pass carries a
        newer guard epoch than it was read at, or when it does not hold what `holds` asks for (a topic or Telegram id the
        app recorded since)."""
        return self.served.get(epoch, max_age, holds)

    def access(self, served, group, user):
        """Whether `user` may talk to Nocheh in the served group `group` (a Nocheh chat id): granted and not denied, under any
        Telegram id the group has had, so an upgrade keeps who may talk there."""
        entries = [self.group_access.get(external, {}) for external in served.app_ids(group)]
        return any(user in entry.get('granted', []) for entry in entries) and not any(user in entry.get('denied', []) for entry in entries)


def telegram_user(value):
    """A Telegram user id as the Bot API writes it: a positive number with no leading zero."""
    return isinstance(value, str) and value.isascii() and value.isdigit() and 0 < len(value) <= 19 and value[0] != '0'
