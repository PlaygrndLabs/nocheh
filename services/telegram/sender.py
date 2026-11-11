"""Sends a reply's text the way the pinned Hermes adapter did, so replies look the same in Telegram.

MarkdownV2 chunks of at most 4096 UTF-16 units, a plain-text resend when Telegram refuses the
formatting, only the first chunk answering the message, silent unless asked to notify, and one
send at a time per chat with a 1 s pause between sends. Every request still passes the capture
boundary, so it is checked and journaled.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
from datetime import timedelta

from . import formatting
from .capture import held
from .checks import no_preview

# Telegram counts a message's length in UTF-16 code units.
MESSAGE_LIMIT = 4096
# A short flood wait is slept inline; a longer one fails closed instead of holding the send open.
FLOOD_INLINE_WAIT = 5.0
# One send per chat per second, the pace Telegram allows a chat.
CHAT_PACE = 1.0
# A text request that has not answered by then is treated as possibly sent.
SEND_DEADLINE = 30.0
TYPING_COOLDOWN = 30.0


def seconds(value):
    return value.total_seconds() if isinstance(value, timedelta) else float(value)


def _chain(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__ or error.__context__


def connect_timeout(error):
    """The request never connected, so sending it again cannot duplicate it."""
    return any('connecttimeout' in type(e).__name__.lower() or any(m in str(e).lower() for m in ('connect timeout', 'connect timed out'))
               for e in _chain(error))


def pool_timeout(error):
    """No connection was free, so the request was never sent."""
    return any('pooltimeout' in type(e).__name__.lower() or 'pool timeout' in str(e).lower() or
               ('connection pool' in str(e).lower() and 'occupied' in str(e).lower()) for e in _chain(error))


def transient(error):
    """A typing failure worth pausing that chat's typing for."""
    if getattr(error, 'retry_after', None) is not None: return True
    text = str(error).lower()
    return (any(m in text for m in ('too many requests', 'rate limit', 'timed out', 'timeout', 'temporar')) or
            isinstance(error, (OSError, TimeoutError, ConnectionError)))


class Sender:
    def __init__(self, bot, limit=MESSAGE_LIMIT, pace=CHAT_PACE):
        self.bot, self.limit, self.pace = bot, limit, pace
        self.locks, self.slots, self.floods, self.typing_pause = {}, {}, {}, {}

    @contextlib.asynccontextmanager
    async def chat(self, chat_id):
        """One send at a time per chat, so two replies to one chat never interleave their chunks."""
        key = str(chat_id)
        lock = self.locks.setdefault(key, asyncio.Lock())
        async with lock:
            try:
                yield
            finally:
                if not getattr(lock, '_waiters', None):
                    self.locks.pop(key, None)

    def _remaining(self, table, chat_id):
        until = table.get(str(chat_id))
        if until is None: return 0.0
        left = until - asyncio.get_running_loop().time()
        if left <= 0: table.pop(str(chat_id), None)
        return max(0.0, left)

    def _flooded(self, chat_id, wait):
        # A refused send arms a window in which this chat's sends fail closed locally,
        # instead of hammering a penalty Telegram lengthens while it is hammered.
        self.floods[str(chat_id)] = asyncio.get_running_loop().time() + max(1.0, min(wait, 300.0))
        return False

    async def send(self, chat_id, text, reply_to=None, topic=None, notify=False):
        """Send ``text`` as one reply. True when every chunk was delivered; False otherwise.

        Errors are not raised: the bound check's request record tells the caller what reached Telegram."""
        if not text or not text.strip():
            return True
        async with self.chat(chat_id):
            if self._remaining(self.floods, chat_id):
                return False
            wait = self._remaining(self.slots, chat_id)
            if wait: await asyncio.sleep(wait)
            self.slots[str(chat_id)] = asyncio.get_running_loop().time() + self.pace
            try:
                chunks = formatting.truncate_message(formatting.format_message(text), self.limit, len_fn=formatting.utf16_len)
                if len(chunks) > 1:
                    # The chunk counter " (1/2)" needs its parentheses escaped for MarkdownV2.
                    chunks = [formatting._separate_chunk_indicator_from_fence(re.sub(r' \((\d+)/(\d+)\)$', r' \\(\1/\2\\)', chunk))
                              for chunk in chunks]
                for index, chunk in enumerate(chunks):
                    if not await self._chunk(chat_id, chunk, reply_to if index == 0 else None, topic, notify):
                        return False
                return True
            except Exception:
                return False

    async def _markdown_or_plain(self, chunk, parameters):
        from telegram.constants import ParseMode
        try:
            return await asyncio.wait_for(self.bot.send_message(text=chunk, parse_mode=ParseMode.MARKDOWN_V2, link_preview_options=no_preview(), **parameters), SEND_DEADLINE)
        except Exception as error:
            if not held(error) and ('parse' in str(error).lower() or 'markdown' in str(error).lower()):
                return await asyncio.wait_for(self.bot.send_message(text=formatting._strip_mdv2(chunk), parse_mode=None, link_preview_options=no_preview(), **parameters), SEND_DEADLINE)
            raise

    async def _chunk(self, chat_id, chunk, reply_to, topic, notify):
        from telegram.error import BadRequest, NetworkError, TimedOut
        # Telegram refuses message_thread_id 1, the forum's General topic, on a send.
        thread = None if not topic or int(topic) == 1 else int(topic)
        retried_thread = False
        for attempt in range(3):
            parameters = {'chat_id': int(chat_id), 'reply_to_message_id': int(reply_to) if reply_to else None,
                          'message_thread_id': thread, **({} if notify else {'disable_notification': True})}
            try:
                await self._markdown_or_plain(chunk, parameters)
                return True
            except NetworkError as error:
                if held(error):
                    raise
                if isinstance(error, BadRequest):
                    text = str(error).lower()
                    # A one-off "thread not found" recovers on an immediate retry. The reply never
                    # leaves its topic, so a topic that is really gone ends the send.
                    if 'thread not found' in text and thread is not None and not retried_thread:
                        retried_thread = True
                        continue
                    if 'message to be replied not found' in text and reply_to:
                        reply_to = None  # The message it answers was deleted; the reply still goes to its chat and topic.
                        continue
                    raise
                # A plain timeout may have reached Telegram, so it is never sent again.
                if isinstance(error, TimedOut) and not connect_timeout(error) and not pool_timeout(error):
                    raise
                if attempt >= 2:
                    raise
                await asyncio.sleep(2 ** attempt)
            except Exception as error:
                retry_after = getattr(error, 'retry_after', None)
                if retry_after is None and 'retry after' not in str(error).lower():
                    raise
                wait = seconds(retry_after) if retry_after is not None else 1.0
                if wait > FLOOD_INLINE_WAIT or attempt >= 2:
                    return self._flooded(chat_id, wait)
                await asyncio.sleep(wait)
        return False

    async def typing(self, chat_id, topic=None):
        """Show "typing…" in a chat, or a forum topic including General. A failure is cosmetic and never raised."""
        if self._remaining(self.typing_pause, chat_id):
            return
        try:
            await self.bot.send_chat_action(chat_id=int(chat_id), action='typing', message_thread_id=int(topic) if topic else None)
        except Exception as error:
            if transient(error):
                retry_after = getattr(error, 'retry_after', None)
                self.typing_pause[str(chat_id)] = asyncio.get_running_loop().time() + max(1.0, min(seconds(retry_after) if retry_after is not None else TYPING_COOLDOWN, 300.0))
