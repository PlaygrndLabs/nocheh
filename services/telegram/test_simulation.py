"""Synthetic Bot API scenarios through the Telegram library and the Telegram service.

Only Telegram's transport is scripted. Formatting, chunking, the checks on every request,
durable capture and receipts are real.
Contract: https://core.telegram.org/bots/api#getupdates, #sendmessage and #setmessagereaction.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from telegram.ext import ExtBot
from telegram.request import BaseRequest

from services.durable import canonical, digest
from services.telegram.capture import Capture, instrument_request
from services.telegram.checks import reaction_check
from services.telegram.gateway import TelegramService
from services.telegram.sender import Sender
from services.telegram.settings import Policy, reactions_enabled, typing_enabled


class TelegramSimulationRequest(BaseRequest):
    """Documented JSON envelopes; no sockets, real bot token or Telegram traffic."""
    def __init__(self):
        self.calls = []
        self.delivered = []
        self.updates = []
        self.respond = None

    @property
    def read_timeout(self):
        return 1

    async def initialize(self):
        pass

    async def shutdown(self):
        pass

    async def do_request(self, url, method, request_data=None, **kwargs):
        operation = url.rsplit('/', 1)[-1]
        data = dict(request_data.parameters) if request_data else {}
        self.calls.append((operation, data))
        if operation == 'getMe':
            result = {'id': 123456, 'is_bot': True, 'first_name': 'Synthetic', 'username': 'synthetic_fixture_bot'}
        elif operation == 'getUpdates':
            offset = data.get('offset', 0)
            self.updates = [u for u in self.updates if u['update_id'] >= offset]
            result = self.updates[:data.get('limit', 100)]
        elif operation == 'sendMessage':
            if self.respond:
                response = self.respond(data)
                if response is not None:
                    return response
            self.delivered.append(data)
            result = {'message_id': 1000 + len(self.delivered), 'date': 1700000000,
                      'chat': {'id': int(data['chat_id']), 'type': 'supergroup'}, 'text': data['text']}
            if 'message_thread_id' in data:
                result['message_thread_id'] = data['message_thread_id']
        elif operation in ('sendChatAction', 'setMessageReaction'):
            result = True
        else:
            raise AssertionError('Unmodeled Telegram method: ' + operation)
        return 200, canonical({'ok': True, 'result': result})


class TelegramSimulationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.secret = 'synthetic-simulation-service-token'
        env = patch.dict(os.environ, {'SERVICE_TOKEN': self.secret, 'TELEGRAM_TYPING': 'false', 'TELEGRAM_REACTIONS': 'false'})
        env.start()
        self.addCleanup(env.stop)
        self.allowed = True
        policy_check = patch('services.telegram.gateway.check_delivery_policy', side_effect=lambda _credential: self.allowed)
        policy_check.start()
        self.addCleanup(policy_check.stop)
        self.policy = Policy(True, '123', ['-20'], {'-20': {'granted': ['456'], 'denied': []}})
        self.capture = Capture(self.root / 'spool', '123456')
        self.request, self.polling = TelegramSimulationRequest(), TelegramSimulationRequest()
        instrument_request(self.request, self.capture)
        instrument_request(self.polling, self.capture, polling=True)
        self.bot = ExtBot('123456:synthetic', request=self.request, get_updates_request=self.polling)
        await self.bot.initialize()
        self.addAsyncCleanup(self.bot.shutdown)
        self.answer = 'پاسخ مصنوعی برای بررسی مسیر ارسال'
        self.gateway = self.new_gateway()

    def new_gateway(self):
        """A freshly started service over the same spool, as after a restart."""
        gateway = TelegramService(self.policy, '123456:synthetic', self.root / 'spool', self.root / 'state')
        gateway.status, gateway.bot, gateway.capture = 'connected', self.bot, self.capture
        gateway.sender = Sender(self.bot, pace=0)
        gateway.action_lock = asyncio.Lock()
        gateway.typing_on = getattr(self, 'typing', False)
        gateway.reactions_on = getattr(self, 'reacting', False)
        return gateway

    def envelope(self, identifier=1, topic=17, attempt=1, text=None, presence=None):
        source_key = f'telegram:123456:update:{identifier}'
        event_id = digest(source_key)
        claims = {'scope': '-20', 'space': '-20' if topic is None else f'-20/topic/{topic}',
                  'revision': 1, 'event_id': event_id, 'expires': time.time() * 1000 + 600000,
                  'audience': 'nocheh-assistant'}
        body = base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
        signature = base64.urlsafe_b64encode(hmac.new(self.secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        return {'id': digest(event_id + ':' + str(attempt)), 'event_id': event_id, 'attempt': attempt, 'dispatch_key': source_key,
                'chat_id': '-20', 'topic': topic, 'reply_to': str(identifier), 'message_id': str(identifier),
                'text': self.answer if text is None else text, 'session_id': 'synthetic', 'notify': False,
                'presence': bool(self.gateway.reactions_on or self.gateway.typing_on) if presence is None else presence,
                'archive_credential': f'turn.{body}.{signature}'}

    def update(self, identifier=1, topic=17):
        message = {'message_id': identifier, 'date': 1700000000,
                   'chat': {'id': -20, 'type': 'supergroup', 'is_forum': True},
                   'from': {'id': 456, 'is_bot': False, 'first_name': 'Synthetic'}, 'text': 'پیام مصنوعی'}
        if topic is not None:
            message.update(message_thread_id=topic, is_topic_message=True)
        return {'update_id': identifier, 'message': message}

    async def deliver(self, envelope, gateway=None, work=0.0):
        """Show presence while the brain works for ``work`` seconds, then deliver the reply; the outcome only."""
        gateway = gateway or self.gateway
        chat, topic, message, credential = gateway._turn(envelope)
        if envelope.get('presence') and gateway.connected() and (gateway.typing_on or gateway.reactions_on):
            await gateway._start(envelope['id'], chat, topic, message, credential)
            await asyncio.sleep(work)
        result = await gateway._reply(envelope['id'], envelope, chat, topic, message, credential)
        return {key: value for key, value in result.items() if key not in ('timings', 'window')}

    async def brain_ended(self, envelope, finish, work=0.0):
        """The brain's turn ended without a reply: presence is finished as Nocheh's core does."""
        chat, topic, message, credential = self.gateway._turn(envelope)
        await self.gateway._start(envelope['id'], chat, topic, message, credential)
        await asyncio.sleep(work)
        await self.gateway._finish(envelope['id'], chat, message, credential, finish)

    async def test_polling_duplicates_are_durable_before_delivery_and_offsets_acknowledge(self):
        envelope = self.envelope()
        self.polling.updates = [self.update()]
        for _ in range(2):
            updates = await self.bot.get_updates(allowed_updates=['message', 'message_reaction', 'message_reaction_count'])
            self.assertEqual(len(updates), 1)
            captured = self.root / 'spool/pending' / (envelope['event_id'] + '.json')
            self.assertEqual(json.loads(captured.read_bytes())['payload'], self.update())
        self.assertEqual(await self.deliver(envelope), {'state': 'done'})
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(await self.bot.get_updates(offset=2), ())

    async def test_missing_topic_never_delivers_a_topic_answer_in_general(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message thread not found'})) if data.get('message_thread_id') else None
        result = await self.deliver(self.envelope())
        self.assertEqual(result, {'state': 'suppressed', 'error_code': 'telegram_rejected'})
        self.assertEqual(self.request.delivered, [], 'a reply never widens its audience to General')

    async def test_general_forum_message_replies_in_general(self):
        self.assertEqual(await self.deliver(self.envelope(topic=None)), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertIn(self.request.delivered[0].get('message_thread_id'), (None, 1))

    async def test_approved_action_preserves_exact_topic_and_receipt_after_restart(self):
        body = {'id': 'b' * 64, 'destination': '-20/topic/17', 'text': 'پیگیری تأییدشدهٔ مصنوعی'}
        with patch('services.telegram.gateway.check_action_policy', return_value=True):
            self.assertEqual(await self.gateway.send_action(body), {'state': 'done'})
            self.assertEqual(await self.new_gateway().send_action(body), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(str(self.request.delivered[0]['chat_id']), '-20')
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_long_approved_memory_wording_keeps_every_chunk_in_its_topic(self):
        text = 'اطلاعات تأییدشدهٔ مصنوعی برای پیگیری حافظه 🌿\n' * 150
        self.assertGreater(len(text), 4096)
        self.assertLessEqual(len(text.encode('utf-16-le')) // 2, 12000)
        body = {'id': 'd' * 64, 'destination': '-20/topic/17', 'text': text}
        with patch('services.telegram.gateway.check_action_policy', return_value=True):
            self.assertEqual(await self.gateway.send_action(body), {'state': 'done'})
            count = len(self.request.delivered)
            self.assertGreater(count, 1)
            self.assertEqual(await self.new_gateway().send_action(body), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), count)
        self.assertTrue(all(str(d['chat_id']) == '-20' and d.get('message_thread_id') == 17 for d in self.request.delivered))
        self.assertEqual(sum(d['text'].count('اطلاعات تأییدشدهٔ مصنوعی برای پیگیری حافظه 🌿') for d in self.request.delivered), 150)

    async def test_oversized_approved_wording_is_rejected_before_any_request(self):
        before = len(self.request.calls)
        with self.assertRaises(ValueError):
            await self.gateway.send_action({'id': 'e' * 64, 'destination': '-20/topic/17', 'text': '🌿' * 6001})
        self.assertEqual(len(self.request.calls), before)
        self.assertEqual(self.request.delivered, [])

    async def test_explicit_general_topic_uses_the_general_send_convention(self):
        self.assertEqual(await self.deliver(self.envelope(topic=1)), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertIsNone(self.request.delivered[0].get('message_thread_id'))

    async def test_approved_topic_action_never_falls_back_to_general(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message thread not found'})) if data.get('message_thread_id') else None
        body = {'id': 'c' * 64, 'destination': '-20/topic/17', 'text': 'Synthetic approved topic follow-up'}
        with patch('services.telegram.gateway.check_action_policy', return_value=True):
            self.assertEqual(await self.gateway.send_action(body), {'state': 'ambiguous'})
            self.assertEqual(await self.new_gateway().send_action(body), {'state': 'ambiguous'})
        self.assertEqual(self.request.delivered, [])

    async def test_revocation_between_chunks_prevents_every_later_physical_send(self):
        self.answer = 'پاسخ بلند مصنوعی 🌿 ' * 600
        def revoke_after_first(data):
            self.allowed = False
        self.request.respond = revoke_after_first
        envelope = self.envelope()
        result = await self.deliver(envelope)
        self.assertNotEqual(result['state'], 'done')
        self.assertEqual(len(self.request.delivered), 1, 'only the chunk authorized before revocation can leave')
        self.allowed = True
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), result)
        self.assertEqual(len(self.request.delivered), 1, 'partial delivery cannot be replayed after restart')

    async def test_long_persian_emoji_reply_keeps_its_topic_and_replays_no_chunks(self):
        self.answer = 'یک پاسخ بلند با ایموجی 🌿 و جزئیات مصنوعی\n' * 350
        envelope = self.envelope()
        self.assertEqual(await self.deliver(envelope), {'state': 'done'})
        self.assertGreater(len(self.request.delivered), 1)
        self.assertTrue(all(d.get('message_thread_id') == 17 for d in self.request.delivered))
        before = len(self.request.delivered)
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), before)

    async def test_markdown_rejection_falls_back_within_same_topic_only(self):
        self.answer = '**پاسخ مصنوعی**'
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': "Bad Request: can't parse entities"})) if data.get('parse_mode') else None
        self.assertEqual(await self.deliver(self.envelope()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_uncertain_server_failure_is_not_repeated_after_restart(self):
        self.request.respond = lambda data: (500, canonical({'ok': False, 'error_code': 500, 'description': 'Synthetic server failure'}))
        envelope = self.envelope()
        result = await self.deliver(envelope)
        self.assertEqual(result['state'], 'ambiguous')
        before = len([c for c in self.request.calls if c[0] == 'sendMessage'])
        self.assertEqual(before, 1)
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), result)
        self.assertEqual(len([c for c in self.request.calls if c[0] == 'sendMessage']), before)

    async def test_rate_limit_rejection_recovers_without_duplicate_delivery(self):
        rejected = False
        def rate_limit(data):
            nonlocal rejected
            if not rejected:
                rejected = True
                return 429, canonical({'ok': False, 'error_code': 429,
                    'description': 'Too Many Requests: retry after 1', 'parameters': {'retry_after': 1}})
        self.request.respond = rate_limit
        envelope = self.envelope()
        self.assertEqual(await self.deliver(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(len([c for c in self.request.calls if c[0] == 'sendMessage']), 2)
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)

    async def test_cancel_between_chunks_keeps_partial_delivery_without_later_sends(self):
        self.answer = 'Synthetic long answer for cancellation. ' * 350
        envelope = self.envelope()
        self.request.respond = lambda data: self.gateway.cancels[envelope['id']].set()
        result = await self.deliver(envelope)
        self.assertEqual(result['state'], 'ambiguous', 'an earlier transmitted chunk cannot be called cancelled')
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(await self.deliver(envelope, self.new_gateway()), result)
        self.assertEqual(len(self.request.delivered), 1)

    async def test_revocation_during_rate_limit_wait_blocks_the_retry(self):
        def revoke_and_reject(data):
            self.allowed = False
            return 429, canonical({'ok': False, 'error_code': 429,
                'description': 'Too Many Requests: retry after 1', 'parameters': {'retry_after': 1}})
        self.request.respond = revoke_and_reject
        result = await self.deliver(self.envelope())
        self.assertNotEqual(result['state'], 'done')
        self.assertEqual(self.request.delivered, [])
        self.assertEqual(len([c for c in self.request.calls if c[0] == 'sendMessage']), 1)

    async def test_deleted_reply_anchor_may_change_without_changing_topic(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message to be replied not found'})) if data.get('reply_parameters') else None
        self.assertEqual(await self.deliver(self.envelope()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_action_revocation_between_chunks_prevents_further_sends(self):
        approved = True
        self.gateway.sender.limit = 80
        def revoke(data):
            nonlocal approved
            approved = False
        self.request.respond = revoke
        body = {'id': 'a' * 64, 'destination': '-20', 'text': 'Synthetic approved message. ' * 20}
        with patch('services.telegram.gateway.check_action_policy', side_effect=lambda action: approved):
            result = await self.gateway.send_action(body)
            self.assertEqual(result['state'], 'ambiguous')
            self.assertEqual(len(self.request.delivered), 1)
            self.assertEqual(await self.new_gateway().send_action(body), result)
            self.assertEqual(len(self.request.delivered), 1)

    def chat_actions(self):
        return [data for operation, data in self.request.calls if operation == 'sendChatAction']

    async def test_working_turn_shows_typing_in_its_own_topic_until_the_reply(self):
        self.gateway.typing_on = True
        with patch('services.telegram.gateway.TYPING_INTERVAL', 0.05):
            self.assertEqual(await self.deliver(self.envelope(), work=0.3), {'state': 'done'})
            await asyncio.sleep(0.2)
        actions = self.chat_actions()
        self.assertGreaterEqual(len(actions), 3, 'typing is renewed while the turn works')
        self.assertTrue(all(str(a['chat_id']) == '-20' and a['message_thread_id'] == 17 and a['action'] == 'typing' for a in actions))
        operations = [operation for operation, _ in self.request.calls if operation in ('sendChatAction', 'sendMessage')]
        self.assertEqual(operations[-1], 'sendMessage', 'no typing after the reply, it would show again')
        journal = b''.join(path.read_bytes() for path in (self.root / 'spool/outbound').glob('*'))
        self.assertNotIn(b'sendChatAction', journal, 'typing adds no delivery records')
        self.assertIn(b'sendMessage', journal)

    async def test_typing_stops_when_the_turn_fails_or_authority_is_gone(self):
        self.gateway.typing_on = True
        with patch('services.telegram.gateway.TYPING_INTERVAL', 0.05):
            await self.brain_ended(self.envelope(), 'failed', work=0.3)
            count = len(self.chat_actions())
            self.assertGreater(count, 0)
            await asyncio.sleep(0.2)
            self.assertEqual(len(self.chat_actions()), count, 'a failed turn stops typing')
            self.allowed = False
            await self.deliver(self.envelope(identifier=2), work=0.3)
        self.assertEqual(len(self.chat_actions()), count, 'a revoked space sees no typing')
        self.assertEqual(self.request.delivered, [])

    async def test_no_typing_when_switched_off(self):
        with patch('services.telegram.gateway.TYPING_INTERVAL', 0.02):
            self.assertEqual(await self.deliver(self.envelope(presence=True), work=0.1), {'state': 'done'})
        self.assertEqual(self.chat_actions(), [])
        self.assertEqual(len(self.request.delivered), 1)

    def test_typing_setting_defaults_on_and_rejects_malformed_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(typing_enabled())
        with patch.dict(os.environ, {'TELEGRAM_TYPING': 'false'}):
            self.assertFalse(typing_enabled())
        with patch.dict(os.environ, {'TELEGRAM_TYPING': 'off'}), self.assertRaises(ValueError):
            typing_enabled()

    async def test_a_chat_action_outside_a_turn_is_refused_before_any_request(self):
        with self.assertRaisesRegex(Exception, 'telegram_chat_action_unbound'):
            await self.bot.send_chat_action(chat_id=-20, action='typing', message_thread_id=17)
        self.assertEqual(self.chat_actions(), [])

    def reactions(self):
        return [(str(data['chat_id']), data['message_id'], [item['emoji'] for item in data.get('reaction', [])])
                for operation, data in self.request.calls if operation == 'setMessageReaction']

    async def test_working_turn_reacts_on_its_own_message_around_the_reply(self):
        self.gateway.reactions_on = True
        self.assertEqual(await self.deliver(self.envelope(), work=0.05), {'state': 'done'})
        self.assertEqual(self.reactions(), [('-20', 1, ['\U0001f440']), ('-20', 1, ['\U0001f44d'])])
        operations = [operation for operation, _ in self.request.calls if operation in ('setMessageReaction', 'sendMessage')]
        self.assertEqual(operations, ['setMessageReaction', 'sendMessage', 'setMessageReaction'], '👀 before the reply, 👍 after it')
        journal = b''.join(path.read_bytes() for path in (self.root / 'spool/outbound').glob('*'))
        self.assertNotIn(b'setMessageReaction', journal, 'working reactions add no delivery records')

    async def test_a_failed_turn_shows_thumbs_down_and_its_retry_works_again(self):
        self.gateway.reactions_on = True
        await self.brain_ended(self.envelope(), 'failed', work=0.01)
        self.assertEqual(self.reactions(), [('-20', 1, ['\U0001f440']), ('-20', 1, ['\U0001f44e'])])
        # The retry's 👀 is the same request as the first one; it is sent, not answered from the journal.
        self.assertEqual(await self.deliver(self.envelope(attempt=2), work=0.01), {'state': 'done'})
        self.assertEqual(self.reactions()[2:], [('-20', 1, ['\U0001f440']), ('-20', 1, ['\U0001f44d'])])
        self.assertEqual(len(self.request.delivered), 1)

    async def test_silence_and_cancellation_clear_the_working_reaction(self):
        self.gateway.reactions_on = True
        self.assertEqual(await self.deliver(self.envelope(text=''), work=0.01), {'state': 'suppressed', 'error_code': 'intentional_silence'})
        await self.brain_ended(self.envelope(identifier=2), 'clear', work=0.01)
        self.assertEqual(self.reactions(), [('-20', 1, ['\U0001f440']), ('-20', 1, []), ('-20', 2, ['\U0001f440']), ('-20', 2, [])])
        self.assertEqual(self.request.delivered, [])

    async def test_an_uncertain_delivery_clears_the_working_reaction(self):
        # Telegram may have shown the reply even though its answer was lost, so no 👎.
        self.gateway.reactions_on = True
        self.request.respond = lambda data: (502, b'Bad Gateway')
        result = await self.deliver(self.envelope(), work=0.01)
        self.assertEqual(result['state'], 'ambiguous')
        self.assertEqual(self.reactions(), [('-20', 1, ['\U0001f440']), ('-20', 1, [])])

    async def test_no_reaction_when_switched_off_or_revoked(self):
        self.assertEqual(await self.deliver(self.envelope(presence=True), work=0.01), {'state': 'done'})
        self.gateway.reactions_on = True
        self.allowed = False
        self.assertNotEqual((await self.deliver(self.envelope(identifier=4), work=0.01))['state'], 'done')
        self.assertEqual(self.reactions(), [], 'a revoked space gets no reaction either')
        self.assertEqual(len(self.request.delivered), 1)

    async def test_a_reaction_outside_a_turn_is_refused_before_any_request(self):
        with self.assertRaisesRegex(Exception, 'telegram_reaction_unbound'):
            await self.bot.set_message_reaction(chat_id=-20, message_id=1, reaction='\U0001f440')
        self.assertEqual(self.reactions(), [])

    def test_reaction_check_binds_the_exact_message_and_the_working_emoji(self):
        allowed = [True]
        check = reaction_check(-20, 7, lambda: allowed[0])
        emoji = lambda value: [{'type': 'emoji', 'emoji': value}]
        for reaction in ('\U0001f440', '\U0001f44d', '\U0001f44e'):
            check('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': emoji(reaction)})
        check('setMessageReaction', {'chat_id': '-20', 'message_id': 7})
        for method, parameters in (
                ('setMessageReaction', {'chat_id': -20, 'message_id': 8, 'reaction': emoji('\U0001f44d')}),
                ('setMessageReaction', {'chat_id': -21, 'message_id': 7, 'reaction': emoji('\U0001f44d')}),
                ('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': emoji('\U0001f525')}),
                ('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': emoji('\U0001f44d') * 2}),
                ('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': emoji('\U0001f44d'), 'is_big': True}),
                ('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': [{'type': 'custom_emoji', 'custom_emoji_id': '1'}]}),
                ('sendMessage', {'chat_id': -20, 'text': 'x'})):
            with self.assertRaisesRegex(RuntimeError, 'audience_changed', msg=str(parameters)):
                check(method, parameters)
        allowed[0] = False
        with self.assertRaisesRegex(RuntimeError, 'authority_revoked'):
            check('setMessageReaction', {'chat_id': -20, 'message_id': 7})

    def test_reaction_setting_defaults_on_and_rejects_malformed_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(reactions_enabled())
        with patch.dict(os.environ, {'TELEGRAM_REACTIONS': 'false'}):
            self.assertFalse(reactions_enabled())
        with patch.dict(os.environ, {'TELEGRAM_REACTIONS': 'off'}), self.assertRaises(ValueError):
            reactions_enabled()


if __name__ == '__main__':
    unittest.main()
