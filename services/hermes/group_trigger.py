"""Group messages start a turn only when they address the bot, unless the owner allows every message."""
import os
import re

MODES = ('addressed', 'all')


def reply_mode():
    """Owner setting; a malformed value stops startup rather than guessing."""
    value = os.environ.get('TELEGRAM_GROUP_REPLIES', '').strip() or 'addressed'
    if value not in MODES: raise ValueError('Invalid TELEGRAM_GROUP_REPLIES')
    return value


def names():
    """Extra names that address the bot when they open a group message."""
    values = [value.strip() for value in os.environ.get('TELEGRAM_GROUP_NAMES', '').split(',') if value.strip()]
    if len(values) > 10 or any(len(value) > 32 for value in values): raise ValueError('Invalid TELEGRAM_GROUP_NAMES')
    return values


def addressed(facts, text, username, names):
    """A reply to the bot or tap on its name, its @username, or a name opening the message.

    `facts` come from the captured original because the routed message keeps
    neither its reply target nor its entities; `text` is the routed text.
    """
    facts = facts if isinstance(facts, dict) else {}
    if facts.get('direct') is True: return True
    handles = facts.get('handles') if isinstance(facts.get('handles'), list) else []
    if username and username.lower() in handles: return True
    opening = text if isinstance(text, str) else ''
    return any(re.match(r'\W*' + re.escape(name) + r'(?!\w)', opening, re.IGNORECASE) for name in names if name)
