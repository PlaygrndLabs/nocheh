"""Nocheh leaves a group someone other than the owner added it to (ADR-0253): only a chat that is not served and not the
owner's, leaveChat and nothing else, at most once by its id, with Telegram's answer read as storage needs it."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from telegram.error import BadRequest, ChatMigrated, Forbidden, NetworkError

from services.chats import Served, ServedList
from .capture import OUTBOUND_CHECK, DISPATCH_KEY, Held
from .checks import leave_check
from .gateway import TelegramService
from .settings import Policy

OWNER, GROUP, OLD, STRANGER, OTHER = '111', '-1001234567890', '-1234567', '-1009876543210', '-1005555555555'
ID = 'a' * 64


class Bot:
    """leaveChat as Telegram answers it: True, or the next queued error."""
    def __init__(self):
        self.calls, self.answers, self.keys = [], [], []

    async def leave_chat(self, chat_id):
        # The bound outbound check admits only leaveChat for this chat, as the capture boundary asks it.
        OUTBOUND_CHECK.get()('leaveChat', {'chat_id': chat_id})
        self.calls.append(chat_id)
        self.keys.append(DISPATCH_KEY.get())
        answer = self.answers.pop(0) if self.answers else True
        if isinstance(answer, Exception): raise answer
        return answer


class LeaveTests(unittest.IsolatedAsyncioTestCase):
    def service(self, root, policy=None):
        # The served list: the owner's chat and one served group, which had OLD as its id before an upgrade.
        value = TelegramService(policy or Policy.of(True, OWNER, [GROUP], {}, old={GROUP: [OLD]}), '123456:synthetic', root / 'spool', root / 'state')
        value.status, value.action_lock, value.bot = 'connected', asyncio.Lock(), Bot()
        return value

    async def test_an_unserved_group_is_left_once_by_its_id(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            body = {'id': ID, 'chat_id': STRANGER}
            self.assertEqual(await service.leave_chat(body), {'state': 'done'})
            self.assertEqual(await service.leave_chat(body), {'state': 'done'}, 'a repeat answers from its receipt')
            self.assertEqual(service.bot.calls, [int(STRANGER)], 'leaveChat once')
            self.assertTrue(service.bot.keys[0].startswith('leave:' + ID + ':'))
            receipt = json.loads((Path(folder) / 'spool/dispatch' / ('leave-' + ID + '.result')).read_bytes())
            self.assertEqual(receipt, {'state': 'done', 'chat_id': STRANGER})
            with self.assertRaisesRegex(ValueError, 'invalid_leave'):
                await service.leave_chat({'id': ID, 'chat_id': OTHER})
            self.assertEqual(await service.leave_chat({'id': 'b' * 64, 'chat_id': -1005555555555}), {'state': 'done'}, 'a number is taken too')
            self.assertEqual(service.bot.calls, [int(STRANGER), int(OTHER)])

    async def test_a_served_group_the_owners_chat_and_malformed_requests_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            for chat in (GROUP, OLD):
                with self.subTest(chat), self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                    await service.leave_chat({'id': ID, 'chat_id': chat})
            for bad in ({'id': ID, 'chat_id': OWNER}, {'id': ID, 'chat_id': '42'}, {'id': ID, 'chat_id': 'x'}, {'id': ID, 'chat_id': '-0'},
                        {'id': ID, 'chat_id': '-012'}, {'id': ID, 'chat_id': '-1' + '0' * 19}, {'id': ID, 'chat_id': ''}, {'id': ID},
                        {'id': ID, 'chat_id': True}, {'id': ID, 'chat_id': [STRANGER]}, {'id': 'A' * 64, 'chat_id': STRANGER},
                        {'id': 'a' * 63, 'chat_id': STRANGER}, {'chat_id': STRANGER}):
                with self.subTest(bad), self.assertRaisesRegex(ValueError, 'invalid_leave'):
                    await service.leave_chat(bad)
            # The owner's chat is never left, whatever id it has.
            owner = self.service(Path(folder), Policy.of(True, '-777', [], {}))
            with self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                await owner.leave_chat({'id': ID, 'chat_id': '-777'})
            self.assertEqual(service.bot.calls + owner.bot.calls, [])

    async def test_telegram_saying_nocheh_is_gone_is_done_and_another_refusal_failed(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            for number, answer in enumerate((Forbidden('Forbidden: bot was kicked from the supergroup chat'),
                                             Forbidden('Forbidden: bot is not a member of the channel chat'),
                                             BadRequest('Chat not found'), BadRequest('Bad Request: USER_NOT_PARTICIPANT'),
                                             BadRequest('Bad Request: CHANNEL_PRIVATE'))):
                service.bot.answers.append(answer)
                with self.subTest(str(answer)):
                    self.assertEqual(await service.leave_chat({'id': str(number) * 64, 'chat_id': STRANGER}), {'state': 'done'})
            service.bot.answers.append(BadRequest('Bad Request: not enough rights'))
            refused = {'state': 'failed', 'error_code': 'telegram_refused'}
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': STRANGER}), refused)
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': STRANGER}), refused, 'kept, not tried again')
            self.assertEqual(len(service.bot.calls), 6)

    async def test_a_leave_whose_answer_never_came_is_tried_again(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            body = {'id': ID, 'chat_id': STRANGER}
            service.bot.answers += [NetworkError('Bad Gateway'), ChatMigrated(-1007777777777)]
            self.assertEqual(await service.leave_chat(body), {'state': 'not_started', 'error_code': 'telegram_leave_unconfirmed'})
            self.assertEqual(await service.leave_chat(body), {'state': 'not_started', 'error_code': 'telegram_chat_migrated'})
            self.assertFalse((Path(folder) / 'spool/dispatch' / ('leave-' + ID + '.result')).exists())
            self.assertEqual(await service.leave_chat(body), {'state': 'done'})
            self.assertEqual(len(service.bot.calls), 3)
            self.assertEqual(len(set(service.bot.keys)), 3, 'each try has its own journal entry')

    async def test_not_connected_or_no_served_list_leaves_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            service.status = 'starting'
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': STRANGER}), {'state': 'not_started', 'error_code': 'telegram_not_connected'})
            failing = ServedList('http://app.test', 's' * 32, opener=lambda *_args, **_kw: (_ for _ in ()).throw(OSError('down')))
            unread = self.service(Path(folder), Policy(True, {}, failing))
            self.assertEqual(await unread.leave_chat({'id': ID, 'chat_id': STRANGER}), {'state': 'not_started', 'error_code': 'served_list_unavailable'},
                             'a list that cannot be read proves nothing is served')
            self.assertEqual(service.bot.calls + unread.bot.calls, [])
            self.assertFalse((Path(folder) / 'spool/dispatch' / ('leave-' + ID + '.result')).exists())

    async def test_a_list_that_says_not_served_is_read_again_before_leaving(self):
        # The owner turned the group on after the list was read: the list is read again (at most once a second) before
        # Nocheh leaves on its word, and the newer list refuses the leave.
        before, after = Served.of(OWNER), Served.of(OWNER, groups=[STRANGER])
        reads, now = [], [0.0]
        class Response:
            def __init__(self, served): self.served = served
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size):
                return json.dumps({'epoch': 0, 'owner_chat': self.served.owner_chat, 'owner_account': self.served.owner_account,
                                   'chats': list(self.served.chats.values())}).encode()
        def opener(request, timeout):
            reads.append(request.full_url)
            return Response(before if len(reads) == 1 else after)
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder), Policy(True, {}, ServedList('http://app.test', 's' * 32, opener=opener, clock=lambda: now[0])))
            self.assertEqual(await service.leave_chat({'id': 'b' * 64, 'chat_id': OTHER}), {'state': 'done'})
            now[0] = 2.0
            with self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                await service.leave_chat({'id': ID, 'chat_id': STRANGER})
            self.assertEqual(len(reads), 2)
            self.assertEqual(service.bot.calls, [int(OTHER)])

    def test_the_bound_check_admits_only_leaving_that_chat(self):
        check = leave_check(STRANGER)
        check('leaveChat', {'chat_id': int(STRANGER)})
        for method, parameters in (('leaveChat', {'chat_id': OTHER}), ('sendMessage', {'chat_id': STRANGER, 'text': 'x'}),
                                   ('banChatMember', {'chat_id': STRANGER, 'user_id': 5}), ('leaveChat', {'chat_id': STRANGER, 'extra': 1})):
            with self.subTest(method=method, parameters=parameters), self.assertRaises(Held):
                check(method, parameters)


if __name__ == '__main__':
    unittest.main()
