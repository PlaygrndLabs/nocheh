"""Long polling with durable capture: every update is fsynced before the offset that confirms it is sent."""
from __future__ import annotations

import asyncio
import os

from .capture import clear_command_menu
from .sender import seconds

POLL_TIMEOUT = 25
# The Telegram library's own types, so a dropped reaction type fails startup instead of silently losing reactions.
REQUIRED_UPDATES = {'message_reaction', 'message_reaction_count'}
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
        service.status = 'connected'
        if self.menu is None or self.menu.done():
            self.menu = asyncio.ensure_future(clear_command_menu(bot, service.policy.groups))

    async def run(self):
        from telegram import Update
        from telegram.error import Conflict, InvalidToken, RetryAfter
        if not REQUIRED_UPDATES.issubset(Update.ALL_TYPES):
            raise RuntimeError('telegram_library_lacks_reaction_updates')
        service = self.service
        connected, failures, conflicts = False, 0, 0
        while not service.stopping:
            try:
                if not connected:
                    await self.connect()
                    connected = True
                updates = await service.bot.get_updates(offset=self.offset, timeout=POLL_TIMEOUT, limit=100, allowed_updates=Update.ALL_TYPES)
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
