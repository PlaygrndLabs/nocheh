"""Read chat IDs through the native Bot API, fsync updates, send no messages."""

from integrations.hermes.environment import secret as environment_secret
import asyncio
import json
import os
import urllib.request
from pathlib import Path
from .capture import Capture,instrument_request


async def main():
    from telegram import Bot
    from telegram.request import HTTPXRequest
    with urllib.request.urlopen('http://127.0.0.1:8781/health',timeout=5) as response:status=json.load(response)
    if status.get('telegram') not in ('disabled','credentials_missing'):
        raise SystemExit('Stop assistant polling before discovering IDs; do not run two pollers.')
    token=environment_secret('TELEGRAM_BOT_TOKEN',required=False)
    if not token:raise SystemExit('Set TELEGRAM_BOT_TOKEN in .env first.')
    capture=Capture(Path(os.environ.get('NOCHEH_SPOOL_DIR','/data/spool')),token.split(':',1)[0])
    request=instrument_request(HTTPXRequest(),capture,polling=True)
    async with Bot(token,get_updates_request=request) as bot:
        me=await bot.get_me()
        updates=await bot.get_updates(timeout=5) # No offset: do not acknowledge the pending queue.
        rows={}
        for update in updates:
            msg=update.effective_message
            if msg:rows[str(msg.chat.id)]={'chat_id':str(msg.chat.id),'chat_type':msg.chat.type,'sender_id':str(msg.from_user.id) if msg.from_user else None}
        print(json.dumps({'bot_username':me.username,'chats':list(rows.values()),'updates_fsynced':len(updates),'messages_sent':0},indent=2))


if __name__=='__main__':asyncio.run(main())
