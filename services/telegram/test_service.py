"""The Telegram service end to end against the fake Bot API: polling, presence, replies and their receipts."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from services.durable import digest
from services.telegram.capture import instrument_request
from services.telegram.gateway import TelegramService
from services.telegram.poller import ALLOWED_UPDATES
from services.telegram.settings import Policy
from tools.acceptance.telegram_mock import TelegramMock, TOKEN

SECRET = 's' * 32
OWNER, GROUP = '123', '-10042'
BOT_ID = TOKEN.split(':')[0]
# A group first seen after step 2b has a digest chat id; NEW_TG is its Telegram id now and NEW_OLD the one before an upgrade.
NEW, NEW_TG, NEW_OLD = 'b' * 64, '-10077', '-77'
# The served list as the app gives it: the owner's chat, GROUP with its General topic and topic 7 (old-shaped ids), NEW.
TOPICS = [(GROUP + '/topic/1', GROUP, '1'), (GROUP + '/topic/7', GROUP, '7'), ('c' * 64, NEW, '5')]


def served_policy(enabled=True, access=None):
    return Policy.of(enabled, OWNER, [GROUP, (NEW, NEW_TG)], access or {}, topics=TOPICS, old={NEW: [NEW_OLD]})


def binding(chat, topic=None):
    return {'app': 'telegram', 'chat': chat, 'topic': None if topic is None else str(topic)}


def credential(event_id, scope=None, space=None, expires=None, **extra):
    claims = {'event_id': event_id, 'audience': 'nocheh-assistant', 'scope': scope,
              'expires': expires or int(time.time() * 1000) + 600000, **({'space': space, 'revision': 1} if space else {}), **extra}
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return 'turn.' + body + '.' + signature


def wait(condition, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition(): return
        time.sleep(0.02)
    raise AssertionError('condition not met')


class ServiceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        environment = patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1', 'SERVICE_TOKEN': SECRET,
                                              'TELEGRAM_TYPING': 'true', 'TELEGRAM_REACTIONS': 'true'})
        environment.start(); self.addCleanup(environment.stop)
        self.allowed = True
        for name in ('check_delivery_policy', 'check_action_policy'):
            patcher = patch('services.telegram.gateway.' + name, side_effect=lambda *_: self.allowed)
            patcher.start(); self.addCleanup(patcher.stop)
        self.mock = TelegramMock(self.root / 'telegram.json')
        app = FastAPI(); self.mock.install(app)

        def bot(capture):
            from telegram import Bot
            from telegram.request import HTTPXRequest
            request = lambda: HTTPXRequest(httpx_kwargs={'transport': httpx.ASGITransport(app=app)})
            return Bot(TOKEN, base_url='http://telegram.mock/bot', base_file_url='http://telegram.mock/file/bot',
                       request=instrument_request(request(), capture), get_updates_request=instrument_request(request(), capture, polling=True))
        self.policy = served_policy()
        self.service = TelegramService(self.policy, TOKEN, self.root / 'spool', self.root / 'state', bot_factory=bot)
        self.service.start()
        self.addCleanup(self.service.stop)
        wait(lambda: self.service.status == 'connected' and self.service.sender is not None)
        self.service.sender.pace = 0

    def turn(self, number, chat=OWNER, topic=None, scope=None, space=None, **extra):
        """A turn's body as storage sends it: the Telegram chat and topic now, and a pass for the Nocheh scope and space."""
        source = f'telegram:{BOT_ID}:update:{number}'
        event = digest(source)
        group = chat != OWNER
        scope = scope or (chat if group else None)
        space = space or (chat + ('/topic/' + str(topic) if topic else '') if group else OWNER)
        return {'id': digest(event + ':1'), 'event_id': event, 'attempt': 1, 'dispatch_key': source, 'chat_id': chat,
                'topic': None if topic is None else str(topic), 'reply_to': '77', 'message_id': '77', 'session_id': 'session-1', 'notify': False,
                'archive_credential': credential(event, scope, space, app=binding(chat, topic)), **extra}

    def inject(self, updates):
        # The fake Telegram runs on the service's loop; its state file and wake-up are not thread-safe.
        async def run(): return self.mock.inject({'updates': updates})
        return asyncio.run_coroutine_threadsafe(run(), self.service.loop).result(5)

    def sent(self):
        return [row['parameters'] for row in self.mock.state['sent']]

    def test_polling_captures_updates_and_reports_identity(self):
        self.inject([{'update_id': 5, 'message': {'message_id': 9, 'date': 1700000000, 'chat': {'id': 123, 'type': 'private'},
                                                                   'from': {'id': 123, 'is_bot': False, 'first_name': 'Owner'}, 'text': 'سلام'}}])
        wait(lambda: any((self.root / 'spool/pending').glob('*.json')) and self.mock.state['offset'] == 6)
        events = [json.loads(path.read_bytes()) for path in (self.root / 'spool/pending').glob('*.json')]
        self.assertIn(f'telegram:{BOT_ID}:update:5', [event['key'] for event in events])
        self.assertEqual(self.service.identify(), {'state': 'connected', 'bot_id': BOT_ID, 'username': 'synthetic_fixture_bot', 'first_name': 'Synthetic'})
        self.assertEqual(self.service.health()['state'], 'connected')
        # No command menu is left in any scope.
        wait(lambda: not self.mock.state['commands'])

    def test_polling_asks_only_for_the_updates_nocheh_reads(self):
        self.assertEqual(ALLOWED_UPDATES, ('message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query', 'message_reaction',
                                           'message_reaction_count', 'my_chat_member', 'chat_member', 'chat_join_request'))
        wait(lambda: self.mock.state['allowed_updates'] == list(ALLOWED_UPDATES))
        bot, person = {'id': int(BOT_ID), 'is_bot': True, 'first_name': 'Synthetic'}, {'id': 456, 'is_bot': False, 'first_name': 'Alice'}
        # Someone adds the bot to a group: its own membership update arrives and is archived under that group.
        added = {'update_id': 61, 'my_chat_member': {'chat': {'id': -10088, 'type': 'supergroup', 'title': 'Bakery'}, 'from': person, 'date': 1700000000,
                                                     'old_chat_member': {'user': bot, 'status': 'left'}, 'new_chat_member': {'user': bot, 'status': 'member'}}}
        inline = {'update_id': 60, 'inline_query': {'id': '1', 'from': person, 'query': 'x', 'offset': ''}}
        self.inject([inline, added])
        wait(lambda: self.mock.state['offset'] == 62)
        events = {event['key']: event for event in (json.loads(path.read_bytes()) for path in (self.root / 'spool/pending').glob('*.json'))}
        self.assertEqual(events[f'telegram:{BOT_ID}:update:61']['scope'], '-10088')
        self.assertNotIn(f'telegram:{BOT_ID}:update:60', events, 'an inline query is never asked for')

    def leaving(self):
        """The fake Telegram's leaveChat: True, or the fault queued for it."""
        original = self.mock.call
        async def call(method, data):
            status, body = await original(method, data)
            if method == 'leaveChat' and status == 400 and isinstance(body, dict) and body.get('description') == 'Bad Request: fixture method not implemented':
                return 200, {'ok': True, 'result': True}
            return status, body
        self.mock.call = call

    def test_a_leave_reaches_telegram_once_journaled_and_recorded(self):
        self.leaving()
        body = {'id': 'd' * 64, 'chat_id': '-10055'}
        self.assertEqual(self.service.leave(body), {'state': 'done'})
        self.assertEqual(self.service.leave(body), {'state': 'done'})
        leaves = lambda: [call['parameters'] for call in self.mock.state['calls'] if call['method'] == 'leaveChat']
        self.assertEqual(leaves(), [{'chat_id': '-10055'}], 'leaveChat once, for that chat alone')
        # Never a served group, under its Telegram id now or before an upgrade.
        for chat in (GROUP, NEW_TG, NEW_OLD):
            with self.subTest(chat), self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                self.service.leave({'id': 'e' * 64, 'chat_id': chat})
        self.mock.state['faults'].append({'method': 'leaveChat', 'code': 403, 'description': 'Forbidden: bot is not a member of the supergroup chat'})
        self.assertEqual(self.service.leave({'id': 'f' * 64, 'chat_id': '-10066'}), {'state': 'done'}, 'already gone')
        self.mock.state['faults'].append({'method': 'leaveChat', 'code': 400, 'description': 'Bad Request: not enough rights'})
        self.assertEqual(self.service.leave({'id': '1' * 64, 'chat_id': '-10077000'}), {'state': 'failed', 'error_code': 'telegram_refused'})
        self.assertEqual(len(leaves()), 3)
        self.assertEqual(self.sent(), [])
        # Journaled like every request that leaves, and a content-free send record says what it was.
        events = [json.loads(path.read_bytes()) for path in (self.root / 'spool/pending').glob('*.json')]
        self.assertIn(('-10055', 'leaveChat'), [(event['scope'], event['payload']['method']) for event in events if event['kind'] == 'outbound_intent'])
        records = [json.loads(path.read_bytes()) for path in (self.root / 'spool/sends').glob('*.json')]
        (record,) = [row for row in records if row['method'] == 'leaveChat' and row['chat'] == '-10055']
        self.assertEqual((record['state'], record['error_code']), ('sent', None))
        self.assertTrue(record['reference'].startswith('leave:' + 'd' * 64 + ':'))

    def test_reply_is_silent_answers_the_message_and_keeps_one_receipt(self):
        body = self.turn(1, text='**Hi** there.')
        result = self.service.reply(body)
        self.assertEqual(result['state'], 'done')
        self.assertEqual(set(result['timings']), {'telegram_send'})
        self.assertLessEqual(result['window']['delivery'], result['window']['finished'])
        (parameters,) = self.sent()
        self.assertEqual((parameters['chat_id'], parameters['parse_mode'], parameters['disable_notification']), ('123', 'MarkdownV2', 'true'))
        self.assertEqual(json.loads(parameters['reply_parameters'])['message_id'], 77)
        self.assertTrue(json.loads(parameters['link_preview_options'])['is_disabled'])
        self.assertEqual(self.mock.state['sent'][0]['message']['text'], 'Hi there.')
        # The same reply again answers from its receipt and sends nothing.
        self.assertEqual(self.service.reply(body), result)
        self.assertEqual(self.service.reply({'id': body['id'], 'observe_only': True}), result)
        self.assertEqual(len(self.sent()), 1)
        archived = [json.loads(path.read_bytes()) for path in (self.root / 'spool/pending').glob('*.json')]
        self.assertIn(('assistant_result', '**Hi** there.'), [(event['kind'], event['text']) for event in archived])

    def test_long_reply_splits_and_only_the_first_part_answers(self):
        self.service.sender.limit = 60
        result = self.service.reply(self.turn(2, text=' '.join(['word'] * 40), notify=True))
        self.assertEqual(result['state'], 'done')
        sent = self.sent()
        self.assertGreater(len(sent), 1)
        self.assertIn('reply_parameters', sent[0])
        self.assertTrue(all('reply_parameters' not in row for row in sent[1:]))
        self.assertTrue(all('disable_notification' not in row for row in sent))
        self.assertTrue(self.mock.state['sent'][0]['message']['text'].endswith(f'(1/{len(sent)})'))

    def test_general_topic_reply_has_no_thread_and_a_topic_reply_stays_in_its_topic(self):
        self.assertEqual(self.service.reply(self.turn(3, GROUP, 1, text='general'))['state'], 'done')
        self.assertEqual(self.service.reply(self.turn(4, GROUP, 7, text='topic'))['state'], 'done')
        first, second = self.sent()
        self.assertNotIn('message_thread_id', first)
        self.assertEqual(second['message_thread_id'], '7')

    def test_formatting_refusal_resends_plain_text(self):
        self.mock.state['faults'].append({'method': 'sendMessage', 'code': 400, 'description': "Bad Request: can't parse entities: x"})
        self.assertEqual(self.service.reply(self.turn(5, text='a *b*'))['state'], 'done')
        (parameters,) = self.sent()
        self.assertNotIn('parse_mode', parameters)
        self.assertEqual(parameters['text'], 'a b')

    def test_short_rate_limit_waits_and_a_long_one_stays_retryable(self):
        self.mock.state['faults'].append({'method': 'sendMessage', 'code': 429, 'description': 'Too Many Requests: retry after 1', 'parameters': {'retry_after': 1}})
        self.assertEqual(self.service.reply(self.turn(6, text='one'))['state'], 'done')
        self.mock.state['faults'].append({'method': 'sendMessage', 'code': 429, 'description': 'Too Many Requests: retry after 30', 'parameters': {'retry_after': 30}})
        result = self.service.reply(self.turn(7, text='two'))
        self.assertEqual((result['state'], result['error_stage']), ('failed', 'telegram_rate_limited'))

    def test_rejected_reply_is_terminal_and_marked_failed(self):
        self.mock.state['faults'].append({'method': 'sendMessage', 'code': 403, 'description': 'Forbidden: bot was blocked by the user'})
        result = self.service.reply(self.turn(8, text='x', presence=True))
        self.assertEqual(result['state'], 'suppressed')
        self.assertEqual(result['error_code'], 'telegram_rejected')
        wait(lambda: self.mock.state.get('reactions', {}).get('123:77') == ['👎'])

    def test_revoked_space_sends_nothing_and_records_nothing(self):
        self.allowed = False
        body = self.turn(9, text='x')
        self.assertEqual(self.service.reply(body), {'state': 'failed', 'error_code': 'space_policy_changed'})
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.service.reply({'id': body['id'], 'observe_only': True}), {'state': 'not_found'})

    def test_reply_is_bound_to_its_credential_and_bot(self):
        body = self.turn(10, text='x')
        for change in ({'chat_id': '999'}, {'archive_credential': credential(body['event_id'], GROUP, GROUP, app=binding(GROUP))},
                       {'archive_credential': credential(body['event_id'], None, OWNER)},
                       {'archive_credential': credential(body['event_id'], None, OWNER, app=binding(GROUP))},
                       {'dispatch_key': 'telegram:1:update:10'}, {'id': '0' * 64}, {'topic': 7}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.service.reply({**body, **change})
        group = self.turn(11, GROUP, 7, text='x')
        with self.assertRaises(ValueError):
            self.service.reply({**group, 'topic': 8})
        self.assertEqual(self.sent(), [])

    def answer_button(self, event, label='🔒 Answer privately'):
        # The record id Nocheh derives from the question with the service token (ADR-0249).
        return {'text': label, 'data': 'np' + hmac.new(SECRET.encode(), ('private-answer:' + event).encode(), hashlib.sha256).hexdigest()[:32]}

    def test_answer_privately_rides_only_on_the_last_part_of_its_own_group_reply(self):
        self.service.sender.limit = 60
        body = self.turn(20, GROUP, 7, text=' '.join(['word'] * 40))
        button = self.answer_button(body['event_id'])
        self.assertEqual(self.service.reply({**body, 'button': button})['state'], 'done')
        sent = self.sent()
        self.assertGreater(len(sent), 1)
        self.assertIn('reply_parameters', sent[0], 'the first part still answers the question')
        keyboard = {'inline_keyboard': [[{'callback_data': button['data'], 'text': button['text']}]]}
        self.assertEqual(json.loads(sent[-1]['reply_markup']), keyboard, 'the button sits under the whole reply')
        self.assertTrue(all('reply_markup' not in row for row in sent[:-1]))
        self.assertEqual(self.mock.state['sent'][-1]['message']['reply_markup'], keyboard)
        self.assertEqual(len(button['data'].encode()), 34, 'well inside the 64 bytes Telegram allows')

    def test_a_reply_carries_no_other_button(self):
        group = self.turn(21, GROUP, text='x')
        button = self.answer_button(group['event_id'])
        refused = {'the owner\'s private chat': {**self.turn(22, text='x'), 'button': self.answer_button(digest(f'telegram:{BOT_ID}:update:22'))},
                   'another question\'s button': {**group, 'button': self.answer_button(digest('other question'))},
                   'other data': {**group, 'button': {**button, 'data': 'na' + button['data'][2:]}},
                   'a long label': {**group, 'button': {**button, 'text': 'x' * 41}}, 'an empty label': {**group, 'button': {**button, 'text': ' '}},
                   'a link': {**group, 'button': {**button, 'url': 'https://example.com'}}, 'a list': {**group, 'button': [button]}}
        for why, body in refused.items():
            with self.subTest(why), self.assertRaisesRegex(ValueError, 'invalid_reply'):
                self.service.reply(body)
        self.assertEqual(self.sent(), [])
        # Retried with a smaller button, the reply answers from its first send's receipt.
        self.assertEqual(self.service.reply({**group, 'button': button})['state'], 'done')
        self.assertEqual(json.loads(self.sent()[0]['reply_markup'])['inline_keyboard'][0][0]['callback_data'], button['data'])

    def test_a_private_answers_pass_replies_only_in_the_owners_chat_as_that_chat(self):
        answer = 'a' * 32
        body = self.turn(23, text='Private answer')
        event = body['event_id']
        app = binding(OWNER)
        self.assertEqual(self.service.reply({**body, 'archive_credential': credential(event, OWNER, OWNER, answer=answer, app=app)})['state'], 'done')
        group = self.turn(24, GROUP, text='x')
        for why, change in {'as the owner': {'archive_credential': credential(event, None, OWNER, answer=answer, app=app)},
                            'a malformed record': {'archive_credential': credential(event, OWNER, OWNER, answer='A' * 32, app=app)},
                            'a plain pass scoped to the owner\'s chat': {'archive_credential': credential(event, OWNER, OWNER, app=app)},
                            'a pass with no app binding': {'archive_credential': credential(event, OWNER, OWNER, answer=answer)}}.items():
            with self.subTest(why), self.assertRaises(ValueError):
                self.service.reply({**body, 'id': digest(event + ':2'), 'attempt': 2, **change})
        with self.assertRaises(ValueError):
            self.service.reply({**group, 'archive_credential': credential(group['event_id'], GROUP, GROUP, answer=answer, app=binding(GROUP))})
        self.assertEqual(len(self.sent()), 1)

    def test_the_owners_turn_is_answered_only_in_the_owners_chat_never_in_a_topic_of_it(self):
        # A topic of the owner's private chat, as the app lists it: Hermes runs the owner's turns only in the chat itself,
        # so the bot refuses a pass bound there, as it did before step 2b, and nothing is shown or sent.
        topic = 'd' * 64
        self.service.policy = self.policy = Policy.of(True, OWNER, [GROUP, (NEW, NEW_TG)], {}, topics=[*TOPICS, (topic, OWNER, '3')], old={NEW: [NEW_OLD]})
        self.assertEqual(self.policy.current().binding(topic), {'app': 'telegram', 'chat': OWNER, 'topic': '3'})
        body = self.turn(25, OWNER, 3, space=topic, text='In a topic of my chat')
        for call in (self.service.presence, self.service.reply):
            with self.subTest(call.__name__), self.assertRaises(ValueError):
                call(body)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.service.reply(self.turn(26, text='In my chat'))['state'], 'done')

    def test_presence_shows_typing_and_eyes_then_thumbs_up(self):
        body = self.turn(12, GROUP, 1, text='done')
        self.assertEqual(self.service.presence(body), {'state': 'shown'})
        wait(lambda: self.mock.state.get('reactions', {}).get('-10042:77') == ['👀'])
        wait(lambda: any(call['method'] == 'sendChatAction' for call in self.mock.state['calls']))
        typing = next(call for call in self.mock.state['calls'] if call['method'] == 'sendChatAction')
        # Typing keeps the General topic's id; the reply below does not.
        self.assertEqual(str(typing['parameters']['message_thread_id']), '1')
        self.assertEqual(self.service.presence(body), {'state': 'shown'})
        self.assertEqual(self.service.reply({**body, 'presence': True})['state'], 'done')
        wait(lambda: self.mock.state['reactions']['-10042:77'] == ['👍'])
        self.assertNotIn(body['id'], self.service.presences)

    def test_presence_expires_and_clears_its_reaction(self):
        body = self.turn(13)
        with patch('services.telegram.gateway.PRESENCE_TTL', 0.1):
            self.service.presence(body)
            wait(lambda: self.mock.state.get('reactions', {}).get('123:77') == ['👀'])
            wait(lambda: self.mock.state['reactions']['123:77'] == [], 10)

    def test_presence_off_when_owner_turned_both_off(self):
        self.service.typing_on = self.service.reactions_on = False
        self.assertEqual(self.service.presence(self.turn(14)), {'state': 'off'})

    def test_cancelled_reply_sends_nothing(self):
        body = self.turn(15, text='x')
        started = threading.Event()
        original = self.service.sender.send
        async def slow(*args, **kwargs):
            started.set(); await asyncio.sleep(0.5); return await original(*args, **kwargs)
        self.service.sender.send = slow
        result = {}
        thread = threading.Thread(target=lambda: result.update(self.service.reply(body))); thread.start()
        started.wait(5)
        self.service.reply({'id': body['id'], 'cancel': True})
        thread.join(10)
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual(self.sent(), [])

    def test_empty_reply_is_intentional_silence(self):
        self.assertEqual(self.service.reply(self.turn(16, text='  ')), {'state': 'suppressed', 'error_code': 'intentional_silence'})
        self.assertEqual(self.sent(), [])

    def test_a_group_first_seen_after_step_2b_is_answered_where_it_is_now(self):
        # Its pass names the chat by its digest id; the bot sends to the Telegram id the chat has now, in its topic.
        topic = self.turn(30, NEW_TG, 5, scope=NEW, space='c' * 64, text='new topic')
        self.assertEqual(self.service.reply(topic)['state'], 'done')
        self.assertEqual(self.service.reply(self.turn(31, NEW_TG, scope=NEW, space=NEW, text='new group'))['state'], 'done')
        first, second = self.sent()
        self.assertEqual((first['chat_id'], first['message_thread_id'], second['chat_id']), (NEW_TG, '5', NEW_TG))
        refused = {'its old Telegram id': self.turn(32, NEW_OLD, scope=NEW, space=NEW, text='x'),
                   'a topic of another chat': self.turn(33, NEW_TG, 7, scope=NEW, space=GROUP + '/topic/7', text='x'),
                   'a space outside its scope': self.turn(34, GROUP, scope=NEW, space=GROUP, text='x'),
                   'a topic with no row': self.turn(35, NEW_TG, 9, scope=NEW, space='d' * 64, text='x'),
                   'an unserved chat': self.turn(36, '-10099', text='x')}
        for why, body in refused.items():
            with self.subTest(why), self.assertRaises(ValueError):
                self.service.reply(body)
        self.assertEqual(len(self.sent()), 2)

    def test_a_topic_recorded_after_the_list_was_read_is_answered_on_its_first_turn(self):
        # A new forum topic moves no guard epoch (ADR-0252): the list held since before it was recorded is read again (at
        # most once a second) when a pass names a space it does not hold, instead of refusing until the list ages out.
        from services.chats import Served, ServedList
        before = served_policy().current()
        after = Served.of(OWNER, groups=[GROUP, (NEW, NEW_TG)], topics=[*TOPICS, ('e' * 64, NEW, '11')], old={NEW: [NEW_OLD]})
        reads, now = [], [0.0]
        class Response:
            def __init__(self, served): self.served = served
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size):
                return json.dumps({'epoch': self.served.epoch, 'owner_chat': self.served.owner_chat, 'owner_account': self.served.owner_account,
                                   'chats': list(self.served.chats.values())}).encode()
        def opener(request, timeout):
            reads.append(request.full_url)
            return Response(before if len(reads) == 1 else after)
        self.service.policy = Policy(True, {}, ServedList('http://app.test', SECRET, opener=opener, clock=lambda: now[0]))
        self.assertEqual(self.service.reply(self.turn(40, NEW_TG, scope=NEW, space=NEW, text='before'))['state'], 'done')
        now[0] = 2.0
        self.assertEqual(self.service.reply(self.turn(41, NEW_TG, 11, scope=NEW, space='e' * 64, text='first in topic'))['state'], 'done')
        self.assertEqual(len(reads), 2)
        self.assertEqual((self.sent()[-1]['chat_id'], self.sent()[-1]['message_thread_id']), (NEW_TG, '11'))
        # One the app does not hold is still refused, and the list is not read again within a second.
        for number in (42, 43):
            with self.assertRaises(ValueError):
                self.service.reply(self.turn(number, NEW_TG, 12, scope=NEW, space='f' * 64, text='x'))
        self.assertEqual(len(reads), 2)
        now[0] = 3.5
        with self.assertRaises(ValueError):
            self.service.reply(self.turn(44, NEW_TG, 12, scope=NEW, space='f' * 64, text='x'))
        self.assertEqual(len(reads), 3)

    def test_a_failed_served_list_serves_nothing(self):
        from services.chats import ServedList
        failing = ServedList('http://127.0.0.1:9', SECRET, opener=lambda *_args, **_kw: (_ for _ in ()).throw(OSError('down')))
        self.service.policy = Policy(True, {}, failing)
        with self.assertRaises(ValueError):
            self.service.reply(self.turn(37, text='x'))
        self.assertEqual(self.sent(), [])

    def test_approved_action_notifies_and_answers_once(self):
        body = {'id': 'a' * 64, 'destination': GROUP + '/topic/7', 'chat_id': GROUP, 'topic': '7', 'text': 'Team update'}
        self.assertEqual(self.service.action(body), {'state': 'done'})
        self.assertEqual(self.service.action(body), {'state': 'done'})
        (parameters,) = self.sent()
        self.assertEqual(parameters['message_thread_id'], '7')
        self.assertNotIn('disable_notification', parameters)
        self.allowed = False
        self.assertEqual(self.service.action({**body, 'id': 'b' * 64}), {'state': 'denied'})
        # A send names its Telegram chat and topic itself; one without them is refused before anything is recorded.
        for change in ({'chat_id': None}, {'chat_id': 'x'}, {'topic': 'seven'}, {'destination': ''}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'invalid_action'):
                self.service.action({**body, 'id': 'c' * 64, **change})

    def test_restart_marks_unfinished_sends_ambiguous(self):
        receipts = self.root / 'spool/dispatch'
        (receipts / ('reply-' + 'c' * 64 + '.intent')).write_text('{}')
        TelegramService(self.policy, TOKEN, self.root / 'spool', self.root / 'state')
        self.assertEqual(json.loads((receipts / ('reply-' + 'c' * 64 + '.result')).read_text())['state'], 'ambiguous')


class PolicyTests(unittest.TestCase):
    def test_group_access_holds_under_any_id_a_group_has_had(self):
        for bad in ({GROUP: {'granted': ['x'], 'denied': []}}, {GROUP: {'granted': ['0456'], 'denied': []}}, {GROUP: {'granted': []}}, {'': {'granted': [], 'denied': []}}):
            with self.assertRaisesRegex(ValueError, 'invalid_group_access'): served_policy(access=bad)
        policy = served_policy(access={NEW_OLD: {'granted': ['456', '789'], 'denied': []}, NEW_TG: {'granted': [], 'denied': ['789']}})
        served = policy.current()
        # Granted before the upgrade still counts; a denial under any id wins.
        self.assertTrue(policy.access(served, NEW, '456'))
        self.assertFalse(policy.access(served, NEW, '789'))
        self.assertFalse(policy.access(served, GROUP, '456'))

    def test_the_served_list_is_read_again_on_a_newer_epoch_and_fails_closed(self):
        from services.chats import Served, ServedList
        reads, now = [], [0.0]
        class Response:
            def __init__(self, payload): self.payload = payload
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size): return json.dumps(self.payload).encode()
        def opener(request, timeout):
            reads.append(request.full_url)
            if len(reads) == 3: raise OSError('down')
            return Response({'epoch': len(reads), 'owner_chat': OWNER, 'owner_account': {'app': 'telegram', 'external': OWNER},
                             'chats': [{'id': OWNER, 'app': 'telegram', 'kind': 'private', 'parent_id': None, 'topic_key': None, 'state': 'active',
                                        'app_ids': [{'external': OWNER, 'state': 'current'}]}]})
        listed = ServedList('http://app.test', SECRET, opener=opener, clock=lambda: now[0])
        self.assertEqual(listed.get().owner_external(), OWNER)
        self.assertEqual(reads, ['http://app.test/internal/chats'])
        self.assertEqual(listed.get(epoch=1).epoch, 1, 'the same epoch reads nothing again')
        now[0] = 1.5
        self.assertEqual(listed.get(epoch=2).epoch, 2, 'a newer epoch reads the list again')
        now[0] = 9.0
        self.assertIsNone(listed.get().owner_external(), 'a failed read serves nothing')
        now[0] = 9.5
        self.assertEqual(len(reads), 3, 'a failed read is tried again at most once a second')
        self.assertIsNone(listed.get().owner_external())
        now[0] = 10.5
        self.assertEqual(listed.get().epoch, 4)
        for bad in ({'chats': [{'id': 'x'}]}, {'epoch': -1}, {'chats': [{'id': 't', 'app': 'telegram', 'kind': 'topic', 'parent_id': 'missing', 'topic_key': '1',
                                                                      'state': 'active', 'app_ids': []}]}):
            with self.assertRaises(ValueError): Served(bad)


class DisabledTests(unittest.TestCase):
    def test_disabled_service_polls_and_sends_nothing(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'SERVICE_TOKEN': SECRET}):
            service = TelegramService(Policy.of(False, None, [], {}), TOKEN, Path(directory) / 'spool', Path(directory) / 'state')
            service.start()
            self.assertEqual(service.health()['state'], 'disabled')
            self.assertEqual(service.identify(), {'state': 'disabled'})
            self.assertIsNone(service.loop)
            missing = TelegramService(Policy.of(True, OWNER, [], {}), '', Path(directory) / 'spool', Path(directory) / 'state')
            self.assertEqual(missing.health()['state'], 'credentials_missing')


if __name__ == '__main__':
    unittest.main()
