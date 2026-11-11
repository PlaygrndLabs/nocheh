"""Authenticated HTTP service around the Telegram front door. Only Nocheh's core calls it."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hmac
import json
import logging
import os
import re
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import retention, settings
from .gateway import TelegramService

SERVICE = None
TOKEN = ''
# The Bot API serves files up to 20 MB; a larger one can never be read, so its retrieval settles.
FILE_LIMIT = 50 * 1024 * 1024


class AttachmentTooLarge(Exception):
    pass


class Unavailable(Exception):
    pass


def bot():
    """A one-off bot for reading a file or a chat: no journal, no poll, so it works with polling off."""
    from telegram import Bot
    from telegram.request import HTTPXRequest
    token = settings.secret('TELEGRAM_BOT_TOKEN', required=False)
    if not token: raise Unavailable('telegram_not_configured')
    return Bot(token, request=HTTPXRequest(proxy=os.environ.get('TELEGRAM_PROXY') or None))


def read_file(body):
    ref = body['file_id']
    if not isinstance(ref, str) or not ref or len(ref) > 1024: raise ValueError('invalid_file_id')
    async def download():
        from telegram.error import BadRequest
        async with bot() as client:
            try:
                file = await client.get_file(ref)
            except BadRequest as error:
                # The Bot API refuses files over 20 MB; retrying never helps.
                if 'too big' in str(error).lower(): raise AttachmentTooLarge() from error
                raise
            if file.file_size and file.file_size > FILE_LIMIT: raise AttachmentTooLarge()
            return await file.download_as_bytearray()
    raw = asyncio.run(download())
    if len(raw) > FILE_LIMIT: raise AttachmentTooLarge()
    return {'bytes_base64': base64.b64encode(raw).decode()}


def read_chat(body):
    """Owner-requested presentation refresh: getChat only, never a send or a poll."""
    from telegram.error import BadRequest, ChatMigrated, Forbidden
    chat_id = body.get('chat_id')
    if not isinstance(chat_id, str) or not re.fullmatch(r'-?[1-9][0-9]{0,18}', chat_id): raise ValueError('invalid_chat_id')
    async def lookup():
        async with bot() as client:
            try:
                found = await client.get_chat(int(chat_id))
            except ChatMigrated as error:
                return {'chat_id': chat_id, 'state': 'migrated', 'migrate_to_chat_id': str(error.new_chat_id)}
            except Forbidden:
                return {'chat_id': chat_id, 'state': 'not_member'}
            except BadRequest:
                return {'chat_id': chat_id, 'state': 'not_found'}
            return {'chat_id': str(found.id), 'state': 'available', 'type': found.type, 'title': found.title,
                    'username': found.username, 'is_forum': bool(getattr(found, 'is_forum', False))}
    return asyncio.run(lookup())


ROUTES = {
    '/internal/telegram/identity': lambda body: SERVICE.identify(body),
    '/internal/telegram/presence': lambda body: SERVICE.presence(body),
    '/internal/telegram/reply': lambda body: SERVICE.reply(body),
    '/internal/telegram/action': lambda body: SERVICE.action(body),
    '/internal/telegram/approval': lambda body: SERVICE.approval(body),
    '/internal/telegram/refusal': lambda body: SERVICE.refusal(body),
    '/internal/telegram/notice': lambda body: SERVICE.notice(body),
    '/internal/telegram/chat': read_chat,
    '/internal/telegram/file': read_file,
}


def health():
    details = SERVICE.health() if SERVICE else {}
    return {'ok': True, 'service': 'telegram', 'telegram': details.get('state', 'not_started'), 'telegram_details': details}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != '/health': return self.reply(404, {'error': 'not_found'})
        return self.reply(200, health())

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + TOKEN).encode()):
            return self.reply(401, {'error': 'unauthorized'})
        route = ROUTES.get(self.path)
        if route is None: return self.reply(404, {'error': 'not_found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4 * 1024 * 1024: return self.reply(413, {'error': 'invalid_body_size'})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict): return self.reply(400, {'error': 'expected_object'})
            if SERVICE is None and self.path not in ('/internal/telegram/chat', '/internal/telegram/file'): raise Unavailable()
            self.reply(200, route(body))
        except AttachmentTooLarge:
            self.reply(413, {'error': 'attachment_too_large'})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'invalid_request'})
        except Unavailable:
            self.reply(503, {'error': 'telegram_unavailable'})
        except Exception as error:
            status = getattr(error, 'status_code', None)
            self.reply(429 if status == 429 else 503, {'error': 'quota_paused' if status == 429 else 'telegram_unavailable',
                                                       'error_type': type(error).__name__})


def main():
    global SERVICE, TOKEN
    TOKEN = settings.secret('SERVICE_TOKEN')
    if len(TOKEN) < 24: raise SystemExit('Service token is missing or too short')
    # The Telegram library logs request addresses, which carry the bot token.
    logging.disable(logging.CRITICAL)
    policy, bot_token = settings.Policy.load(), settings.secret('TELEGRAM_BOT_TOKEN', required=False)
    spool, days = settings.spool(), retention.retention_days()
    # Finished delivery journals expire before the boot rescans read them.
    retention.prune(spool, days)
    pruning = threading.Event()
    retention.start(spool, days, pruning)
    server = ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8784'))), Handler)
    restarting = threading.Event()
    def restart_after_failure():
        if restarting.is_set(): return
        restarting.set()
        # Let diagnostics observe the failure, then exit the whole process so no
        # orphaned getUpdates request competes with the replacement.
        timer = threading.Timer(15, server.shutdown)
        timer.daemon = True
        timer.start()
    SERVICE = TelegramService(policy, bot_token, spool, settings.state(), restart_after_failure)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({'event': 'ready', 'service': 'telegram'}), flush=True)
    # One process-wide redirect, installed before starting threads, so no output can carry the token.
    with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        SERVICE.start()
        try:
            server.serve_forever()
        finally:
            pruning.set()
            SERVICE.stop()
    if restarting.is_set(): raise SystemExit(1)


if __name__ == '__main__':
    main()
