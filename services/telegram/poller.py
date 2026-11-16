"""Long polling with durable capture: every update is fsynced before the offset that confirms it is sent."""
from __future__ import annotations

import asyncio
import os

from .capture import clear_command_menu
from .sender import seconds

POLL_TIMEOUT = 25
# Every kind of update Nocheh reads, asked for by name (capture.py archives each under its chat): messages and channel
# posts and their edits, button presses, reactions, the bot's own membership and other people's, and join requests.
# Inline queries, business messages, payments, polls and boosts are never asked for, so Telegram never sends them. Each
# must be one of the Telegram library's own types, so a dropped one fails startup instead of silently losing updates.
ALLOWED_UPDATES = ('message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'message_reaction',
                   'message_reaction_count', 'my_chat_member', 'chat_member', 'chat_join_request')
# What getMe says the bot may do, as BotFather set it, shown in health. Nocheh uses neither inline queries nor business
# connections and stays only in groups the owner adds it to (ADR-0253); a bot that allows more still starts.
ABILITIES = ('can_join_groups', 'can_read_all_group_messages', 'supports_inline_queries', 'can_connect_to_business')
CONFLICT_RETRIES = 5
NETWORK_FAILURES = 10


def requests(capture):
    """The general and the polling request of the bot, both through the capture boundary."""
    import httpx
    from telegram.request import HTTPXRequest
    from .capture import instrument_request
    settings = {'connection_pool_size': 64, 'pool_timeout': 8.0, 'connect_timeout': 10.0, 'read_timeout': 20.0,
                'write_timeout': 20.0, 'media_write_timeout': 60.0, 'proxy': os.environ.get('TELEGRAM_PROXY') or None}
    general = HTTPXRequest(**settings)
    # A long poll never gets a pooled socket from an earlier poll, which the server may have closed meanwhile.
    updates = HTTPXRequest(**settings, httpx_kwargs={'limits': httpx.Limits(max_connections=64, max_keepalive_connections=0)})
    return instrument_request(general, capture), instrument_request(updates, capture, polling=True)


class Poller:
    """Fetches updates until stopped or a fatal error. Error ladder:
    a wrong token stops at once; another poller (409) is retried five times, then stops;
    network failures back off and reconnect, and ten in a row hand over to a process restart."""
    def __init__(self, service, sleep=asyncio.sleep):
        self.service, self.sleep = service, sleep
        self.offset, self.menu = None, None

    async def connect(self):
        service = self.service
        bot = service.bot
        await bot.initialize()
        me = await bot.get_me()
        # Polling is the only way updates arrive, so a webhook left by another setup would starve it.
        await bot.delete_webhook(drop_pending_updates=False)
        service.identity = {'bot_id': str(me.id), 'username': me.username, 'first_name': me.first_name}
        service.abilities = {key: value for key in ABILITIES if isinstance(value := getattr(me, key, None), bool)}
        service.status = 'connected'
        if self.menu is None or self.menu.done():
            # Every Telegram id a served group has had, from the app's served list (ADR-0252).
            groups = (await asyncio.to_thread(service.policy.current)).served_externals()
            self.menu = asyncio.ensure_future(clear_command_menu(bot, groups))

    async def run(self):
        from telegram import Update
        from telegram.error import Conflict, InvalidToken, RetryAfter
        if not set(ALLOWED_UPDATES).issubset(Update.ALL_TYPES):
            raise RuntimeError('telegram_library_lacks_update_types')
        service = self.service
        connected, failures, conflicts = False, 0, 0
        while not service.stopping:
            try:
                if not connected:
                    await self.connect()
                    connected = True
                updates = await service.bot.get_updates(offset=self.offset, timeout=POLL_TIMEOUT, limit=100, allowed_updates=list(ALLOWED_UPDATES))
                failures = conflicts = 0
                if updates:
                    self.offset = updates[-1].update_id + 1
            except asyncio.CancelledError:
                raise
            except InvalidToken:
                return service.fatal('invalid_token', retryable=False)
            except Conflict:
                conflicts += 1
                if conflicts > CONFLICT_RETRIES:
                    return service.fatal('telegram_polling_conflict', retryable=False)
                await self.sleep(min(60, 10 + 10 * conflicts))
            except RetryAfter as error:
                await self.sleep(min(300.0, seconds(error.retry_after)))
            except Exception:
                failures += 1
                connected = False
                if service.status == 'connected':
                    service.status = 'recovering'
                if failures >= NETWORK_FAILURES:
                    return service.fatal('telegram_network_error', retryable=True)
                await self.sleep(min(60, 5 * 2 ** (failures - 1)))
