"""Send records: one content-free file per Bot API request that left or was held back, never its text or the token."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from telegram.error import NetworkError, TimedOut

from services.durable import canonical, digest
from .capture import Capture, DISPATCH_KEY, Held, OUTBOUND_CHECK, instrument_request
from .sends import Sends, exception_code, kind_of, not_sent_code, outcome

URL = 'https://api.telegram.org/bot123456:synthetic-token/'
FIELDS = {'version', 'key', 'channel', 'account', 'at', 'kind', 'method', 'chat', 'topic', 'message_id', 'detail',
          'state', 'status', 'error_code', 'reference', 'ms'}
EYES = '\U0001f440'


def refusal(status, description):
    return status, canonical({'ok': False, 'error_code': status, 'description': description})


class Request:
    """Telegram's transport: each request gets the next answer, the last one repeating; an exception is raised."""
    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    async def do_request(self, *args, **kwargs):
        self.calls.append(kwargs['url'].rsplit('/', 1)[-1])
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, BaseException): raise answer
        return answer


class HelperTests(unittest.TestCase):
    def test_the_dispatch_key_names_the_kind_of_send(self):
        for method, dispatch, kind in (
                ('setMessageReaction', None, 'reaction'),
                ('deleteWebhook', None, 'setup'), ('deleteMyCommands', 'control:' + 'a' * 32, 'setup'),
                ('sendMessage', 'telegram:1:update:2', 'reply'), ('sendMessage', 'telegram:1:update:2:retry:1', 'reply'),
                ('sendMessage', 'action:' + 'a' * 64, 'approved_send'), ('sendMessage', 'approval:' + 'a' * 64, 'approval_card'),
                ('editMessageText', 'approval-settle:' + 'a' * 64, 'card_update'),
                ('answerCallbackQuery', 'approval-answer:1', 'button_answer'), ('sendMessage', 'refusal:' + 'a' * 64, 'refusal'),
                ('sendMessage', 'notice:' + 'a' * 64, 'notice'), ('editMessageText', 'notice-edit:notice-a:b', 'notice_update'),
                ('sendMessage', 'something-new:1', 'other')):
            self.assertEqual(kind_of(method, dispatch), kind, (method, dispatch))

    def test_telegram_answers_become_states_and_codes_never_descriptions(self):
        delivered = canonical({'ok': True, 'result': {'message_id': 42, 'chat': {'id': -20}, 'text': 'synthetic'}})
        self.assertEqual(outcome(200, delivered), ('sent', None, 42))
        self.assertEqual(outcome(200, canonical({'ok': True, 'result': [{'message_id': 7}, {'message_id': 8}]})), ('sent', None, 7))
        self.assertEqual(outcome(200, b'{"ok":true,"result":true}'), ('sent', None, None))
        for description, code in (
                ('Forbidden: bot was blocked by the user', 'bot_blocked'), ('Forbidden: user is deactivated', 'user_deactivated'),
                ('Forbidden: bot was kicked from the group chat', 'bot_removed'), ('Forbidden: bot is not a member of the channel chat', 'bot_removed'),
                ('Bad Request: chat not found', 'chat_not_found'), ('Bad Request: message thread not found', 'topic_not_found'),
                ('Bad Request: TOPIC_CLOSED', 'topic_not_found'), ('Bad Request: message to edit not found', 'message_not_found'),
                ('Bad Request: message to react not found', 'message_not_found'), ('Bad Request: MESSAGE_ID_INVALID', 'message_not_found'),
                ('Bad Request: message to be replied not found', 'message_not_found'),
                ('Bad Request: message is not modified: specified new message content is the same', 'message_not_modified'),
                ("Bad Request: can't parse entities: unclosed bold", 'formatting_rejected'),
                ("Bad Request: can't find end of the entity", 'formatting_rejected'),
                ('Bad Request: query is too old and response timeout expired', 'button_answer_expired'),
                ('Bad Request: query ID is invalid', 'button_answer_expired'), ('Bad Request: REACTION_INVALID', 'reaction_not_allowed'),
                ('Bad Request: reactions are disabled in the chat', 'reaction_not_allowed'), ('Bad Request: REACTION_EMPTY', 'reaction_not_allowed'),
                ('Bad Request: not enough rights to send text messages to the chat', 'no_permission'),
                ('Forbidden: CHAT_WRITE_FORBIDDEN', 'no_permission'), ('Bad Request: message is too long', 'message_too_long'),
                ('Bad Request: BUTTON_DATA_INVALID', 'button_rejected'), ('Bad Request: wrong http url', 'button_rejected')):
            self.assertEqual(outcome(*refusal(400, description)), ('failed', code, None), description)
        for status, code in ((429, 'rate_limited'), (401, 'unauthorized'), (403, 'forbidden'), (409, 'conflict'), (400, 'rejected')):
            self.assertEqual(outcome(*refusal(status, 'Synthetic refusal')), ('failed', code, None))
        self.assertEqual(outcome(400, b'Bad Request'), ('failed', 'rejected', None))
        self.assertEqual(outcome(200, canonical({'ok': False, 'error_code': 403, 'description': 'Synthetic'})), ('failed', 'forbidden', None))
        for status, raw in ((500, b'{"ok":false}'), (502, b'Bad Gateway'), (200, b'not json'), (200, b'[]')):
            self.assertEqual(outcome(status, raw), ('uncertain', 'server_error', None), (status, raw))

    def test_exceptions_and_holds_become_codes(self):
        self.assertEqual([exception_code(e) for e in (TimedOut(), TimeoutError(), NetworkError('x'), OSError('x'), RuntimeError('x'))],
                         ['timed_out', 'timed_out', 'network_error', 'network_error', 'network_error'])
        self.assertEqual([not_sent_code(code) for code in ('telegram_delivery_audience_changed', 'telegram_delivery_cancelled',
                                                            'telegram_delivery_authority_revoked', 'telegram_reaction_unbound',
                                                            'telegram_chat_action_unbound', 'outbound_delivery_ambiguous', None)],
                         ['audience_changed', 'cancelled', 'authority_revoked', 'reaction_unbound', 'refused', 'refused', 'refused'])

    def test_a_record_names_its_chat_topic_message_and_reaction_only(self):
        with tempfile.TemporaryDirectory() as folder:
            sends = Sends(Path(folder), '123456')
            reaction = sends.answered('setMessageReaction', {'chat_id': -20, 'message_id': 7, 'reaction': [{'type': 'emoji', 'emoji': EYES}]},
                                      None, (200, b'{"ok":true,"result":true}'), 12)
            self.assertEqual(set(reaction), FIELDS)
            self.assertEqual({key: reaction[key] for key in ('channel', 'account', 'kind', 'chat', 'message_id', 'detail', 'state', 'status', 'reference', 'ms')},
                             {'channel': 'telegram', 'account': '123456', 'kind': 'reaction', 'chat': '-20', 'message_id': 7, 'detail': EYES,
                              'state': 'sent', 'status': 200, 'reference': None, 'ms': 12})
            self.assertRegex(reaction['key'], r'^send:telegram:123456:[0-9a-f]{32}$')
            self.assertRegex(reaction['at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
            self.assertEqual(sends.refused('setMessageReaction', {'chat_id': -20, 'message_id': 7}, None, 'telegram_delivery_authority_revoked')['detail'], 'clear')
            edit = sends.failed('editMessageText', {'chat_id': -20, 'message_id': 9, 'text': 'synthetic'}, 'notice-edit:notice-a:b', TimedOut())
            self.assertEqual((edit['kind'], edit['message_id'], edit['state'], edit['error_code'], edit['detail']), ('notice_update', 9, 'uncertain', 'timed_out', None))
            answer = sends.answered('answerCallbackQuery', {'callback_query_id': '1', 'text': 'synthetic'}, 'approval-answer:1', refusal(400, 'Bad Request: query is too old'))
            self.assertEqual((answer['chat'], answer['reference'], answer['error_code']), (None, 'approval-answer:1', 'button_answer_expired'))
            general = sends.flooded('-20', 1, 'telegram:123456:update:3')
            self.assertEqual((general['topic'], general['state'], general['error_code'], general['kind']), (None, 'not_sent', 'rate_limited', 'reply'))
            files = list((Path(folder) / 'sends').glob('*.json'))
            self.assertEqual(len(files), 5)
            for path in files:
                record = json.loads(path.read_bytes())
                self.assertEqual(path.name, digest(record['key']) + '.json')
                self.assertEqual(path.read_bytes(), canonical(record))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(b'synthetic', path.read_bytes())

    def test_typing_is_never_recorded_not_even_when_it_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            sends = Sends(Path(folder), '123456')
            typing = {'chat_id': -20, 'action': 'typing', 'message_thread_id': 17}
            self.assertIsNone(sends.answered('sendChatAction', typing, None, (200, b'{"ok":true,"result":true}')))
            self.assertIsNone(sends.answered('sendChatAction', typing, None, refusal(403, 'Forbidden: bot was kicked')))
            self.assertIsNone(sends.failed('sendChatAction', typing, None, TimedOut()))
            self.assertIsNone(sends.refused('sendChatAction', typing, None, 'telegram_chat_action_unbound'))
            self.assertIsNone(sends.restarted('sendChatAction', typing, None))
            self.assertFalse((Path(folder) / 'sends').exists())


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    """Records at the request boundary every Bot API request of the service passes."""
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.capture = Capture(self.root, '123456')
        self.addAsyncCleanup(self.capture.sends.settle)

    async def records(self):
        await self.capture.sends.settle()
        return [json.loads(path.read_bytes()) for path in (self.root / 'sends').glob('*.json')]

    async def send(self, request, method, parameters, dispatch=None, check=None):
        tokens = DISPATCH_KEY.set(dispatch), OUTBOUND_CHECK.set(check)
        try:
            return await request.do_request(url=URL + method, request_data=SimpleNamespace(parameters=parameters))
        finally:
            DISPATCH_KEY.reset(tokens[0]); OUTBOUND_CHECK.reset(tokens[1])

    def allow(self, method, parameters):
        pass

    async def test_a_lost_answer_is_uncertain_and_its_retry_is_held_without_a_record(self):
        for error, code in ((NetworkError('connection reset'), 'network_error'), (TimedOut(), 'timed_out')):
            with self.subTest(code=code):
                request = instrument_request(Request(error), self.capture)
                parameters, dispatch = {'chat_id': -20, 'text': 'synthetic ' + code}, 'telegram:123456:update:' + code
                for _ in range(2):
                    with self.assertRaises(Exception): await self.send(request, 'sendMessage', parameters, dispatch, self.allow)
                self.assertEqual(request.calls, ['sendMessage'], 'the held retry never leaves')
                [record] = [r for r in await self.records() if r['reference'] == dispatch]
                self.assertEqual((record['kind'], record['state'], record['status'], record['error_code']), ('reply', 'uncertain', 0, code))
                self.assertIsInstance(record['ms'], int)

    async def test_a_journal_replay_adds_no_record(self):
        request = instrument_request(Request((200, b'{"ok":true,"result":{"message_id":8,"text":"synthetic"}}')), self.capture)
        for _ in range(2):
            await self.send(request, 'sendMessage', {'chat_id': -20, 'text': 'synthetic'}, 'action:' + 'a' * 64, self.allow)
        self.assertEqual(request.calls, ['sendMessage'])
        [record] = await self.records()
        self.assertEqual((record['kind'], record['state'], record['message_id'], record['reference']), ('approved_send', 'sent', 8, 'action:' + 'a' * 64))

    async def test_a_check_refusal_is_recorded_as_not_sent_and_nothing_leaves(self):
        def revoked(method, parameters): raise Held('telegram_delivery_authority_revoked')
        request = instrument_request(Request((200, b'{"ok":true,"result":true}')), self.capture)
        with self.assertRaisesRegex(Held, 'authority_revoked'):
            await self.send(request, 'sendMessage', {'chat_id': -20, 'message_thread_id': 17, 'text': 'synthetic'}, 'telegram:123456:update:4', revoked)
        with self.assertRaisesRegex(Held, 'reaction_unbound'):
            await self.send(request, 'setMessageReaction', {'chat_id': -20, 'message_id': 4, 'reaction': [{'type': 'emoji', 'emoji': EYES}]})
        self.assertEqual(request.calls, [])
        self.assertFalse((self.root / 'outbound').exists(), 'a refused request is not journaled')
        records = sorted(await self.records(), key=lambda r: r['kind'])
        self.assertEqual([(r['kind'], r['state'], r['error_code'], r['chat'], r['topic'], r['message_id'], r['detail'], r['reference']) for r in records],
                         [('reaction', 'not_sent', 'reaction_unbound', '-20', None, 4, EYES, None),
                          ('reply', 'not_sent', 'authority_revoked', '-20', 17, None, None, 'telegram:123456:update:4')])

    async def test_typing_leaves_no_record_whether_it_works_fails_or_is_held(self):
        typing = {'chat_id': -20, 'action': 'typing', 'message_thread_id': 17}
        def stopped(method, parameters): raise Held('telegram_delivery_cancelled')
        await self.send(instrument_request(Request((200, b'{"ok":true,"result":true}')), self.capture), 'sendChatAction', typing, check=self.allow)
        with self.assertRaises(Held):
            await self.send(instrument_request(Request((200, b'{"ok":true,"result":true}')), self.capture), 'sendChatAction', typing, check=stopped)
        with self.assertRaisesRegex(Held, 'chat_action_unbound'):
            await self.send(instrument_request(Request((200, b'{"ok":true,"result":true}')), self.capture), 'sendChatAction', typing)
        await self.send(instrument_request(Request(refusal(400, 'Bad Request: not enough rights to send messages')), self.capture), 'sendChatAction', typing, check=self.allow)
        with self.assertRaises(TimedOut):
            await self.send(instrument_request(Request(TimedOut()), self.capture), 'sendChatAction', typing, check=self.allow)
        self.assertEqual(await self.records(), [])
        self.assertFalse((self.root / 'outbound').exists(), 'typing is never journaled')

    async def test_setup_calls_are_recorded_as_setup_and_reads_never(self):
        request = instrument_request(Request((200, b'{"ok":true,"result":true}')), self.capture)
        await self.send(request, 'deleteWebhook', {'drop_pending_updates': False})
        await self.send(request, 'getMe', {})
        await request.do_request(url='https://api.telegram.org/file/bot123456:synthetic-token/photos/1.jpg')
        polling = instrument_request(Request((200, b'{"ok":true,"result":[]}')), self.capture, polling=True)
        await polling.do_request(url=URL + 'getUpdates')
        [record] = await self.records()
        self.assertEqual((record['kind'], record['method'], record['chat'], record['reference'], record['state']), ('setup', 'deleteWebhook', None, None, 'sent'))
        raw = canonical(record)
        self.assertNotIn(b'synthetic-token', raw)
        self.assertNotIn(b'control:', raw, 'a setup call has no reference')

    async def test_a_record_that_cannot_be_written_never_costs_the_send(self):
        request = instrument_request(Request((200, b'{"ok":true,"result":{"message_id":8}}')), self.capture)
        with patch('services.telegram.sends.immutable_file', side_effect=OSError('disk full')):
            self.assertEqual(await self.send(request, 'sendMessage', {'chat_id': -20, 'text': 'synthetic'}, 'notice:' + 'a' * 64),
                             (200, b'{"ok":true,"result":{"message_id":8}}'))
            await self.capture.sends.settle()
        with patch('services.telegram.sends.outcome', side_effect=ValueError('broken')):
            await self.send(request, 'sendMessage', {'chat_id': -20, 'text': 'another'}, 'notice:' + 'b' * 64)
        self.assertEqual(request.calls, ['sendMessage', 'sendMessage'])
        self.assertEqual(await self.records(), [])

    async def test_a_send_a_restart_cut_off_is_recorded_once_as_uncertain(self):
        self.capture.outbound('sendMessage', {'chat_id': -20, 'text': 'synthetic'}, 'telegram:123456:update:9')
        rate_retry, _ = self.capture.outbound('sendMessage', {'chat_id': -20, 'text': 'limited'}, 'approval:' + 'c' * 64)
        self.capture.complete(rate_retry, 'sendMessage', {'chat_id': -20, 'text': 'limited'},
                              (429, canonical({'ok': False, 'error_code': 429, 'parameters': {'retry_after': 0}})))
        self.capture.outbound('sendMessage', {'chat_id': -20, 'text': 'limited'}, 'approval:' + 'c' * 64)
        Capture(self.root, '123456')
        Capture(self.root, '123456')
        Capture(self.root, '123456', recover=False)
        records = sorted(await self.records(), key=lambda r: r['reference'])
        self.assertEqual([(r['kind'], r['state'], r['error_code'], r['reference']) for r in records],
                         [('approval_card', 'uncertain', 'restart', 'approval:' + 'c' * 64),
                          ('reply', 'uncertain', 'restart', 'telegram:123456:update:9')])


if __name__ == '__main__':
    unittest.main()
