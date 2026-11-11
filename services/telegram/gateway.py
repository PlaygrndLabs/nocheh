"""The Telegram front door: presence, replies, approved sends, cards, refusals and notices, each journaled.

Nocheh's core decides what to send and when; this service decides only whether a request may leave,
and records what it sent. Receipts in spool/dispatch make every send at most once.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
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
from .capture import Capture, DISPATCH_KEY, OUTBOUND_CHECK
from .checks import (EYES, NOT_TRANSMITTED, THUMBS_DOWN, THUMBS_UP, approval_links, check_action_policy, check_delivery_policy, delivery_failure,
                     no_preview, notice_buttons, outbound_check, reaction_check, render_reply_citations, space_of, verify_turn_credential)

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


def topic_of(value):
    """A forum topic id or None; 1 is the forum's General topic."""
    if value is None or value == '': return None
    if type(value) is not int or not 0 < value <= 9007199254740991: raise ValueError('invalid_topic')
    return value


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
        return {**polling, 'state': state, 'error_code': code}

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
        """The chat, topic and answered message of a turn, checked against the policy and the turn credential."""
        event, attempt = body.get('event_id'), body.get('attempt')
        if not isinstance(event, str) or not HEX.fullmatch(event) or not isinstance(attempt, (int, str)) or isinstance(attempt, bool):
            raise ValueError('invalid_turn')
        if not HEX.fullmatch(str(body.get('id', ''))) or body['id'] != digest(event + ':' + str(attempt)): raise ValueError('invalid_turn')
        chat, message = str(body.get('chat_id') or ''), str(body.get('message_id') or body.get('reply_to') or '')
        if not CHAT.fullmatch(chat) or not MESSAGE.fullmatch(message) or not self.policy.allowed_chat(chat): raise ValueError('invalid_turn')
        topic = topic_of(body.get('topic'))
        owner = chat == self.policy.owner
        if owner and topic is not None: raise ValueError('invalid_turn')
        credential = body.get('archive_credential')
        if not isinstance(credential, str): raise ValueError('invalid_turn')
        verify_turn_credential(credential, event, chat, space_of(chat, topic), owner)
        return chat, topic, message, credential

    def presence(self, body):
        chat, topic, message, credential = self._turn(body)
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
        token = OUTBOUND_CHECK.set(outbound_check(presence.chat, space_of(presence.chat, presence.topic),
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
        chat, topic, message, credential = self._turn(body)
        dispatch, text, session = body.get('dispatch_key'), body.get('text'), body.get('session_id')
        bot = re.escape(self.bot_id or 'none')
        match = re.fullmatch(r'(telegram:' + bot + r':update:(\d{1,19}))(?::continuation:[a-f0-9]{64})?', dispatch) if isinstance(dispatch, str) else None
        if not match or digest(match.group(1)) != body['event_id']: raise ValueError('invalid_reply')
        if (not isinstance(text, str) or len(text) > 100000 or not isinstance(session, str) or not 0 < len(session) <= 200
                or not isinstance(body.get('notify', False), bool) or not isinstance(body.get('presence', False), bool)):
            raise ValueError('invalid_reply')
        if self.loop is None:
            return dict(NOT_TRANSMITTED)
        future = asyncio.run_coroutine_threadsafe(self._reply(key, body, chat, topic, message, credential), self.loop)
        try: return future.result(timeout=REPLY_WAIT)
        except concurrent.futures.TimeoutError: return {'state': 'running'}

    def _observe(self, key):
        result, intent = self.receipts / ('reply-' + key + '.result'), self.receipts / ('reply-' + key + '.intent')
        if result.exists(): return json.loads(result.read_bytes())
        task = self.replies.get(key)
        if task is not None and not task.done(): return {'state': 'running'}
        return {'state': 'ambiguous'} if intent.exists() else {'state': 'not_found'}

    async def _reply(self, key, body, chat, topic, message, credential):
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
            task = self.replies[key] = asyncio.ensure_future(self._deliver(key, body, chat, topic, message, credential, text))
            task.add_done_callback(lambda _: (self.replies.pop(key, None), self.cancels.pop(key, None)))
        return await asyncio.shield(task)

    async def _deliver(self, key, body, chat, topic, message, credential, text):
        name = 'reply-' + key
        await asyncio.to_thread(immutable_file, self.receipts, name + '.intent', canonical({'event_id': body['event_id'], 'attempt': body['attempt']}))
        requests, cancelled = [], self.cancels[key]
        dispatch = DISPATCH_KEY.set(body['dispatch_key'])
        check = OUTBOUND_CHECK.set(outbound_check(chat, space_of(chat, topic), lambda: check_delivery_policy(credential), cancelled, requests))
        started, sending = int(time.time() * 1000), perf_counter()
        try:
            # The archive keeps the reply as the brain gave it, whatever Telegram later does with it.
            await asyncio.to_thread(self.capture.enqueue, self.capture.event('assistant:' + body['event_id'] + ':' + str(body['attempt']),
                'assistant_result', {'event_id': body['event_id'], 'session_id': body['session_id']}, chat, text))
            # Stop typing before the reply: a status sent after it would show again.
            await self._stop_typing(body['id'])
            # A follow-up arrives when nobody watches the typing, so it alerts; an ordinary reply is silent.
            if await self.sender.send(chat, text, reply_to=int(message), topic=topic, notify=body.get('notify', False)):
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
        destination = re.fullmatch(r'(-?[1-9]\d{0,18})(?:/topic/([1-9]\d{0,15}))?', str(body.get('destination', '')))
        if (not HEX.fullmatch(str(body.get('id', ''))) or not destination or not isinstance(body.get('text'), str)
                or not 0 < len(body['text'].encode('utf-16-le')) // 2 <= 12000): raise ValueError('invalid_action')
        chat_id, topic = destination.groups()
        if topic and int(topic) > 9007199254740991: raise ValueError('invalid_action')
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
            check = OUTBOUND_CHECK.set(outbound_check(chat_id, body['destination'], lambda: check_action_policy(body)))
            try:
                # Any failure is reported as possibly sent: the caller reconciles rather than sending twice.
                result = {'state': 'done' if await self.sender.send(chat_id, body['text'], topic=int(topic) if topic else None, notify=True) else 'ambiguous'}
            except Exception:
                result = {'state': 'ambiguous'}
            finally:
                OUTBOUND_CHECK.reset(check)
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
        owner=bool(self.policy.owner) and chat==str(self.policy.owner) and re.fullmatch(r'[1-9]\d{0,18}',chat)
        if not owner and chat not in (self.policy.groups or []) or topic and (owner or not re.fullmatch(r'[1-9]\d{0,15}',topic)):raise ValueError('approval_chat_not_allowed')
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
            name='approval-'+body['id']
            async with self.action_lock:
                receipt=self.receipts/(name+'.result')
                if receipt.exists():return json.loads(receipt.read_bytes())
                if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
                await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'action_id':body['id'],'chat_id':chat}))
                token=DISPATCH_KEY.set('approval:'+body['id'])
                check=OUTBOUND_CHECK.set(outbound_check(chat,chat+('/topic/'+topic if topic else ''),lambda:True))
                try:
                    # In the chat where it was asked, the card is the reply to the request.
                    # Links are entities over plain text, so no default formatting applies.
                    sent=await bot.send_message(int(chat),text,message_thread_id=int(topic) if topic else None,reply_markup=InlineKeyboardMarkup(rows),
                                                entities=entities,parse_mode=None,reply_to_message_id=int(reply) if reply else None,allow_sending_without_reply=True,
                                                link_preview_options=no_preview())
                    result={'state':'done','chat_id':chat,'message_id':str(sent.message_id)}
                except Exception:result={'state':'ambiguous'}
                finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
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
            token=DISPATCH_KEY.set('approval-settle:'+body['id'])
            # The decided card keeps its text with the outcome.
            # Telegram refuses a repeated identical edit, which changes nothing.
            try:return {'state':'done','edited':bool(await bot.edit_message_text(text,chat_id=int(chat),message_id=int(card['message_id']),entities=entities,parse_mode=None,reply_markup=stop,
                                                                             link_preview_options=no_preview()))}
            except Exception:return {'state':'done','edited':False}
            finally:DISPATCH_KEY.reset(token)
        if body.get('kind')=='answer':
            query=body.get('callback_query_id')
            if not isinstance(query,str) or not 0<len(query)<=64 or len(text)>200:raise ValueError('invalid_approval')
            token=DISPATCH_KEY.set('approval-answer:'+query)
            # Stops the button's spinner; an expired or repeated answer is refused and changes nothing.
            try:return {'state':'done','answered':bool(await bot.answer_callback_query(query,text=text))}
            except Exception:return {'state':'done','answered':False}
            finally:DISPATCH_KEY.reset(token)
        raise ValueError('invalid_approval')

    def refusal(self, body):
        return self.call(self.send_refusal(body))

    async def send_refusal(self, body):
        """The owner's fixed reply to someone not allowed in an allowed group who
        addressed Nocheh, or to anyone but the owner who writes to it privately,
        there at most once a UTC day per person. No model runs and nothing else
        about the chat is sent. Nocheh's core has already decided the message addressed the bot."""
        chat,user,message,topic=(str(body.get(key) or '') for key in ('chat_id','user_id','message_id','topic'))
        personal=body.get('private') is True
        if (not HEX.fullmatch(str(body.get('event_id',''))) or (chat!=user or topic if personal else chat not in (self.policy.groups or [])) or
                not re.fullmatch(r'[1-9]\d{0,18}',user) or not re.fullmatch(r'[1-9]\d{0,18}',message) or topic and not re.fullmatch(r'[1-9]\d{0,15}',topic)):
            raise ValueError('invalid_refusal')
        reply=body.get('reply')
        if not isinstance(reply,str) or not reply.strip() or len(reply)>1000:raise ValueError('invalid_refusal')
        if user==str(self.policy.owner):return {'state':'skipped'}
        if not personal:
            access=(self.policy.group_access or {}).get(chat,{})
            if user in access.get('granted',[]) and user not in access.get('denied',[]):return {'state':'skipped'}
        if not self.connected():return {'state':'not_started','error_code':'telegram_not_connected'}
        # One private reply a day: a stranger who keeps writing can't make the bot keep answering.
        name='refusal-private-'+user+'-'+datetime.now(timezone.utc).strftime('%Y%m%d') if personal else 'refusal-'+body['event_id']
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'event_id':body['event_id']}))
            token=DISPATCH_KEY.set('refusal:'+body['event_id'])
            check=OUTBOUND_CHECK.set(outbound_check(chat,chat+('/topic/'+topic if topic else ''),lambda:True))
            try:
                await self.bot.send_message(int(chat),reply,message_thread_id=int(topic) if topic else None,
                                            reply_to_message_id=int(message),allow_sending_without_reply=True,link_preview_options=no_preview())
                result={'state':'done'}
            except Exception:result={'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
            return result

    def notice(self, body):
        return self.call(self.send_notice(body))

    async def send_notice(self, body):
        """A task reminder or a problem notice in the owner's private chat. No model runs;
        the text is the owner's template filled in by storage, sent at most once.
        With edit, a notice this service sent is edited in place instead, such as to mark a cleared problem."""
        chat=str(body.get('chat_id') or '')
        if not HEX.fullmatch(str(body.get('id',''))) or not self.policy.owner or chat!=str(self.policy.owner) or not re.fullmatch(r'[1-9]\d{0,18}',chat):
            raise ValueError('notice_chat_not_allowed')
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
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'notice_id':body['id']}))
            token=DISPATCH_KEY.set('notice:'+body['id'])
            check=OUTBOUND_CHECK.set(outbound_check(chat,chat,lambda:True))
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
            finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
            # The receipt keeps which message it was, so the notice can be edited later; callers get only the state.
            message=getattr(sent,'message_id',None) if result['state']=='done' else None
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical({**result,**({'message_id':message} if isinstance(message,int) else {})}))
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
        token=DISPATCH_KEY.set('notice-edit:'+name+':'+uuid.uuid4().hex)
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
        finally:DISPATCH_KEY.reset(token)

