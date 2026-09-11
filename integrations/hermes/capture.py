"""Fsync before PTB sees updates; journal writes before any outbound request."""
from __future__ import annotations

import asyncio
import base64
import contextvars
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

DISPATCH_KEY = contextvars.ContextVar('nocheh_dispatch_key', default=None)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable_file(directory: Path, name: str, data: bytes):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = directory / name
    temporary = directory / ('.' + uuid.uuid4().hex + '.tmp')
    created = True
    try:
        with temporary.open('xb') as file:
            os.chmod(temporary, 0o600)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            created = False
            if target.read_bytes() != data:
                raise RuntimeError('immutable_capture_conflict') from None
        sync_directory(directory)
        return created
    finally:
        temporary.unlink(missing_ok=True)


class Capture:
    def __init__(self, root: Path, bot_id: str):
        self.root, self.bot_id = root, bot_id
        self.polling = {'last_poll_at': None, 'last_update_at': None, 'error_code': None}
        self.recover()

    def recover(self):
        # On boot, a durable intent without a durable result is ambiguous. Never
        # infer non-delivery from the absence of a response after a process crash.
        for intent in (self.root / 'outbound').glob('*.intent'):
            event = json.loads(intent.read_bytes())
            if event['bot_id'] != self.bot_id:
                continue
            self.enqueue(event)
            key = event['key'].removesuffix(':intent')
            result = intent.with_suffix('.result')
            if not result.exists():
                self.complete(key, event['payload']['method'], event['payload']['parameters'], None)
            else:
                self.enqueue(json.loads(result.read_bytes())['event'])

    def enqueue(self, value):
        immutable_file(self.root / 'pending', digest(value['key']) + '.json', canonical(value))

    def event(self, key, kind, payload, scope='system', text=None, source_id=None, revision='0'):
        return {'version': 1, 'key': key, 'origin': 'generated', 'bot_id': self.bot_id,
                'kind': kind, 'scope': str(scope), 'source_id': source_id or key,
                'revision': str(revision), 'occurred_at': None, 'text': text, 'payload': payload}

    def updates(self, result):
        status, raw = result
        if status != 200:
            return
        decoded = json.loads(raw)
        if not decoded.get('ok'):
            return
        if decoded.get('result'):
            batch = self.event(f'telegram:{self.bot_id}:wire:{digest(raw)}', 'telegram_wire',
                               {'update_ids': [u['update_id'] for u in decoded['result']]})
            batch['wire_base64'] = base64.b64encode(raw).decode()
            self.enqueue(batch)
        for update in decoded.get('result', []):
            key = f"telegram:{self.bot_id}:update:{update['update_id']}"
            message = next((update[k] for k in ('message','edited_message','channel_post','edited_channel_post') if k in update), {})
            other = update.get('callback_query', {}).get('message', {}) or update.get('message_reaction', {}) or update.get('message_reaction_count', {}) or update.get('my_chat_member', {}) or update.get('chat_member', {}) or update.get('chat_join_request', {})
            source = message or other
            value = self.event(key, 'telegram_update', update, source.get('chat', {}).get('id', 'system'),
                               message.get('text', message.get('caption')), str(source.get('message_id', update['update_id'])), update['update_id'])
            value.update(origin='live', occurred_at=str(message.get('edit_date', message.get('date'))) if message.get('date') else None)
            self.enqueue(value)

    def outbound(self, method, parameters, dispatch_key):
        key = f"outbound:{self.bot_id}:{dispatch_key}:{method}:{digest(canonical(parameters))}"
        journal = self.root / 'outbound'
        intent = journal / (digest(key) + '.intent')
        result = journal / (digest(key) + '.result')
        if result.exists():
            saved = json.loads(result.read_bytes())
            self.enqueue(saved['event'])
            if saved['state'] == 'ambiguous':
                raise RuntimeError('outbound_delivery_ambiguous')
            return key, (saved['status'], base64.b64decode(saved['wire']))
        if intent.exists():
            self.enqueue(json.loads(intent.read_bytes()))
            self.complete(key, method, parameters, None)
            raise RuntimeError('outbound_delivery_ambiguous')
        event = self.event(key + ':intent', 'outbound_intent', {'method': method, 'parameters': parameters, 'state': 'attempting'}, parameters.get('chat_id', 'system'), parameters.get('text'))
        if not immutable_file(journal, intent.name, canonical(event)):
            raise RuntimeError('outbound_delivery_ambiguous')
        self.enqueue(event)
        return key, None

    def complete(self, key, method, parameters, response):
        status, raw = response if response else (0, b'')
        state = 'ambiguous' if not response or status >= 500 else 'delivered' if 200 <= status < 300 else 'rejected'
        if state == 'delivered':
            try:
                state = 'delivered' if json.loads(raw).get('ok') is True else 'rejected'
            except (ValueError, AttributeError):
                state = 'ambiguous'
        event = self.event(key + ':result', 'outbound_result', {'intent_key': key + ':intent', 'method': method,
                           'state': state, 'status': status, 'wire_base64': base64.b64encode(raw).decode()}, parameters.get('chat_id', 'system'))
        saved = {'state':state, 'status':status, 'wire':base64.b64encode(raw).decode(), 'event':event}
        immutable_file(self.root / 'outbound', digest(key) + '.result', canonical(saved))
        self.enqueue(event)


def instrument_request(request, capture: Capture, polling=False):
    class CapturedRequest(type(request)):
        __slots__ = ()

        async def do_request(self, *args, **kwargs):
            url = kwargs.get('url', args[0] if args else '')
            method = urlsplit(url).path.rsplit('/', 1)[-1]
            if polling:
                try:
                    result = await super().do_request(*args, **kwargs)
                    if method == 'getUpdates':
                        await asyncio.to_thread(capture.updates, result)
                        status, raw = result
                        if status == 200 and json.loads(raw).get('ok'):
                            now = datetime.now(timezone.utc).isoformat()
                            capture.polling.update(last_poll_at=now, error_code=None)
                            if json.loads(raw).get('result'):
                                capture.polling['last_update_at'] = now
                        else:
                            capture.polling['error_code'] = {401:'telegram_unauthorized',409:'telegram_polling_conflict',429:'telegram_rate_limited'}.get(status,'telegram_poll_failed')
                except Exception:
                    capture.polling['error_code'] = 'telegram_poll_or_capture_failed'
                    raise
                return result
            if method.startswith('get') or '/file/bot' in url:
                return await super().do_request(*args, **kwargs)
            data = kwargs.get('request_data')
            parameters = data.parameters if data else {}
            # Parent context is inherited by PTB's background reply tasks.
            dispatch = DISPATCH_KEY.get() or 'control:' + uuid.uuid4().hex
            key, saved = await asyncio.to_thread(capture.outbound, method, parameters, dispatch)
            if saved is not None:
                return saved
            try:
                result = await super().do_request(*args, **kwargs)
            except BaseException:
                await asyncio.shield(asyncio.to_thread(capture.complete, key, method, parameters, None))
                raise
            await asyncio.to_thread(capture.complete, key, method, parameters, result)
            return result

    request.__class__ = CapturedRequest
    return request


def captured_adapter_class():
    from plugins.platforms.telegram.adapter import TelegramAdapter
    from telegram import Update
    from telegram.ext import ApplicationHandlerStop, TypeHandler

    class ArchivedTelegramAdapter(TelegramAdapter):
        def __init__(self, config):
            super().__init__(config)
            self.capture = Capture(Path(os.environ.get('NOCHEH_SPOOL_DIR', '/data/spool')), config.token.split(':',1)[0])

        def _instrument_polling_request(self, request):
            return instrument_request(super()._instrument_polling_request(request), self.capture, polling=True)

        async def _start_polling_resilient(self, **kwargs):
            kwargs['drop_pending_updates'] = False
            return await super()._start_polling_resilient(**kwargs)

        async def _start_polling_once(self, app, **kwargs):
            # Native reconnect recovery also calls this method directly.
            kwargs['drop_pending_updates'] = False
            return await super()._start_polling_once(app, **kwargs)

        async def _start_webhook_mode(self, *args, **kwargs):
            raise RuntimeError('Nocheh durable capture currently requires native long polling')

        async def _build_ptb_requests(self):
            request, updates = await super()._build_ptb_requests()
            return instrument_request(request, self.capture), updates

        def _register_handlers(self, app):
            async def committed_only(update, context):
                # Polling only captures. The archive worker explicitly dispatches
                # committed live events; replay/import never enters this path.
                expected = f"telegram:{self.capture.bot_id}:update:{update.update_id}"
                if DISPATCH_KEY.get() != expected:
                    raise ApplicationHandlerStop
            app.add_handler(TypeHandler(Update, committed_only), group=-100)
            super()._register_handlers(app)

    return ArchivedTelegramAdapter
