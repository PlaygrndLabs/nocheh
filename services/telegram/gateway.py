"""The Telegram front door: presence, replies, approved sends, cards, refusals, notices and leaves, each journaled.

Nocheh's core decides what to send and when; this service decides only whether a request may leave,
and records what it sent. Receipts in spool/dispatch make every send at most once.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import re
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter

from services.durable import canonical, digest, immutable_file
from . import settings
from .capture import Capture, DISPATCH_KEY, OUTBOUND_CHECK, SEND_ANSWERS, SEND_CLASS
from .checks import (EYES, NOT_TRANSMITTED, THUMBS_DOWN, THUMBS_UP, answer_button, approval_links, check_action_policy, check_delivery_policy, check_leave_policy, check_notice_policy,
                     SCHEDULE_CALLBACK, delivery_failure, leave_check, no_preview, notice_buttons, outbound_check, reaction_check, render_reply_citations, verify_turn_credential)
from .sends import GONE, route_class

# Telegram shows "typing…" for about five seconds per chat action, so presence renews it a little sooner.
TYPING_INTERVAL = 4.0
# Presence ends by itself when Nocheh stops renewing it, such as after a crash between start and finish.
PRESENCE_TTL = 30.0
# How long a reply call waits for its send before answering "running"; the send goes on.
REPLY_WAIT = 20.0
HEX = re.compile(r'[a-f0-9]{64}')
CHAT = re.compile(r'-?[1-9]\d{0,18}')
MESSAGE = re.compile(r'[1-9]\d{0,15}')
ERROR_NAME = re.compile(r'[A-Za-z_]{1,64}')
# The kinds of a group's fixed reply, each sent at most once a UTC day per person and group: not allowed there, or over the
# member daily message cap.
REFUSAL_KINDS = ('not_allowed', 'daily_limit')
# The classes storage may ask for on each route (ADR-0256); anything else gets the route's own, and the send still goes.
REPLY_CLASSES = ('reply', 'follow_up', 'private_answer', 'card')
ACTION_CLASSES = ('approved_post', 'job_report', 'scheduled_run', 'notice')
# The owner's ask about a member (step 4b) is answered in its own message, a class never learned nor consented to. It
# goes only to the owner's private chat: a reply under the ask's own pass, or a notice there.
MEMBER_READ = 'member_read'
NOTICE_CLASSES = ('notice', 'reminder', MEMBER_READ)


def topic_of(value):
    """A forum topic id or None; 1 is the forum's General topic. Storage sends Telegram's thread id, the number its topic
    key names (ADR-0252); the key as text is taken too."""
    if value is None or value == '': return None
    if isinstance(value, str) and value.isascii() and value.isdigit() and value[0] != '0' and len(value) <= 16: value = int(value)
    if type(value) is not int or not 0 < value <= 9007199254740991: raise ValueError('invalid_topic')
    return value


def member_notice_shape(body):
    """Whether a notice has one of the only shapes a member's own private chat takes: a task reminder, with no topic,
    buttons or edit (step 5); or the message about a schedule the member set there, with no topic, and only its Pause or
    Start and Delete presses or no buttons, sent or edited (members' schedules)."""
    if body.get('topic') not in (None,''):return False
    if body.get('send_class')=='reminder':return body.get('buttons') is None and body.get('edit') is None
    buttons=body.get('buttons')
    presses=buttons is None or isinstance(buttons,list) and len(buttons)==1 and isinstance(buttons[0],list) and 0<len(buttons[0])<=2 and all(
        isinstance(button,dict) and set(button)=={'text','callback'} and isinstance(button['callback'],str) and SCHEDULE_CALLBACK.fullmatch(button['callback'])
        for button in buttons[0])
    return body.get('send_class')=='notice' and body.get('edit') in (None,True) and presses


class Presence:
    def __init__(self, chat, topic, message, credential):
        self.chat, self.topic, self.message, self.credential = chat, topic, message, credential
        self.expires = time.monotonic() + PRESENCE_TTL
        self.stopped = asyncio.Event()
        self.typing = self.eyes = None


class TelegramService:
    def __init__(self, policy, token, spool: Path, state: Path, on_fatal=None, bot_factory=None):
        self.policy, self.token, self.spool, self.state, self.on_fatal = policy, token, Path(spool), Path(state), on_fatal
        # Tests pass a factory that builds the bot against the fake Telegram.
        self.bot_factory = bot_factory
        self.bot_id = token.split(':', 1)[0] if token else None
        self.status = 'disabled' if not policy.enabled else 'credentials_missing' if not token else 'starting'
        self.typing_on, self.reactions_on = settings.typing_enabled(), settings.reactions_enabled()
        self.loop = self.bot = self.sender = self.capture = self.action_lock = None
        self.identity, self.failure, self.stopping, self.poller = None, None, False, None
        # What getMe says the bot may do, shown in health (poller.ABILITIES).
        self.abilities = {}
        self.thread = self.polling = None
        self.presences, self.replies, self.cancels = {}, {}, {}
        self.receipts = self.spool / 'dispatch'
        self.receipts.mkdir(parents=True, exist_ok=True)
        # On boot, a send that recorded its intent but no result may have reached Telegram.
        for intent in self.receipts.glob('*.intent'):
            result = intent.with_suffix('.result')
            if not result.exists():
                immutable_file(self.receipts, result.name, canonical({'state': 'ambiguous', 'error_code': 'runtime_restart_during_dispatch'}))

    # ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

    def start(self):
        if self.status != 'starting': return
        self.capture = Capture(self.spool, self.bot_id)
        ready = threading.Event()
        self.thread = threading.Thread(target=self._serve, args=(ready,), name='nocheh-telegram', daemon=True)
        self.thread.start()
        ready.wait(10)

    def _serve(self, ready):
        async def run():
            from telegram import Bot
            from .poller import Poller, requests
            from .sender import Sender
            self.loop, self.action_lock, self.ended = asyncio.get_running_loop(), asyncio.Lock(), asyncio.Event()
            if self.bot_factory:
                self.bot = self.bot_factory(self.capture)
            else:
                general, updates = requests(self.capture)
                self.bot = Bot(self.token, request=general, get_updates_request=updates)
            self.sender = Sender(self.bot, sends=self.capture.sends)
            self.poller = Poller(self)
            self.polling = asyncio.ensure_future(self.poller.run())
            self.polling.add_done_callback(lambda task: task.cancelled() or task.exception() is None or self.fatal('telegram_adapter_failed', True))
            watcher = asyncio.ensure_future(self._expire_presences())
            ready.set()
            try:
                # After a fatal error the loop stays up: health and receipts are still served until restarted.
                await self.ended.wait()
            finally:
                watcher.cancel()
        try:
            asyncio.run(run())
        except Exception:
            self.fatal('telegram_adapter_failed', retryable=True)
        finally:
            ready.set()

    def fatal(self, code, retryable):
        if self.stopping or self.failure: return
        self.failure = {'code': code, 'retryable': retryable}
        info = self.health()
        self.status = 'failed'
        # Persist a content-free incident across the supervised process restart.
        path = self.state / 'telegram-incident.json'
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix('.tmp')
            temporary.write_bytes(canonical({**info, 'state': 'failed', 'recorded_at': datetime.now(timezone.utc).isoformat()}))
            temporary.chmod(0o600)
            temporary.replace(path)
        except OSError:
            pass  # Failed diagnostics must not prevent recovery.
        if retryable and self.on_fatal: self.on_fatal()

    def health(self):
        polling = dict(self.capture.polling) if self.capture else {}
        state, code = self.status, polling.get('error_code')
        if self.failure:
            state, code = 'failed', self.failure['code']
        elif state == 'connected':
            last = polling.get('last_poll_at')
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() if last else None
            if age is None or age > 120: state = 'recovering'
        # The bot's public @username, so the dashboard shows which bot is connected.
        bot = {'bot_username': self.identity['username']} if (self.identity or {}).get('username') else {}
        return {**polling, **self.abilities, **bot, 'state': state, 'error_code': code}

    def stop(self):
        self.stopping = True
        if self.loop is None: return
        async def drain():
            self.polling.cancel()
            # Let sends already under way finish, so they leave a result instead of an ambiguous intent.
            pending = [task for task in self.replies.values() if not task.done()]
            if pending: await asyncio.wait(pending, timeout=20)
            for presence in list(self.presences.values()): presence.stopped.set()
            await asyncio.wait([self.polling, *(task for presence in self.presences.values() for task in (presence.typing, presence.eyes) if task)], timeout=5)
            if self.poller.menu: self.poller.menu.cancel()
            try: await self.bot.shutdown()
            except Exception: pass
            # Send records still being written are kept rather than dropped with the loop.
            try: await asyncio.wait_for(self.capture.sends.settle(), 5)
            except Exception: pass
            self.ended.set()
        try: asyncio.run_coroutine_threadsafe(drain(), self.loop).result(timeout=35)
        except Exception: pass
        self.thread.join(5)

    def call(self, coroutine, timeout=55):
        if self.loop is None:
            coroutine.close()
            raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout=timeout)

    def connected(self):
        # Recovering means one poll failed; sends still try, and a real outage fails them on its own.
        return self.status in ('connected', 'recovering') and self.bot is not None

    def identify(self, body=None):
        return {'state': self.health()['state'], **(self.identity or {})}

    # ── presence: typing and the working reaction ───────────────────────────────────────────────

    def _turn(self, body):
        """The chat, topic and answered message of a turn, checked against its turn credential and the served list."""
        event, attempt = body.get('event_id'), body.get('attempt')
        if not isinstance(event, str) or not HEX.fullmatch(event) or not isinstance(attempt, (int, str)) or isinstance(attempt, bool):
            raise ValueError('invalid_turn')
        if not HEX.fullmatch(str(body.get('id', ''))) or body['id'] != digest(event + ':' + str(attempt)): raise ValueError('invalid_turn')
        chat, message = str(body.get('chat_id') or ''), str(body.get('message_id') or body.get('reply_to') or '')
        if not CHAT.fullmatch(chat) or not MESSAGE.fullmatch(message) or not self.policy.enabled: raise ValueError('invalid_turn')
        topic = topic_of(body.get('topic'))
        credential = body.get('archive_credential')
        if not isinstance(credential, str): raise ValueError('invalid_turn')
        # The pass's app binding names this chat and topic, and the served list agrees its space is there now (ADR-0252).
        claims, served = verify_turn_credential(credential, event, chat, topic, self.policy)
        return chat, topic, message, credential, served, claims

    def presence(self, body):
        chat, topic, message, credential, _, _ = self._turn(body)
        finish = body.get('finish')
        if finish not in (None, 'answered', 'failed', 'clear'): raise ValueError('invalid_presence')
        if finish is not None:
            if self.loop is None: return {'state': 'finished'}
            return self.call(self._finish(body['id'], chat, message, credential, finish))
        if not (self.typing_on or self.reactions_on): return {'state': 'off'}
        if not self.connected(): return {'state': 'not_started'}
        return self.call(self._start(body['id'], chat, topic, message, credential))

    async def _start(self, key, chat, topic, message, credential):
        current = self.presences.get(key)
        if current and not current.stopped.is_set():
            current.expires, current.credential = time.monotonic() + PRESENCE_TTL, credential
            return {'state': 'shown'}
        current = self.presences[key] = Presence(chat, topic, message, credential)
        if self.reactions_on:
            current.eyes = asyncio.ensure_future(self._react(chat, message, lambda: current.credential, EYES))
        if self.typing_on:
            current.typing = asyncio.ensure_future(self._typing(current))
        return {'state': 'shown'}

    async def _typing(self, presence):
        token = OUTBOUND_CHECK.set(outbound_check(presence.chat, presence.topic,
                                                  lambda: check_delivery_policy(presence.credential), presence.stopped))
        try:
            while not presence.stopped.is_set():
                try: await asyncio.wait_for(self.sender.typing(presence.chat, presence.topic), TYPING_INTERVAL)
                except Exception: pass  # A missed status is cosmetic; the next tick tries again.
                try: await asyncio.wait_for(presence.stopped.wait(), TYPING_INTERVAL)
                except asyncio.TimeoutError: pass
        finally:
            OUTBOUND_CHECK.reset(token)

    async def _react(self, chat, message, credential, emoji):
        """Set or clear the working reaction on the answered message; a missed reaction is cosmetic."""
        token = OUTBOUND_CHECK.set(reaction_check(chat, message, lambda: check_delivery_policy(credential())))
        try:
            await self.bot.set_message_reaction(chat_id=int(chat), message_id=int(message), reaction=emoji)
        except Exception:
            pass
        finally:
            OUTBOUND_CHECK.reset(token)

    async def _stop_typing(self, key):
        presence = self.presences.get(key)
        if presence is None: return
        presence.stopped.set()
        if presence.typing: await asyncio.wait([presence.typing])

    async def _finish(self, key, chat, message, credential, finish):
        presence = self.presences.pop(key, None)
        if presence:
            presence.stopped.set()
            await asyncio.wait([task for task in (presence.typing, presence.eyes) if task])
        if self.reactions_on and self.connected():
            # The final reaction replaces 👀; clearing removes it when there is no answer to mark.
            await self._react(chat, message, lambda: credential, {'answered': THUMBS_UP, 'failed': THUMBS_DOWN}.get(finish))
        return {'state': 'finished'}

    async def _expire_presences(self):
        while True:
            await asyncio.sleep(2)
            now = time.monotonic()
            for key, presence in list(self.presences.items()):
                if presence.expires < now:
                    await self._finish(key, presence.chat, presence.message, presence.credential, 'clear')

    # ── replies ─────────────────────────────────────────────────────────────────────────────────

    def reply(self, body):
        key = str(body.get('id', ''))
        if not HEX.fullmatch(key): raise ValueError('invalid_reply')
        if body.get('observe_only') is True: return self._observe(key)
        if body.get('cancel') is True:
            flag = self.cancels.get(key)
            if flag is not None and self.loop: self.loop.call_soon_threadsafe(flag.set)
            return self._observe(key)
        chat, topic, message, credential, served, claims = self._turn(body)
        dispatch, text, session = body.get('dispatch_key'), body.get('text'), body.get('session_id')
        bot = re.escape(self.bot_id or 'none')
        match = re.fullmatch(r'(telegram:' + bot + r':update:(\d{1,19}))(?::continuation:[a-f0-9]{64})?', dispatch) if isinstance(dispatch, str) else None
        if not match or digest(match.group(1)) != body['event_id']: raise ValueError('invalid_reply')
        if (not isinstance(text, str) or len(text) > 100000 or not isinstance(session, str) or not 0 < len(session) <= 200
                or not isinstance(body.get('notify', False), bool) or not isinstance(body.get('presence', False), bool)):
            raise ValueError('invalid_reply')
        # Answer privately, the one button a reply may carry: only in a served group and only this turn's own (ADR-0249);
        # never in a private chat, the owner's or a member's (step 4).
        markup = answer_button(body.get('button'), chat, body['event_id'], served)
        # An ask about a member is answered under its own class, and only in the owner's private chat; its pass sends
        # nothing else, and no other pass sends that class (step 4b).
        if claims.get('member_read') is not None or body.get('send_class') == MEMBER_READ:
            if claims.get('member_read') is None or body.get('send_class') not in (None, MEMBER_READ) or chat != served.owner_external() or topic is not None:
                raise ValueError('invalid_reply')
            body = {**body, 'send_class': MEMBER_READ}
        if self.loop is None:
            return dict(NOT_TRANSMITTED)
        future = asyncio.run_coroutine_threadsafe(self._reply(key, body, chat, topic, message, credential, markup), self.loop)
        try: return future.result(timeout=REPLY_WAIT)
        except concurrent.futures.TimeoutError: return {'state': 'running'}

    def _observe(self, key):
        result, intent = self.receipts / ('reply-' + key + '.result'), self.receipts / ('reply-' + key + '.intent')
        if result.exists(): return json.loads(result.read_bytes())
        task = self.replies.get(key)
        if task is not None and not task.done(): return {'state': 'running'}
        return {'state': 'ambiguous'} if intent.exists() else {'state': 'not_found'}

    async def _reply(self, key, body, chat, topic, message, credential, markup=None):
        name = 'reply-' + key
        receipt = self.receipts / (name + '.result')
        if receipt.exists(): return json.loads(receipt.read_bytes())
        task = self.replies.get(key)
        if task is None:
            if (self.receipts / (name + '.intent')).exists(): return {'state': 'ambiguous'}
            # Nothing is recorded yet, so a refusal here proves nothing was sent.
            if not self.connected(): return dict(NOT_TRANSMITTED)
            if not await asyncio.to_thread(check_delivery_policy, credential):
                return {'state': 'failed', 'error_code': 'space_policy_changed'}
            text = render_reply_citations(body['text'])
            if not text.strip():
                # Intentional silence: no answer to mark, so the working reaction is cleared.
                if body.get('presence'): await self._finish(body['id'], chat, message, credential, 'clear')
                return {'state': 'suppressed', 'error_code': 'intentional_silence'}
            self.cancels[key] = asyncio.Event()
            task = self.replies[key] = asyncio.ensure_future(self._deliver(key, body, chat, topic, message, credential, text, markup))
            task.add_done_callback(lambda _: (self.replies.pop(key, None), self.cancels.pop(key, None)))
        return await asyncio.shield(task)

    async def _deliver(self, key, body, chat, topic, message, credential, text, markup=None):
        name = 'reply-' + key
        await asyncio.to_thread(immutable_file, self.receipts, name + '.intent', canonical({'event_id': body['event_id'], 'attempt': body['attempt']}))
        requests, cancelled = [], self.cancels[key]
        dispatch = DISPATCH_KEY.set(body['dispatch_key'])
        # The reply answers this turn's message, which reply() checked against its dispatch key.
        # reply() let member_read through only for an ask's own pass in the owner's private chat.
        kind, answers = SEND_CLASS.set(route_class(body.get('send_class'), REPLY_CLASSES + (MEMBER_READ,), 'reply')), SEND_ANSWERS.set(body['event_id'])
        check = OUTBOUND_CHECK.set(outbound_check(chat, topic, lambda: check_delivery_policy(credential), cancelled, requests, markup))
        started, sending = int(time.time() * 1000), perf_counter()
        try:
            # The archive keeps the reply as the agent gave it, whatever Telegram later does with it.
            await asyncio.to_thread(self.capture.enqueue, self.capture.event('assistant:' + body['event_id'] + ':' + str(body['attempt']),
                'assistant_result', {'event_id': body['event_id'], 'session_id': body['session_id']}, chat, text))
            # Stop typing before the reply: a status sent after it would show again.
            await self._stop_typing(body['id'])
            # A follow-up arrives when nobody watches the typing, so it alerts; an ordinary reply is silent.
            if await self.sender.send(chat, text, reply_to=int(message), topic=topic, notify=body.get('notify', False), markup=markup):
                result = {'state': 'done'}
            elif (failure := delivery_failure(requests)) is not None:
                result = {'state': 'cancelled'} if failure['state'] == 'failed' and cancelled.is_set() else failure
            else:
                result = {'state': 'ambiguous', 'error_code': 'delivery_unconfirmed'}
        except Exception as error:
            # Once sending has started only reconciliation is safe, unless no message request was admitted.
            result = delivery_failure(requests) or {'state': 'ambiguous', 'error_code': 'dispatch_interrupted'}
            if result.get('error_code') in ('assistant_runtime_unavailable', 'dispatch_interrupted'):
                frames = traceback.extract_tb(error.__traceback__)
                for field, value in (('error_type', type(error).__name__), ('error_stage', frames[-1].name if frames else None)):
                    if isinstance(value, str) and ERROR_NAME.fullmatch(value) and field not in result: result[field] = value
        finally:
            OUTBOUND_CHECK.reset(check)
            SEND_ANSWERS.reset(answers)
            SEND_CLASS.reset(kind)
            DISPATCH_KEY.reset(dispatch)
        finished = max(started, int(time.time() * 1000))
        result['timings'] = {'telegram_send': {'ms': min(86400000, max(0, round((perf_counter() - sending) * 1000))), 'calls': 1}}
        result['window'] = {'delivery': started, 'finished': finished}
        await asyncio.to_thread(immutable_file, self.receipts, name + '.result', canonical(result))
        if body.get('presence'):
            outcome = 'answered' if result['state'] == 'done' else 'failed' if result['state'] in ('failed', 'suppressed') else 'clear'
            await self._finish(body['id'], chat, message, credential, outcome)
        return result

    # ── approved sends, cards, refusals and notices ─────────────────────────────────────────────

    def action(self, body):
        if body.get('observe_only') is True:
            if not HEX.fullmatch(str(body.get('id', ''))): raise ValueError('invalid_action')
            path = self.receipts / ('action-' + body['id'] + '.result')
            return json.loads(path.read_bytes()) if path.exists() else {'state': 'ambiguous' if (self.receipts / ('action-' + body['id'] + '.intent')).exists() else 'not_found'}
        return self.call(self.send_action(body))

    async def send_action(self, body):
        # Storage names the destination by its chat id and gives the Telegram chat and topic it is at now (ADR-0252); the
        # app checks both again before the send (check_action_policy).
        chat_id, destination = str(body.get('chat_id') or ''), body.get('destination')
        if (not HEX.fullmatch(str(body.get('id', ''))) or not CHAT.fullmatch(chat_id) or not isinstance(destination, str) or not 0 < len(destination) <= 200
                or not isinstance(body.get('text'), str) or not 0 < len(body['text'].encode('utf-16-le')) // 2 <= 12000): raise ValueError('invalid_action')
        try: topic = topic_of(body.get('topic'))
        except ValueError: raise ValueError('invalid_action') from None
        name = 'action-' + body['id']
        async with self.action_lock:
            receipt = self.receipts / (name + '.result')
            if receipt.exists(): return json.loads(receipt.read_bytes())
            if (self.receipts / (name + '.intent')).exists(): return {'state': 'ambiguous'}
            # No intent exists for this action, so a refusal now proves that no
            # send was attempted. The caller may retry while approval is current.
            if not self.connected(): return {'state': 'not_started', 'error_code': 'telegram_not_connected'}
            if not await asyncio.to_thread(check_action_policy, body):
                result = {'state': 'denied'}
                await asyncio.to_thread(immutable_file, self.receipts, name + '.result', canonical(result))
                return result
            await asyncio.to_thread(immutable_file, self.receipts, name + '.intent', canonical({'action_id': body['id']}))
            token = DISPATCH_KEY.set('action:' + body['id'])
            kind = SEND_CLASS.set(route_class(body.get('send_class'), ACTION_CLASSES, 'approved_post'))
            check = OUTBOUND_CHECK.set(outbound_check(chat_id, topic, lambda: check_action_policy(body)))
            try:
                # Any failure is reported as possibly sent: the caller reconciles rather than sending twice.
                result = {'state': 'done' if await self.sender.send(chat_id, body['text'], topic=topic, notify=True) else 'ambiguous'}
            except Exception:
                result = {'state': 'ambiguous'}
            finally:
                OUTBOUND_CHECK.reset(check)
                SEND_CLASS.reset(kind)
                DISPATCH_KEY.reset(token)
            await asyncio.to_thread(immutable_file, self.receipts, name + '.result', canonical(result))
            return result

    def approval(self, body):
        return self.call(self.send_approval(body))

    async def send_approval(self, body):
        """Approve and Reject buttons on an exact pending action, in the owner's
        private chat or, for a message its requester reviews, in an allowed
        group and topic where it was asked.

        Pressing one is captured like any update; storage verifies who pressed
        it and decides. These calls only show the card and the decision on it.
        """
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        chat,topic=str(body.get('chat_id','')),str(body.get('topic') or '')
        # The owner's private chat, or a served group and one of its topics, where each is in Telegram now (ADR-0252).
        known=lambda served:chat==served.owner_external() or served.resolve(chat,topic or None) is not None
        served=await asyncio.to_thread(self.policy.current,None,5.0,known)
        owner=bool(chat) and chat==served.owner_external()
        group=None if owner else served.group(served.resolve(chat))
        if (not owner and (group is None or served.address(group)[0]!=chat) or
                topic and (owner or not re.fullmatch(r'[1-9]\d{0,15}',topic) or served.resolve(chat,topic) is None)):raise ValueError('approval_chat_not_allowed')
        text=body.get('text')
        if not isinstance(text,str) or not 0<len(text.encode('utf-16-le'))//2<=4096:raise ValueError('invalid_approval')
        entities=approval_links(body.get('links'),len(text.encode('utf-16-le'))//2)
        reply=str(body.get('reply_to') or '')
        if reply and not re.fullmatch(r'[1-9]\d{0,15}',reply):raise ValueError('invalid_approval')
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        bot=self.bot
        if body.get('kind')=='card':
            if not HEX.fullmatch(str(body.get('id',''))):raise ValueError('invalid_approval')
            pairs=list(body.get('buttons') or [])
            for pair in pairs:
                if not isinstance(pair,(list,tuple)) or len(pair)!=2:raise ValueError('invalid_approval')
                label,data=pair
                if not isinstance(label,str) or not 0<len(label)<=40 or not isinstance(data,str) or not re.fullmatch(r'n[adcw][a-f0-9]{56}',data):raise ValueError('invalid_approval')
            choices=[data for _,data in pairs]
            # Approve first and Reject last, for one action; an operation may also offer Allow where asked and Always allow (ADR-0214).
            if (not 2<=len(choices)<=4 or choices[0][1]!='a' or choices[-1][1]!='d'
                    or len({data[1] for data in choices})!=len(choices) or len({data[2:] for data in choices})!=1):raise ValueError('invalid_approval')
            buttons=[InlineKeyboardButton(label,callback_data=data) for label,data in pairs]
            # Approve and Reject share a row; longer allow buttons get one row each, so every label shows in full.
            rows=[buttons] if len(buttons)==2 else [[button] for button in buttons]
            keyboard=InlineKeyboardMarkup(rows)
            name='approval-'+body['id']
            async with self.action_lock:
                receipt=self.receipts/(name+'.result')
                if receipt.exists():return json.loads(receipt.read_bytes())
                if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
                await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'action_id':body['id'],'chat_id':chat}))
                token,kind=DISPATCH_KEY.set('approval:'+body['id']),SEND_CLASS.set('card')
                check=OUTBOUND_CHECK.set(outbound_check(chat,topic,lambda:True,markup=keyboard))
                try:
                    # In the chat where it was asked, the card is the reply to the request.
                    # Links are entities over plain text, so no default formatting applies.
                    sent=await bot.send_message(int(chat),text,message_thread_id=int(topic) if topic else None,reply_markup=keyboard,
                                                entities=entities,parse_mode=None,reply_to_message_id=int(reply) if reply else None,allow_sending_without_reply=True,
                                                link_preview_options=no_preview())
                    result={'state':'done','chat_id':chat,'message_id':str(sent.message_id)}
                except Exception:result={'state':'ambiguous'}
                finally:OUTBOUND_CHECK.reset(check);SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)
                await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
                return result
        if body.get('kind')=='settle':
            if not HEX.fullmatch(str(body.get('id',''))):raise ValueError('invalid_approval')
            name='approval-'+body['id'];receipt=self.receipts/(name+'.result')
            card=json.loads(receipt.read_bytes()) if receipt.exists() else {}
            seen=str(body.get('message_id') or '')
            if seen and not re.fullmatch(r'[1-9]\d{0,15}',seen):raise ValueError('invalid_approval')
            if card.get('state')!='done':
                # A send whose answer was lost may still have reached the chat. A press on that card names its message
                # (storage passes only a pressed message that carries this card's button), and it is kept at once, so
                # later edits find it even if this edit's own answer is lost. Only a card this service tried to send to
                # this chat is edited, and Telegram lets a bot edit only its own messages.
                found=self.receipts/(name+'.seen')
                if found.exists():card=json.loads(found.read_bytes())
                elif seen and (self.receipts/(name+'.intent')).exists() and json.loads((self.receipts/(name+'.intent')).read_bytes()).get('chat_id')==chat:
                    card={'state':'done','chat_id':chat,'message_id':seen}
                    # Best effort: without it a later edit needs another press.
                    try:await asyncio.to_thread(immutable_file,self.receipts,name+'.seen',canonical(card))
                    except Exception:pass
            # Only a card this service sent, in the chat it was sent to, is edited.
            # A running background job's card keeps one Stop button; every other decided card loses its buttons.
            stop=body.get('buttons')
            if stop is not None:
                if (not isinstance(stop,list) or len(stop)!=1 or not isinstance(stop[0],(list,tuple)) or len(stop[0])!=2 or not isinstance(stop[0][0],str)
                        or not 0<len(stop[0][0])<=40 or not isinstance(stop[0][1],str) or not re.fullmatch(r'ns[a-f0-9]{56}',stop[0][1])):raise ValueError('invalid_approval')
                stop=InlineKeyboardMarkup([[InlineKeyboardButton(stop[0][0],callback_data=stop[0][1])]])
            if card.get('state')!='done' or card.get('chat_id')!=chat:return {'state':'done','edited':False}
            token,kind=DISPATCH_KEY.set('approval-settle:'+body['id']),SEND_CLASS.set('card_update')
            # The decided card keeps its text with the outcome.
            # Telegram refuses a repeated identical edit, which changes nothing.
            try:return {'state':'done','edited':bool(await bot.edit_message_text(text,chat_id=int(chat),message_id=int(card['message_id']),entities=entities,parse_mode=None,reply_markup=stop,
                                                                             link_preview_options=no_preview()))}
            except Exception:return {'state':'done','edited':False}
            finally:SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)
        if body.get('kind')=='answer':
            query,start=body.get('callback_query_id'),body.get('start')
            if (not isinstance(query,str) or not 0<len(query)<=64 or len(text)>200 or
                    start is not None and (not isinstance(start,str) or not re.fullmatch(r'[a-f0-9]{32}',start))):raise ValueError('invalid_approval')
            # A tap on Answer privately opens the asker's private chat with the bot, with the record's id as its /start
            # parameter (ADR-0249). The link names the bot as Telegram itself named it; without that name there is no link.
            link={}
            if start is not None:
                username=(self.identity or {}).get('username')
                if not isinstance(username,str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}',username):raise ValueError('approval_link_unavailable')
                link={'url':'https://t.me/'+username+'?start='+start}
            token=DISPATCH_KEY.set('approval-answer:'+query)
            # Stops the button's spinner; an expired or repeated answer is refused and changes nothing.
            try:return {'state':'done','answered':bool(await bot.answer_callback_query(query,text=text,**link))}
            except Exception:return {'state':'done','answered':False}
            finally:DISPATCH_KEY.reset(token)
        raise ValueError('invalid_approval')

    def refusal(self, body):
        return self.call(self.send_refusal(body))

    async def send_refusal(self, body):
        """The owner's fixed reply to someone who may not talk to Nocheh in a served group and
        addressed it, at most once a UTC day per person, group and kind (`once`: not allowed
        there, or over the member daily message cap), or to anyone but the owner who writes
        to it privately, at most once a UTC day per person; a member over the daily message cap in their own private
        chat gets that cap's reply there (`once`: daily_limit) at most once a UTC day too, apart from the other. No model runs and nothing else
        about the chat is sent. Nocheh's core has already decided the message addressed the
        bot and that the sender may not talk there: who is a member is the core's alone (step 3).
        Only a reply that may have reached Telegram uses up the day's: one Telegram refused, such as in a closed topic, or
        that never left, keeps it for their next message."""
        chat,user,message,topic=(str(body.get(key) or '') for key in ('chat_id','user_id','message_id','topic'))
        personal=body.get('private') is True
        once=body.get('once')
        if once not in ((None,'daily_limit') if personal else REFUSAL_KINDS):raise ValueError('invalid_refusal')
        # A served group where it is in Telegram now, by the app's served list (ADR-0252).
        served=await asyncio.to_thread(self.policy.current,None,5.0,None if personal else lambda served:served.resolve(chat) is not None)
        group=None if personal else served.group(served.resolve(chat))
        if (not HEX.fullmatch(str(body.get('event_id',''))) or (chat!=user or topic if personal else group is None or served.address(group)[0]!=chat) or
                not re.fullmatch(r'[1-9]\d{0,18}',user) or not re.fullmatch(r'[1-9]\d{0,18}',message) or topic and not re.fullmatch(r'[1-9]\d{0,15}',topic)):
            raise ValueError('invalid_refusal')
        reply=body.get('reply')
        if not isinstance(reply,str) or not reply.strip() or len(reply)>1000:raise ValueError('invalid_refusal')
        if user==served.owner_user():return {'state':'skipped'}
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        # One reply a day: someone who keeps writing can't make the bot keep answering. In a group, one for each kind, in
        # the group whichever topic they write in.
        day=datetime.now(timezone.utc).strftime('%Y%m%d')
        # Privately the not-allowed reply keeps its own key, so a stranger's day is unchanged by the cap's (step 4).
        name=('refusal-private-' if once is None else 'refusal-private-'+once+'-')+user+'-'+day if personal else 'refusal-'+once+'-'+chat+'-'+user+'-'+day
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'event_id':body['event_id']}))
            requests=[]
            token,kind=DISPATCH_KEY.set('refusal:'+body['event_id']),SEND_CLASS.set('refusal')
            check=OUTBOUND_CHECK.set(outbound_check(chat,topic,lambda:True,requests=requests))
            try:
                await self.bot.send_message(int(chat),reply,message_thread_id=int(topic) if topic else None,
                                            reply_to_message_id=int(message),allow_sending_without_reply=True,link_preview_options=no_preview())
                result={'state':'done'}
            except Exception:result=delivery_failure(requests) or {'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)
            # A reply surely not delivered drops its intent, so their next message that day still gets one. A restart
            # before that keeps the intent, and the reply counts as sent.
            if result['state'] in ('done','ambiguous'):await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
            else:await asyncio.to_thread((self.receipts/(name+'.intent')).unlink)
            return result

    def member_status(self, body):
        return self.call(self.read_member(body))

    async def read_member(self, body):
        """Whether a person is still in a served group, asked of Telegram (getChatMember) before a member's private turn
        (step 4): 'in' for a member, an admin or the creator, or a restricted person who is still a member; 'left' for
        anyone who left, was removed or is restricted outside it. Only about a served group where it is in Telegram now.
        A read, never a send: nothing is journaled. Anything Telegram does not answer plainly is no answer
        (`failed`), and the app then changes nothing."""
        chat,user=str(body.get('chat_id') or ''),str(body.get('user_id') or '')
        # Which chat it is the served list says, below; the person is a raw Telegram user id.
        if not chat or not re.fullmatch(r'[1-9]\d{0,18}',user) or set(body)-{'chat_id','user_id'}:raise ValueError('invalid_member_status')
        served=await asyncio.to_thread(self.policy.current,None,5.0,lambda served:served.group(served.resolve(chat)) is not None)
        group=served.group(served.resolve(chat))
        if group is None or served.address(group)[0]!=chat:raise ValueError('member_status_chat_not_allowed')
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        try:found=await self.bot.get_chat_member(int(chat),int(user))
        except Exception:return {'state':'failed','error_code':'telegram_member_unknown'}
        status=getattr(found,'status',None)
        if status in ('creator','administrator','member'):return {'state':'done','status':'in'}
        if status=='restricted':
            member=getattr(found,'is_member',None)
            if type(member) is bool:return {'state':'done','status':'in' if member else 'left'}
        elif status in ('left','kicked'):return {'state':'done','status':'left'}
        return {'state':'failed','error_code':'telegram_member_unknown'}

    def notice(self, body):
        return self.call(self.send_notice(body))

    async def send_notice(self, body):
        """A task reminder or a problem notice in the owner's private chat. No model runs;
        the text is the owner's template filled in by storage, sent at most once.
        With edit, a notice this service sent is edited in place instead, such as to mark a cleared problem.

        Step 5 (ADR-0265 D10): one more place, a task reminder into the own private chat of the member who set it. Only
        send_class 'reminder', no topic, no buttons, no edit, a chat the app's served list marks as a member's own private
        chat that is open now, and only after core's one-time yes for this id, this chat and this exact text
        (check_notice_policy). Every other chat is refused before anything is sent."""
        chat=str(body.get('chat_id') or '')
        # The owner's private chat, where it is in Telegram now (ADR-0252); without one, nothing goes anywhere.
        owner=(await asyncio.to_thread(self.policy.current)).owner_external()
        if not HEX.fullmatch(str(body.get('id',''))) or not owner or not chat:raise ValueError('notice_chat_not_allowed')
        member=chat!=owner
        # A member's chat takes only a task reminder, with no topic, buttons or edit: anything else is refused at once.
        if member and not member_notice_shape(body):raise ValueError('notice_chat_not_allowed')
        text=body.get('text')
        if not isinstance(text,str) or not text.strip() or not 0<len(text.encode('utf-16-le'))//2<=4096:raise ValueError('invalid_notice')
        markup=notice_buttons(body.get('buttons'))
        if body.get('edit') not in (None,True):raise ValueError('invalid_notice')
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        name='notice-'+body['id']
        if body.get('edit'):return await self.edit_notice(name,chat,text,markup)
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return {key:value for key,value in json.loads(receipt.read_bytes()).items() if key!='message_id'}
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            if member:
                # The member's chat and core's yes are checked only now, after the receipts: a resend of one that went
                # is answered above even when the chat is no longer open to it, and the yes, which core gives once, is
                # spent only on a send that is about to happen.
                if not await self.member_notice_chat(body,chat):raise ValueError('notice_chat_not_allowed')
                asked=self.receipts/(name+'.asked')
                earlier=asked.exists()
                if not earlier:await asyncio.to_thread(immutable_file,self.receipts,name+'.asked',canonical({'notice_id':body['id']}))
                allowed=await asyncio.to_thread(check_notice_policy,{'id':body['id'],'chat':chat,'text_digest':hashlib.sha256(text.encode('utf-8')).hexdigest()})
                if allowed is None:return {'state':'not_started','error_code':'notice_check_unavailable'}
                # A no after an ask whose answer never came may be that yes, spent: nothing was sent, but whether core
                # gave it cannot be told, so it is unclear rather than refused.
                if allowed is not True and earlier:return {'state':'ambiguous','error_code':'notice_answer_lost'}
                if allowed is not True:raise ValueError('notice_chat_not_allowed')
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'notice_id':body['id']}))
            token,kind=DISPATCH_KEY.set('notice:'+body['id']),SEND_CLASS.set(route_class(body.get('send_class'),NOTICE_CLASSES,'notice'))
            check=OUTBOUND_CHECK.set(outbound_check(chat,None,lambda:True,markup=markup))
            sent=None
            try:
                from telegram.error import BadRequest
                try:sent=await self.bot.send_message(int(chat),text,parse_mode=None,reply_markup=markup,link_preview_options=no_preview())
                except BadRequest:
                    # Telegram refused a button, such as a dashboard address it does not accept;
                    # nothing was sent, so the notice goes without buttons.
                    if markup is None:raise
                    sent=await self.bot.send_message(int(chat),text,parse_mode=None,link_preview_options=no_preview())
                result={'state':'done'}
            except Exception:result={'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)
            # The receipt keeps which message it was, so the notice can be edited later; callers get only the state.
            message=getattr(sent,'message_id',None) if result['state']=='done' else None
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical({**result,**({'message_id':message} if isinstance(message,int) else {})}))
            return result

    async def member_notice_chat(self, body, chat):
        """Whether a notice may even ask core about `chat`, a chat that is not the owner's (step 5): a task reminder, no
        topic, no buttons, no edit, to a chat that the app's served list knows as a private chat and marks as a member's
        own private chat open now, read again once when the list does not hold it yet."""
        if not member_notice_shape(body):return False
        def member_private(served):
            local=served.resolve(chat)
            return local is not None and served.member_private(local) and not served.is_owner(local) and served.kind(local)=='private'
        served=await asyncio.to_thread(self.policy.current,None,60.0,member_private)
        return member_private(served) and served.owner_external()!=chat

    def leave(self, body):
        return self.call(self.leave_chat(body))

    async def leave_chat(self, body):
        """Nocheh leaves a group, supergroup or channel that someone other than the owner added it to (ADR-0253), when
        storage asks. Never the owner's chat or a chat that is served now: the app's served list decides, read again when
        it says the chat is not served and once more right before Telegram is asked, and one that cannot be read leaves
        nothing. Then only while the app says the group is still pending from this add. At most once by its id at each
        Telegram id: Telegram's answer is kept, and a chat Nocheh is not in any more counts as left. An upgraded group's new
        id is asked on its own, after the app confirms it is that group's current id. Leaving twice changes nothing, so a
        leave whose answer never came keeps no receipt and is tried again with its own journal entry, rather than left
        ambiguous."""
        chat=str(body.get('chat_id') or '')
        # A group, supergroup or channel: Telegram gives each a negative id, and a person a positive one.
        if not HEX.fullmatch(str(body.get('id',''))) or not CHAT.fullmatch(chat) or int(chat)>=0:raise ValueError('invalid_leave')
        async def unserved():
            """None when the chat may be left; refuses the owner's chat and a served one, and answers not_started when the
            list cannot be read."""
            served=await asyncio.to_thread(self.policy.current,None,5.0,lambda served:served.served(served.resolve(chat)))
            if not served.available:return {'state':'not_started','error_code':'served_list_unavailable'}
            found=served.resolve(chat)
            if served.is_owner(found) or served.served(found):raise ValueError('leave_chat_not_allowed')
        if refused:=await unserved():return refused
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        # Keyed by the Telegram id too: a refusal kept for a basic group never answers for the supergroup it became. The id
        # is negative digits, so the name is one to one and has no dot.
        name='leave-'+body['id']+'-'+chat.lstrip('-')
        from telegram.error import BadRequest, ChatMigrated, Forbidden
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return {key:value for key,value in json.loads(receipt.read_bytes()).items() if key!='chat_id'}
            # The owner may have turned the chat on or off, or someone added Nocheh again, while this leave waited behind
            # other sends: the list decides again, then the app says whether the group is still pending from this add, just
            # before the request goes. Neither keeps a receipt, so the stage asks again later and finds out why.
            if refused:=await unserved():return refused
            stands=await asyncio.to_thread(check_leave_policy,{'id':body['id'],'chat_id':chat})
            if stands is not True:return {'state':'not_started','error_code':'leave_superseded' if stands is False else 'leave_check_unavailable'}
            # A leave sends no message; it still runs under a class that is never learned (ADR-0256).
            token,kind=DISPATCH_KEY.set('leave:'+body['id']+':'+uuid.uuid4().hex),SEND_CLASS.set('notice')
            check=OUTBOUND_CHECK.set(leave_check(chat))
            try:
                await self.bot.leave_chat(int(chat))
                result={'state':'done'}
            except Forbidden:result={'state':'done'}
            except BadRequest as error:
                result={'state':'done'} if any(text in str(error).lower() for text in GONE) else {'state':'failed','error_code':'telegram_refused'}
            except ChatMigrated:
                # A basic group that became a supergroup: storage learns its new id from the upgrade and asks again there.
                return {'state':'not_started','error_code':'telegram_chat_migrated'}
            except Exception:return {'state':'not_started','error_code':'telegram_leave_unconfirmed'}
            finally:OUTBOUND_CHECK.reset(check);SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical({**result,'chat_id':chat}))
            return result

    async def edit_notice(self,name,chat,text,markup):
        """Edits a notice this service sent to the owner, found by its receipt. Without buttons, the notice loses them.
        Telegram refusing the edit, such as for unchanged text, a message the owner deleted or a bot the owner blocked,
        changes nothing and is not tried again; an edit that could not reach Telegram is. Repeating an edit that went through changes
        nothing, so each attempt gets its own journal entry: one lost in transit never blocks the next."""
        try:sent=json.loads((self.receipts/(name+'.result')).read_bytes())
        except (OSError,ValueError):sent={}
        message=sent.get('message_id') if isinstance(sent,dict) and sent.get('state')=='done' else None
        if not isinstance(message,int):return {'state':'not_found'}
        from telegram.error import BadRequest, Forbidden
        token,kind=DISPATCH_KEY.set('notice-edit:'+name+':'+uuid.uuid4().hex),SEND_CLASS.set('card_update')
        edit=lambda reply_markup:self.bot.edit_message_text(text,chat_id=int(chat),message_id=message,parse_mode=None,
                                                            reply_markup=reply_markup,link_preview_options=no_preview())
        try:
            try:return {'state':'done','edited':bool(await edit(markup))}
            except BadRequest as error:
                # A button Telegram does not accept: the notice was sent without buttons, so it is edited without them.
                if markup is None or 'not modified' in str(error).lower():return {'state':'done','edited':False}
                try:return {'state':'done','edited':bool(await edit(None))}
                except BadRequest:return {'state':'done','edited':False}
        except Forbidden:return {'state':'done','edited':False}
        except Exception:return {'state':'not_started','error_code':'telegram_edit_failed'}
        finally:SEND_CLASS.reset(kind);DISPATCH_KEY.reset(token)

