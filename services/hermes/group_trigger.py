"""Group messages start a turn only when they address the bot, unless the owner allows every message."""
import os
import re

MODES = ('addressed', 'all')
# Used when the setting is absent; the owner may change or remove them.
DEFAULT_NAMES = 'Nocheh,نوچه'


def reply_mode():
    """Owner setting; a malformed value stops startup rather than guessing."""
    value = os.environ.get('TELEGRAM_GROUP_REPLIES', '').strip() or 'addressed'
    if value not in MODES: raise ValueError('Invalid TELEGRAM_GROUP_REPLIES')
    return value


def names():
    """Owner-set names that address the bot when they open a group message; empty means none."""
    values = [value.strip() for value in os.environ.get('TELEGRAM_BOT_NAMES', DEFAULT_NAMES).split(',') if value.strip()]
    if len(values) > 10 or any(len(value) > 32 for value in values): raise ValueError('Invalid TELEGRAM_BOT_NAMES')
    return values


def addressed(facts, text, username, names):
    """A reply to the bot or tap on its name, its @username, or a name opening the message.

    The names are the bot's display name and the owner-set names.

    `facts` come from the captured original because the routed message keeps
    neither its reply target nor its entities; `text` is the routed text.
    """
    facts = facts if isinstance(facts, dict) else {}
    if facts.get('direct') is True: return True
    handles = facts.get('handles') if isinstance(facts.get('handles'), list) else []
    if username and username.lower() in handles: return True
    opening = text if isinstance(text, str) else ''
    return any(re.match(r'\W*' + re.escape(name) + r'(?!\w)', opening, re.IGNORECASE) for name in names if name)
