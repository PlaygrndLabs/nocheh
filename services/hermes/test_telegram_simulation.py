"""Synthetic Bot API scenarios through the pinned PTB and Hermes adapter.

Only Telegram's transport and the model answer are scripted. Native formatting,
batching, scope resolution, durable capture, dispatch and receipts are real.
Contract: https://core.telegram.org/bots/api#getupdates and #sendmessage.
"""
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

from gateway.config import PlatformConfig
from telegram.ext import Application, ExtBot
from telegram.request import BaseRequest

from services.hermes.assistant_gateway import AssistantGateway, TURN, committed_adapter_class
from services.hermes.capture import canonical, digest, instrument_request
from services.hermes.scopes import Scopes


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
        elif operation == 'sendChatAction':
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
        env = patch.dict(os.environ, {'NOCHEH_SPOOL_DIR': str(self.root / 'spool'),
                                     'SERVICE_TOKEN': self.secret})
        env.start()
        self.addCleanup(env.stop)
        self.allowed = True
        policy_check = patch('services.hermes.assistant_gateway.check_delivery_policy',
                             side_effect=lambda _credential: self.allowed)
        policy_check.start()
        self.addCleanup(policy_check.stop)
        self.policy = Scopes({'enabled': True, 'owner_id': '123', 'group_ids': ['-20'],
                              'group_access': {'-20': {'granted': ['456'], 'denied': []}}})
        self.adapter = committed_adapter_class()(PlatformConfig(
            enabled=True, token='123456:synthetic', typing_indicator=False))
        self.request, self.polling = TelegramSimulationRequest(), TelegramSimulationRequest()
        instrument_request(self.request, self.adapter.capture)
        instrument_request(self.polling, self.adapter.capture, polling=True)
        self.bot = ExtBot('123456:synthetic', request=self.request, get_updates_request=self.polling)
        self.app = Application.builder().bot(self.bot).build()
        await self.app.initialize()
        self.addAsyncCleanup(self.app.shutdown)
        self.adapter._app = self.app
        self.adapter._bot = self.bot
        self.adapter._text_batch_delay_seconds = 0.001
        self.adapter._register_handlers(self.app)
        self.answer = 'پاسخ مصنوعی برای بررسی مسیر ارسال'
        self.handled = []

        async def answer(event):
            self.handled.append(event)
            TURN.get()['agent_result'] = {'state': 'done', 'text': self.answer, 'session_id': 'synthetic'}
            return self.answer

        self.adapter.set_message_handler(answer)
        self.gateway = self.new_gateway()

    def new_gateway(self):
        gateway = AssistantGateway(self.root, self.root / 'spool', self.policy,
                                   '123456:synthetic', 'synthetic', lambda: None)
        gateway.status = 'connected'
        gateway.adapter = self.adapter
        gateway.lock = asyncio.Lock()
        gateway.action_lock = asyncio.Lock()
        return gateway

    def envelope(self, identifier=1, topic=17):
        source_key = f'telegram:123456:update:{identifier}'
        event_id = digest(source_key)
        claims = {'scope': '-20', 'space': '-20' if topic is None else f'-20/topic/{topic}',
                  'revision': 1, 'event_id': event_id, 'expires': time.time() * 1000 + 600000,
                  'audience': 'nocheh-assistant'}
        body = base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
        signature = base64.urlsafe_b64encode(hmac.new(self.secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        message = {'message_id': identifier, 'date': 1700000000,
                   'chat': {'id': -20, 'type': 'supergroup', 'is_forum': True},
                   'from': {'id': 456, 'is_bot': False, 'first_name': 'Synthetic'}, 'text': 'پیام مصنوعی'}
        if topic is not None:
            message.update(message_thread_id=topic, is_topic_message=True)
        return {'event_id': event_id, 'source_key': source_key, 'scope': '-20', 'attempt': 1,
                'archive_credential': f'turn.{body}.{signature}',
                'payload': {'update_id': identifier, 'message': message}}

    async def test_polling_duplicates_are_durable_before_dispatch_and_offsets_acknowledge(self):
        envelope = self.envelope()
        self.polling.updates = [envelope['payload']]
        for _ in range(2):
            updates = await self.bot.get_updates(allowed_updates=['message', 'message_reaction', 'message_reaction_count'])
            self.assertEqual(len(updates), 1)
            captured = self.root / 'spool/pending' / (envelope['event_id'] + '.json')
            self.assertEqual(json.loads(captured.read_bytes())['payload'], envelope['payload'])
        self.assertEqual(await self.gateway.dispatch(envelope), {'state': 'done'})
        self.assertEqual(await self.new_gateway().dispatch(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(await self.bot.get_updates(offset=2), ())

    async def test_missing_topic_never_delivers_a_private_topic_answer_in_general(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message thread not found'})) if data.get('message_thread_id') else None
        result = await self.gateway.dispatch(self.envelope())
        self.assertNotEqual(result['state'], 'done')
        self.assertEqual(self.request.delivered, [], 'native fallback must not widen the approved audience')

    async def test_general_forum_message_replies_in_general(self):
        envelope = self.envelope(topic=None)
        self.assertEqual(await self.gateway.dispatch(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertIn(self.request.delivered[0].get('message_thread_id'), (None, 1))

    async def test_approved_action_preserves_exact_topic_and_receipt_after_restart(self):
        body = {'id': 'b' * 64, 'destination': '-20/topic/17', 'text': 'پیگیری تأییدشدهٔ مصنوعی'}
        with patch.dict(os.environ, {'NOCHEH_STORAGE_LAYOUT': 'original-only-v1'}), patch(
                'services.hermes.assistant_gateway.check_action_policy', return_value=True):
            self.assertEqual(await self.gateway.send_action(body), {'state': 'done'})
            self.assertEqual(await self.new_gateway().send_action(body), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(str(self.request.delivered[0]['chat_id']), '-20')
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_explicit_general_topic_uses_the_native_general_send_convention(self):
        self.assertEqual(await self.gateway.dispatch(self.envelope(topic=1)), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertIsNone(self.request.delivered[0].get('message_thread_id'))

    async def test_approved_topic_action_never_falls_back_to_general(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message thread not found'})) if data.get('message_thread_id') else None
        body = {'id': 'c' * 64, 'destination': '-20/topic/17', 'text': 'Synthetic approved topic follow-up'}
        with patch.dict(os.environ, {'NOCHEH_STORAGE_LAYOUT': 'original-only-v1'}), patch(
                'services.hermes.assistant_gateway.check_action_policy', return_value=True):
            self.assertEqual(await self.gateway.send_action(body), {'state': 'ambiguous'})
            self.assertEqual(await self.new_gateway().send_action(body), {'state': 'ambiguous'})
        self.assertEqual(self.request.delivered, [])

    async def test_revocation_between_chunks_prevents_every_later_physical_send(self):
        self.answer = 'پاسخ بلند مصنوعی 🌿 ' * 600
        def revoke_after_first(data):
            self.allowed = False
        self.request.respond = revoke_after_first
        envelope = self.envelope()
        result = await self.gateway.dispatch(envelope)
        self.assertNotEqual(result['state'], 'done')
        self.assertEqual(len(self.request.delivered), 1, 'only the chunk authorized before revocation can leave')
        self.assertEqual(await self.new_gateway().dispatch(envelope), result)
        self.assertEqual(len(self.request.delivered), 1, 'partial delivery cannot be replayed after restart')

    async def test_long_persian_emoji_reply_keeps_its_topic_and_replays_no_chunks(self):
        self.answer = 'یک پاسخ بلند با ایموجی 🌿 و جزئیات مصنوعی\n' * 350
        envelope = self.envelope()
        self.assertEqual(await self.gateway.dispatch(envelope), {'state': 'done'})
        self.assertGreater(len(self.request.delivered), 1)
        self.assertTrue(all(d.get('message_thread_id') == 17 for d in self.request.delivered))
        before = len(self.request.delivered)
        self.assertEqual(await self.new_gateway().dispatch(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), before)

    async def test_markdown_rejection_falls_back_within_same_topic_only(self):
        self.answer = '**پاسخ مصنوعی**'
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': "Bad Request: can't parse entities"})) if data.get('parse_mode') else None
        self.assertEqual(await self.gateway.dispatch(self.envelope()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_uncertain_server_failure_is_not_repeated_after_restart(self):
        self.request.respond = lambda data: (500, canonical({'ok': False, 'error_code': 500, 'description': 'Synthetic server failure'}))
        envelope = self.envelope()
        result = await self.gateway.dispatch(envelope)
        self.assertEqual(result['state'], 'ambiguous')
        before = len([c for c in self.request.calls if c[0] == 'sendMessage'])
        self.assertEqual(before, 1)
        self.assertEqual(await self.new_gateway().dispatch(envelope), result)
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
        self.assertEqual(await self.gateway.dispatch(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(len([c for c in self.request.calls if c[0] == 'sendMessage']), 2)
        self.assertEqual(await self.new_gateway().dispatch(envelope), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)

    async def test_cancel_between_chunks_keeps_partial_delivery_without_later_sends(self):
        self.answer = 'Synthetic long answer for cancellation. ' * 350
        cancelled = threading.Event()
        self.request.respond = lambda data: cancelled.set()
        envelope = self.envelope()
        result = await self.gateway.dispatch(envelope, cancelled=cancelled)
        self.assertEqual(result['state'], 'ambiguous', 'an earlier transmitted chunk cannot be called cancelled')
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(await self.new_gateway().dispatch(envelope), result)
        self.assertEqual(len(self.request.delivered), 1)

    async def test_revocation_during_rate_limit_wait_blocks_the_retry(self):
        def revoke_and_reject(data):
            self.allowed = False
            return 429, canonical({'ok': False, 'error_code': 429,
                'description': 'Too Many Requests: retry after 1', 'parameters': {'retry_after': 1}})
        self.request.respond = revoke_and_reject
        result = await self.gateway.dispatch(self.envelope())
        self.assertNotEqual(result['state'], 'done')
        self.assertEqual(self.request.delivered, [])
        self.assertEqual(len([c for c in self.request.calls if c[0] == 'sendMessage']), 1)

    async def test_deleted_reply_anchor_may_change_without_changing_topic(self):
        self.request.respond = lambda data: (400, canonical({'ok': False, 'error_code': 400,
            'description': 'Bad Request: message to be replied not found'})) if data.get('reply_parameters') else None
        self.assertEqual(await self.gateway.dispatch(self.envelope()), {'state': 'done'})
        self.assertEqual(len(self.request.delivered), 1)
        self.assertEqual(self.request.delivered[0]['message_thread_id'], 17)

    async def test_action_revocation_between_native_chunks_prevents_further_sends(self):
        approved = True
        self.adapter.MAX_MESSAGE_LENGTH = 80
        def revoke(data):
            nonlocal approved
            approved = False
        self.request.respond = revoke
        body = {'id': 'a' * 64, 'destination': '-20', 'text': 'Synthetic approved message. ' * 20}
        with patch.dict(os.environ, {'NOCHEH_STORAGE_LAYOUT': 'original-only-v1'}), \
                patch('services.hermes.assistant_gateway.check_action_policy', side_effect=lambda action: approved):
            result = await self.gateway.send_action(body)
            self.assertEqual(result['state'], 'ambiguous')
            self.assertEqual(len(self.request.delivered), 1)
            self.assertEqual(await self.new_gateway().send_action(body), result)
            self.assertEqual(len(self.request.delivered), 1)


if __name__ == '__main__':
    unittest.main()
