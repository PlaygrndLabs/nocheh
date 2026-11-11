"""Owner settings of the Telegram service, read from its environment. A malformed value stops startup."""
from __future__ import annotations

import json
import os
import re
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
    """Who the bot serves: the owner's private chat and the allowed groups, with each group's member access."""
    def __init__(self, enabled, owner, groups, group_access):
        if not isinstance(enabled, bool): raise ValueError('invalid_assistant_policy')
        if owner is not None and (not isinstance(owner, str) or not re.fullmatch(r'[1-9]\d{0,18}', owner)): raise ValueError('invalid_owner')
        if not isinstance(groups, list) or any(not isinstance(g, str) or not re.fullmatch(r'-\d{1,19}', g) for g in groups):
            raise ValueError('invalid_groups')
        if enabled and not owner: raise ValueError('owner_required')
        if not isinstance(group_access, dict) or len(group_access) > 100: raise ValueError('invalid_group_access')
        for group, entry in group_access.items():
            if group not in groups or not isinstance(entry, dict) or set(entry) != {'granted', 'denied'}: raise ValueError('invalid_group_access')
            for users in entry.values():
                if (not isinstance(users, list) or len(users) > 1000 or
                        any(not isinstance(user, str) or not re.fullmatch(r'[1-9]\d{0,18}', user) or user == owner for user in users)):
                    raise ValueError('invalid_group_access')
        self.enabled, self.owner, self.groups, self.group_access = enabled, owner, groups, group_access

    @classmethod
    def load(cls):
        enabled = os.environ.get('TELEGRAM_ENABLED', 'false')
        if enabled not in ('true', 'false'): raise ValueError('Invalid TELEGRAM_ENABLED')
        return cls(enabled == 'true', os.environ.get('TELEGRAM_OWNER_ID') or None,
                   [v.strip() for v in os.environ.get('TELEGRAM_GROUP_IDS', '').split(',') if v.strip()],
                   json.loads(os.environ.get('TELEGRAM_GROUP_ACCESS', '{}')))

    def allowed_chat(self, chat):
        """The owner's private chat or an allowed group."""
        return bool(self.owner) and str(chat) == self.owner or str(chat) in self.groups
