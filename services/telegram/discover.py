"""Read chat IDs through the Bot API, fsync updates, send no messages."""

import asyncio
import json
import urllib.request

from . import settings
from .capture import Capture, instrument_request


async def main():
    from telegram import Bot
    from telegram.request import HTTPXRequest
    with urllib.request.urlopen('http://127.0.0.1:8784/health', timeout=5) as response: status = json.load(response)
    if status.get('telegram') not in ('disabled', 'credentials_missing'):
        raise SystemExit('Stop assistant polling before discovering IDs; do not run two pollers.')
    token = settings.secret('TELEGRAM_BOT_TOKEN', required=False)
    if not token: raise SystemExit('Set TELEGRAM_BOT_TOKEN in .env first.')
    # Discovery sends nothing, so it never settles the service's own unfinished sends.
    capture = Capture(settings.spool(), token.split(':', 1)[0], recover=False)
    request = instrument_request(HTTPXRequest(), capture, polling=True)
    async with Bot(token, get_updates_request=request) as bot:
        me = await bot.get_me()
        updates = await bot.get_updates(timeout=5)  # No offset: do not acknowledge the pending queue.
        rows = {}
        for update in updates:
            msg = update.effective_message
            if msg:
                sender = msg.from_user if msg.from_user and not msg.from_user.is_bot else None
                rows[str(msg.chat.id)] = {'chat_id': str(msg.chat.id), 'chat_type': msg.chat.type, 'sender_id': str(sender.id) if sender else None,
                    # Names let the dashboard ask "is this you?"; the numeric ID stays the authority.
                    'sender_name': sender.full_name if sender else None, 'sender_username': sender.username if sender else None}
        print(json.dumps({'bot_username': me.username, 'chats': list(rows.values()), 'updates_fsynced': len(updates), 'messages_sent': 0}, indent=2))


if __name__ == '__main__': asyncio.run(main())
