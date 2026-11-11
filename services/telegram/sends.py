"""Send records: one content-free file per Bot API request that left, or that Nocheh held back.

Each record says what kind of send it was, to which chat, when, and whether Telegram took it, as codes only:
never text, buttons, callback data, URLs, the token or Telegram's own wording. Storage drains spool/sends
into its chat_sends table for the owner's "Sent to apps" view. A record never decides a send, and writing
one never fails, blocks or slows it.
"""
from __future__ import annotations

import asyncio
import functools
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from services.durable import canonical, digest, immutable_file

# The dispatch key a request ran under names the kind of send it was.
KINDS = (('telegram:', 'reply'), ('action:', 'approved_send'), ('approval:', 'approval_card'), ('approval-settle:', 'card_update'),
         ('approval-answer:', 'button_answer'), ('refusal:', 'refusal'), ('notice:', 'notice'), ('notice-edit:', 'notice_update'))
# Telegram's description decides a refusal's code, first hit wins; its HTTP status is the fallback.
REJECTIONS = ((('bot was blocked',), 'bot_blocked'), (('user is deactivated',), 'user_deactivated'),
              (('bot was kicked', 'bot is not a member'), 'bot_removed'), (('chat not found',), 'chat_not_found'),
              (('thread not found', 'topic_closed', 'topic closed'), 'topic_not_found'),
              (('message to edit not found', 'message to react not found', 'message_id_invalid', 'message to be replied not found'), 'message_not_found'),
              (('message is not modified',), 'message_not_modified'), (("can't parse entities", "can't find end", 'parse'), 'formatting_rejected'),
              (('query is too old', 'query id is invalid'), 'button_answer_expired'),
              (('reaction_invalid', 'reactions are disabled', 'reaction_empty'), 'reaction_not_allowed'),
              (('not enough rights', 'have no rights', 'need administrator rights', 'chat_write_forbidden'), 'no_permission'),
              (('message is too long',), 'message_too_long'),
              (('button_data_invalid', 'button_url_invalid', 'wrong http url', 'web app'), 'button_rejected'))
STATUSES = {429: 'rate_limited', 401: 'unauthorized', 403: 'forbidden', 409: 'conflict'}
HELD = frozenset({'audience_changed', 'cancelled', 'authority_revoked', 'reaction_unbound', 'chat_action_unbound'})
# "typing…" fires every few seconds, so only a failure is recorded, once per chat and code in this window.
TYPING_QUIET = 600.0
METHOD = re.compile(r'[A-Za-z][A-Za-z0-9_.]{0,63}')
CHAT = re.compile(r'-?[0-9]{1,20}')
BIGINT = 2 ** 63


def kind_of(method, dispatch):
    if method == 'setMessageReaction': return 'reaction'
    if method == 'sendChatAction': return 'typing'
    if dispatch is None or dispatch.startswith('control:'): return 'setup'
    return next((kind for prefix, kind in KINDS if dispatch.startswith(prefix)), 'other')


def _number(value):
    """A positive id that fits Postgres bigint, or None."""
    if isinstance(value, str) and value.isascii() and value.isdigit(): value = int(value)
    return value if type(value) is int and 0 < value < BIGINT else None


def outcome(status, raw):
    """(state, error_code, message_id) of a Bot API answer, judged as the journal judges it."""
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        body = None
    if status >= 500 or 200 <= status < 300 and not isinstance(body, dict):
        return 'uncertain', 'server_error', None
    body = body if isinstance(body, dict) else {}
    if 200 <= status < 300 and body.get('ok') is True:
        result = body.get('result')
        first = result[0] if isinstance(result, list) and result else result
        return 'sent', None, _number(first.get('message_id')) if isinstance(first, dict) else None
    return 'failed', rejection_code(status, body.get('description'), body.get('error_code')), None


def rejection_code(status, description=None, reported=None):
    text = description.lower() if isinstance(description, str) else ''
    for needles, code in REJECTIONS:
        if any(needle in text for needle in needles): return code
    # A 2xx refusal carries its real status in the body.
    if not 400 <= status < 500 and type(reported) is int: status = reported
    return STATUSES.get(status, 'rejected')


def exception_code(error):
    """A request that raised instead of answering may still have arrived."""
    from telegram.error import TimedOut
    return 'timed_out' if isinstance(error, (TimedOut, TimeoutError)) else 'network_error'


def not_sent_code(held):
    """The code of a send Nocheh's own check held back, from the Held code it raised."""
    code = held.removeprefix('telegram_delivery_').removeprefix('telegram_') if isinstance(held, str) else ''
    return code if code in HELD else 'refused'


def detail_of(method, parameters):
    """A reaction's emoji, or "clear" when it is removed; nothing for any other send."""
    if method != 'setMessageReaction': return None
    reaction = parameters.get('reaction')
    if not reaction: return 'clear'
    first = reaction[0] if isinstance(reaction, list) else None
    emoji = first.get('emoji') if isinstance(first, dict) else None
    return emoji if isinstance(emoji, str) and 0 < len(emoji) <= 16 else None


def quiet(function):
    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        try: return function(*args, **kwargs)
        except Exception: return None
    return wrapper


class Sends:
    """Records a front door's sends under <spool>/sends; every call returns the record written, or None."""

    def __init__(self, root, account, channel='telegram', clock=time.monotonic):
        self.directory, self.channel, self.clock = Path(root) / 'sends', channel, clock
        self.account = str(account) if account and len(str(account)) <= 64 else None
        self.typing, self.pending = {}, set()

    @quiet
    def answered(self, method, parameters, dispatch, response, ms=None):
        state, code, message = outcome(*response)
        return self.note(method, parameters, dispatch, state, response[0], code, message, ms)

    @quiet
    def failed(self, method, parameters, dispatch, error, ms=None):
        return self.note(method, parameters, dispatch, 'uncertain', 0, exception_code(error), ms=ms)

    @quiet
    def refused(self, method, parameters, dispatch, held):
        return self.note(method, parameters, dispatch, 'not_sent', 0, not_sent_code(held))

    @quiet
    def flooded(self, chat, topic, dispatch):
        """A reply the sender's local flood window held back; in General (topic 1) it would carry no topic."""
        topic = _number(topic)
        return self.note('sendMessage', {'chat_id': chat, 'message_thread_id': None if topic == 1 else topic}, dispatch, 'not_sent', 0, 'rate_limited')

    @quiet
    def restarted(self, method, parameters, dispatch):
        """A request a restart cut off before Telegram answered. Recovery runs before the event loop, so it is written at once."""
        record = self.build(method, parameters, dispatch, 'uncertain', 0, 'restart')
        if record: self.write(record)
        return record

    @quiet
    def note(self, method, parameters, dispatch, state, status=0, code=None, message=None, ms=None):
        """Build a record and write it off the event loop."""
        record = self.build(method, parameters, dispatch, state, status, code, message, ms)
        if record: self._submit(record)
        return record

    def build(self, method, parameters, dispatch, state, status=0, code=None, message=None, ms=None):
        """The record, or None when there is nothing to record: typing that worked or was already recorded."""
        if not isinstance(method, str) or not METHOD.fullmatch(method): return None
        kind, chat = kind_of(method, dispatch), str(parameters.get('chat_id'))
        chat = chat if CHAT.fullmatch(chat) else None
        if kind == 'typing' and not self._typing_failure(chat, state, code): return None
        return {'version': 1, 'key': f'send:{self.channel}:{self.account or ""}:{uuid.uuid4().hex}', 'channel': self.channel,
                'account': self.account, 'at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                'kind': kind, 'method': method, 'chat': chat, 'topic': _number(parameters.get('message_thread_id')),
                # An edit or a reaction names the message it changes; a delivered send gets its new id from Telegram.
                'message_id': _number(parameters.get('message_id')) or message, 'detail': detail_of(method, parameters),
                'state': state, 'status': status if type(status) is int and 0 <= status < 1000 else 0,
                'error_code': None if state == 'sent' else code,
                'reference': dispatch if kind not in ('setup', 'reaction', 'typing') and isinstance(dispatch, str) and len(dispatch) <= 300 else None,
                'ms': min(86400000, max(0, ms)) if type(ms) is int else None}

    def _typing_failure(self, chat, state, code):
        if state == 'sent' or state == 'not_sent' and code == 'cancelled': return False
        now, mark = self.clock(), (chat, code)
        if now < self.typing.get(mark, now): return False
        if len(self.typing) > 256: self.typing = {key: until for key, until in self.typing.items() if until > now}
        self.typing[mark] = now + TYPING_QUIET
        return True

    def _submit(self, record):
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return self.write(record)
        task = loop.create_task(asyncio.to_thread(self.write, record))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)

    def write(self, record):
        try: immutable_file(self.directory, digest(record['key']) + '.json', canonical(record))
        except Exception: pass  # A lost record must never cost the send.

    async def settle(self):
        """Wait for the records already handed off, such as before shutdown."""
        while self.pending: await asyncio.wait(list(self.pending))
