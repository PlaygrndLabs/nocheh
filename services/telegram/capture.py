"""Fsync before PTB sees updates; journal writes before any outbound request but a chat action or working reaction.
Every request that leaves, or that a check holds back, reactions included, also leaves a content-free send record (sends.py)."""
from __future__ import annotations

import asyncio
import base64
import contextvars
import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from urllib.parse import urlsplit

from services.durable import canonical, digest, immutable_file
from .sends import Sends

DISPATCH_KEY = contextvars.ContextVar('nocheh_dispatch_key', default=None)
OUTBOUND_CHECK = contextvars.ContextVar('nocheh_outbound_check', default=None)


class Held(RuntimeError):
    """A request this boundary did not let out, or whose outcome is already settled.

    PTB wraps it in a NetworkError; the sender recognises it and never retries it,
    since another try meets the same answer."""


def held(error):
    """Whether a send error, or anything it wraps, is one of this boundary's refusals."""
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, Held): return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


class Capture:
    def __init__(self, root: Path, bot_id: str, recover=True):
        self.root, self.bot_id = root, bot_id
        self.polling = {'last_poll_at': None, 'last_update_at': None, 'error_code': None}
        self.sends = Sends(root, bot_id)
        # Only the service that sends recovers; discovery sends nothing and must not stamp the
        # service's in-flight sends as ambiguous.
        if recover: self.recover()

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
                method, parameters = event['payload']['method'], event['payload']['parameters']
                self.complete(key, method, parameters, None)
                self.sends.restarted(method, parameters, self.dispatch_of(key, method, parameters))
            else:
                self.enqueue(json.loads(result.read_bytes())['event'])

    def enqueue(self, value):
        immutable_file(self.root / 'pending', digest(value['key']) + '.json', canonical(value))

    def dispatch_of(self, key, method, parameters):
        """The dispatch key a journal key was made from (see outbound), or None."""
        head, tail = f'outbound:{self.bot_id}:', f':{method}:{digest(canonical(parameters))}'
        base = re.sub(r':rate-retry:\d+$', '', key)
        return base[len(head):-len(tail)] if base.startswith(head) and base.endswith(tail) else None

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
            batch['origin'] = 'live'
            self.enqueue(batch)
        for update in decoded.get('result', []):
            key = f"telegram:{self.bot_id}:update:{update['update_id']}"
            message = next((update[k] for k in ('message','edited_message','channel_post','edited_channel_post') if k in update), {})
            other = update.get('callback_query', {}).get('message', {}) or update.get('message_reaction', {}) or update.get('message_reaction_count', {}) or update.get('my_chat_member', {}) or update.get('chat_member', {}) or update.get('chat_join_request', {})
            source = message or other
            value = self.event(key, 'telegram_update', update, source.get('chat', {}).get('id', 'system'),
                               message.get('text', message.get('caption')), str(source.get('message_id', update['update_id'])), update['update_id'])
            source_date = source.get('edit_date', source.get('date'))
            value.update(origin='live', occurred_at=str(source_date) if source_date is not None else None)
            self.enqueue(value)

    def outbound(self, method, parameters, dispatch_key):
        base = f"outbound:{self.bot_id}:{dispatch_key}:{method}:{digest(canonical(parameters))}"
        journal = self.root / 'outbound'
        # A documented 429 is an explicit rejection, not an uncertain send.
        # Retain every attempt and honor its wait; the sender bounds its
        # own retries to three. All other results retain their existing behavior.
        for attempt in range(3):
            key = base if attempt == 0 else base + ':rate-retry:' + str(attempt)
            intent = journal / (digest(key) + '.intent')
            result = journal / (digest(key) + '.result')
            if not result.exists():
                break
            saved = json.loads(result.read_bytes())
            self.enqueue(saved['event'])
            if saved['state'] == 'ambiguous':
                raise Held('outbound_delivery_ambiguous')
            if attempt < 2 and self.rate_limit_elapsed(saved, result):
                continue
            return key, (saved['status'], base64.b64decode(saved['wire']))
        if intent.exists():
            self.enqueue(json.loads(intent.read_bytes()))
            self.complete(key, method, parameters, None)
            raise Held('outbound_delivery_ambiguous')
        event = self.event(key + ':intent', 'outbound_intent', {'method': method, 'parameters': parameters, 'state': 'attempting'}, parameters.get('chat_id', 'system'), parameters.get('text'))
        if not immutable_file(journal, intent.name, canonical(event)):
            raise Held('outbound_delivery_ambiguous')
        self.enqueue(event)
        return key, None

    @staticmethod
    def rate_limit_elapsed(saved, path):
        if saved['state'] != 'rejected' or saved['status'] != 429:
            return False
        try:
            response = json.loads(base64.b64decode(saved['wire']))
            delay = response['parameters']['retry_after']
            return (response.get('ok') is False and response.get('error_code') == 429 and
                    type(delay) is int and delay >= 0 and time.time() >= path.stat().st_mtime + delay)
        except (ValueError, TypeError, KeyError, AttributeError):
            return False

    @staticmethod
    def outcome(response):
        """Classify a Bot API response: delivered, a definite rejection, or ambiguous."""
        status, raw = response if response else (0, b'')
        state = 'ambiguous' if not response or status >= 500 else 'delivered' if 200 <= status < 300 else 'rejected'
        if state == 'delivered':
            try:
                state = 'delivered' if json.loads(raw).get('ok') is True else 'rejected'
            except (ValueError, AttributeError):
                state = 'ambiguous'
        return state

    def complete(self, key, method, parameters, response):
        status, raw = response if response else (0, b'')
        state = self.outcome(response)
        event = self.event(key + ':result', 'outbound_result', {'intent_key': key + ':intent', 'method': method,
                           'state': state, 'status': status, 'wire_base64': base64.b64encode(raw).decode()}, parameters.get('chat_id', 'system'))
        saved = {'state':state, 'status':status, 'wire':base64.b64encode(raw).decode(), 'event':event}
        immutable_file(self.root / 'outbound', digest(key) + '.result', canonical(saved))
        self.enqueue(event)
        return state


def parseable_updates(result, polling):
    """Keep one update the Telegram library cannot parse from wedging polling.

    The library rejects a whole getUpdates batch when any update fails to parse,
    and the same offset would be fetched forever. Each original is already durably
    captured, so an unparseable update is passed on as its bare update_id: the
    offset advances, nothing reads it, and the count stays visible in health.
    """
    status, raw = result
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        return result
    if status != 200 or body.get('ok') is not True or not isinstance(body.get('result'), list):
        return result
    from telegram import Update
    replaced = 0
    for index, item in enumerate(body['result']):
        try:
            Update.de_json(item, None)
        except Exception:
            if not isinstance(item, dict) or type(item.get('update_id')) is not int:
                return result
            body['result'][index] = {'update_id': item['update_id']}
            replaced += 1
    if not replaced:
        return result
    polling['unparseable_updates'] = polling.get('unparseable_updates', 0) + replaced
    polling['last_unparseable_at'] = datetime.now(timezone.utc).isoformat()
    return status, json.dumps(body).encode()


def elapsed(started):
    return round((perf_counter() - started) * 1000)


def instrument_request(request, capture: Capture, polling=False):
    class CapturedRequest(type(request)):
        __slots__ = ()

        async def do_request(self, *args, **kwargs):
            url = kwargs.get('url', args[0] if args else '')
            method = urlsplit(url).path.rsplit('/', 1)[-1]
            if polling:
                try:
                    started=perf_counter()
                    result = await super().do_request(*args, **kwargs)
                    if method == 'getUpdates':
                        capture.polling['network_ms']=round((perf_counter()-started)*1000)
                        captured=perf_counter()
                        await asyncio.to_thread(capture.updates, result)
                        capture.polling['capture_ms']=round((perf_counter()-captured)*1000)
                        result = parseable_updates(result, capture.polling)
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
            # Formatting, chunks and retries may change routing. Check
            # the actual request before journaling or transmission each time.
            check = OUTBOUND_CHECK.get()
            # Send records are written off the event loop; one never fails or delays its request.
            sends = capture.sends
            if method in ('sendChatAction', 'setMessageReaction'):
                # A chat action ("typing…") or a working reaction (👀, then 👍
                # or 👎) carries no content, and the next one replaces it. It is
                # sent only inside a bound presence and is not journaled, so a long
                # turn adds no archive records. It never runs under a dispatch key,
                # so a journal entry could not answer a retried turn's 👀 anyway.
                # It leaves only its send record ("typing…" only when it fails).
                try:
                    if check is None:
                        raise Held('telegram_chat_action_unbound' if method == 'sendChatAction' else 'telegram_reaction_unbound')
                    await asyncio.to_thread(check, method, parameters)
                except Exception as error:
                    sends.refused(method, parameters, None, str(error) if isinstance(error, Held) else None)
                    raise
                started = perf_counter()
                try:
                    result = await super().do_request(*args, **kwargs)
                except BaseException as error:
                    sends.failed(method, parameters, None, error, elapsed(started))
                    raise
                sends.answered(method, parameters, None, result, elapsed(started))
                return result
            if check is not None:
                try:
                    await asyncio.to_thread(check, method, parameters)
                except Exception as error:
                    sends.refused(method, parameters, DISPATCH_KEY.get(), str(error) if isinstance(error, Held) else None)
                    raise
            # Context is inherited by tasks the sender starts.
            dispatch = DISPATCH_KEY.get() or 'control:' + uuid.uuid4().hex
            # The bound check may record each admitted request's journal outcome.
            observe = getattr(check, 'observe', None) or (lambda *_: None)
            # A journal replay sends nothing, and a hold after an uncertain attempt
            # follows that attempt's own record, so neither adds a send record.
            try:
                key, saved = await asyncio.to_thread(capture.outbound, method, parameters, dispatch)
            except BaseException:
                observe(method, 'ambiguous', 0)
                raise
            if saved is not None:
                observe(method, capture.outcome(saved), saved[0])
                return saved
            started = perf_counter()
            try:
                result = await super().do_request(*args, **kwargs)
            except BaseException as error:
                sends.failed(method, parameters, dispatch, error, elapsed(started))
                await asyncio.shield(asyncio.to_thread(capture.complete, key, method, parameters, None))
                observe(method, 'ambiguous', 0)
                raise
            ms = elapsed(started)
            try:
                observe(method, await asyncio.to_thread(capture.complete, key, method, parameters, result), result[0])
            finally:
                sends.answered(method, parameters, dispatch, result, ms)
            return result

    request.__class__ = CapturedRequest
    return request


async def clear_command_menu(bot, groups, sleep=asyncio.sleep, waits=(0, 60, 300, 900)):
    """Leave no command menu in any scope Hermes ever filled, and check that it stayed empty.

    Nocheh runs no bot command: a slash command is ordinary text for the owner, and nobody
    else may use the bot. A process that is still shutting down, or a rate limit, can leave
    a menu behind, so each scope is read back and cleared again after a while.
    """
    from telegram import BotCommandScopeAllGroupChats, BotCommandScopeAllPrivateChats, BotCommandScopeChat, BotCommandScopeDefault
    from telegram.error import BadRequest, Forbidden
    log = logging.getLogger(__name__)
    scopes = [BotCommandScopeDefault(), BotCommandScopeAllPrivateChats(), BotCommandScopeAllGroupChats()]
    try:
        # Native Hermes gave each forum group its own menu, which outranks the shared ones.
        scopes += [BotCommandScopeChat(chat_id=int(chat)) for chat in groups]
    except (ValueError, TypeError):
        pass
    for attempt, wait in enumerate(waits):
        await sleep(wait)
        left = []
        for scope in scopes:
            try:
                if await bot.get_my_commands(scope=scope):
                    await bot.delete_my_commands(scope=scope)
                    if await bot.get_my_commands(scope=scope):
                        left.append(scope)
            except (BadRequest, Forbidden):
                pass  # The bot is no longer in that chat, so it shows no menu there.
            except Exception as error:  # A rate limit or network error: try again later.
                log.warning('command_menu_not_cleared: %s %s', scope.type, type(error).__name__)
                left.append(scope)
        if attempt == 0:
            # Recheck every scope once more later: an exiting process may still write its menu.
            continue
        if not left:
            return
        scopes = left
    log.warning('command_menu_left: %s', ','.join(scope.type for scope in scopes))
