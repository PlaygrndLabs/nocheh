"""Nocheh leaves a group someone other than the owner added it to (ADR-0253): only a chat that is not served and not the
owner's, leaveChat and nothing else, at most once by its id at each Telegram id, with Telegram's answer read as storage
needs it."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from telegram.error import BadRequest, ChatMigrated, Forbidden, NetworkError

from services.chats import Served, ServedList
from services.durable import canonical
from . import checks
from .capture import OUTBOUND_CHECK, DISPATCH_KEY, Held
from .checks import leave_check
from .gateway import TelegramService
from .sends import already_left
from .settings import Policy

OWNER, GROUP, OLD, STRANGER, OTHER = '111', '-1001234567890', '-1234567', '-1009876543210', '-1005555555555'
ID = 'a' * 64


def receipt(folder, chat, event=ID):
    """Where a leave's answer is kept: by the add and the Telegram id."""
    return Path(folder) / 'spool/dispatch' / ('leave-' + event + '-' + chat.lstrip('-') + '.result')


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


class Listing:
    """/internal/chats answering with a served list."""
    def __init__(self, served): self.served = served
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def read(self, _size):
        return json.dumps({'epoch': 0, 'owner_chat': self.served.owner_chat, 'owner_account': self.served.owner_account,
                           'chats': list(self.served.chats.values())}).encode()


class Gate(asyncio.Lock):
    """The action lock, saying when a leave starts waiting on it."""
    def __init__(self):
        super().__init__()
        self.waiting = asyncio.Event()

    async def acquire(self):
        if self.locked(): self.waiting.set()
        return await super().acquire()


class LeaveTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The app's last word before each leave (POST /internal/chats/leave): the leave stands unless a test queues
        # another answer.
        self.stands = []
        patcher = patch('services.telegram.gateway.check_leave_policy', side_effect=lambda body: self.stands.pop(0) if self.stands else True)
        self.asked = patcher.start(); self.addCleanup(patcher.stop)

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
            self.assertEqual(json.loads(receipt(folder, STRANGER).read_bytes()), {'state': 'done', 'chat_id': STRANGER})
            # The same add at another Telegram id has no answer yet, so the app is asked whether that id is the group's now.
            self.stands.append(False)
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': OTHER}), {'state': 'not_started', 'error_code': 'leave_superseded'})
            self.assertEqual(service.bot.calls, [int(STRANGER)])
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

    async def test_a_refused_leave_is_asked_again_at_the_upgraded_id(self):
        # Telegram refused to leave the basic group, but that answer never reached the stage, and the group became a
        # supergroup before the stage asked again. The refusal kept for the old id does not answer for the new one: once the
        # app confirms the new id is the group's now, Nocheh leaves there, and each id keeps its own answer.
        basic, refused = '-7654321', {'state': 'failed', 'error_code': 'telegram_refused'}
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            service.bot.answers.append(BadRequest('Bad Request: not enough rights'))
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': basic}), refused)
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': STRANGER}), {'state': 'done'})
            self.assertEqual(service.bot.calls, [int(basic), int(STRANGER)])
            self.assertEqual(self.asked.call_args.args[0], {'id': ID, 'chat_id': STRANGER}, 'the app confirmed the new id')
            self.assertEqual([json.loads(receipt(folder, chat).read_bytes()) for chat in (basic, STRANGER)],
                             [{**refused, 'chat_id': basic}, {'state': 'done', 'chat_id': STRANGER}])
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': basic}), refused, 'each answers from its receipt')
            self.assertEqual(await service.leave_chat({'id': ID, 'chat_id': STRANGER}), {'state': 'done'})
            self.assertEqual((service.bot.calls, self.asked.call_count), ([int(basic), int(STRANGER)], 2))

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

    async def test_the_route_and_the_send_record_read_a_leave_answer_alike(self):
        # The route counts a leave done exactly when its send record calls it already left, so Health never counts a
        # leave that worked as a problem, and a refusal that left Nocheh in the chat stays one.
        answers = ((403, 'Forbidden: the group chat was deleted'), (400, 'Bad Request: chat not found'), (400, 'Bad Request: PEER_ID_INVALID'),
                   (400, 'Bad Request: group chat was deleted'), (400, 'Bad Request: not enough rights'), (400, 'Bad Request: synthetic refusal'))
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            for number, (status, description) in enumerate(answers):
                service.bot.answers.append((Forbidden if status == 403 else BadRequest)(description))
                with self.subTest(description):
                    done = await service.leave_chat({'id': str(number) * 64, 'chat_id': STRANGER}) == {'state': 'done'}
                    self.assertEqual(done, already_left(status, json.dumps({'ok': False, 'error_code': status, 'description': description})))
                    self.assertEqual(done, number < 4)

    async def test_a_leave_whose_answer_never_came_is_tried_again(self):
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            body = {'id': ID, 'chat_id': STRANGER}
            service.bot.answers += [NetworkError('Bad Gateway'), ChatMigrated(-1007777777777)]
            self.assertEqual(await service.leave_chat(body), {'state': 'not_started', 'error_code': 'telegram_leave_unconfirmed'})
            self.assertEqual(await service.leave_chat(body), {'state': 'not_started', 'error_code': 'telegram_chat_migrated'})
            self.assertFalse(receipt(folder, STRANGER).exists())
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
            self.assertFalse(receipt(folder, STRANGER).exists())

    async def test_a_list_that_says_not_served_is_read_again_before_leaving(self):
        # The owner turned the group on after the list was read: the list is read again (at most once a second) before
        # Nocheh leaves on its word, and the newer list refuses the leave.
        before, after = Served.of(OWNER), Served.of(OWNER, groups=[STRANGER])
        reads, now = [], [0.0]
        def opener(request, timeout):
            reads.append(request.full_url)
            return Listing(before if len(reads) == 1 else after)
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder), Policy(True, {}, ServedList('http://app.test', 's' * 32, opener=opener, clock=lambda: now[0])))
            self.assertEqual(await service.leave_chat({'id': 'b' * 64, 'chat_id': OTHER}), {'state': 'done'})
            now[0] = 2.0
            with self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                await service.leave_chat({'id': ID, 'chat_id': STRANGER})
            self.assertEqual(len(reads), 2)
            self.assertEqual(service.bot.calls, [int(OTHER)])

    async def test_a_group_turned_on_while_the_leave_waits_behind_another_send_is_not_left(self):
        # Another send holds the lock while the owner turns the group on: the list is read again once the lock is free,
        # right before the request would go, and refuses the leave. A list that cannot be read by then leaves nothing.
        served, now = [Served.of(OWNER)], [0.0]
        def opener(request, timeout):
            if served[0] is None: raise OSError('down')
            return Listing(served[0])
        async def waiting(body, later):
            service.action_lock.waiting.clear()
            await service.action_lock.acquire()
            leaving = asyncio.create_task(service.leave_chat(body))
            await service.action_lock.waiting.wait()
            served[0], now[0] = later, now[0] + 2.0
            service.action_lock.release()
            return await leaving
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder), Policy(True, {}, ServedList('http://app.test', 's' * 32, opener=opener, clock=lambda: now[0])))
            service.action_lock = Gate()
            with self.assertRaisesRegex(ValueError, 'leave_chat_not_allowed'):
                await waiting({'id': ID, 'chat_id': STRANGER}, Served.of(OWNER, groups=[STRANGER]))
            served[0], now[0] = Served.of(OWNER), now[0] + 2.0
            self.assertEqual(await waiting({'id': 'b' * 64, 'chat_id': OTHER}, None), {'state': 'not_started', 'error_code': 'served_list_unavailable'})
            self.assertEqual(service.bot.calls, [])
            self.assertEqual(list((Path(folder) / 'spool/dispatch').glob('leave-*')), [], 'a refusal keeps no receipt')
            # Tried again once the list reads, the leave goes.
            served[0], now[0] = Served.of(OWNER), now[0] + 2.0
            self.assertEqual(await service.leave_chat({'id': 'b' * 64, 'chat_id': OTHER}), {'state': 'done'})
            self.assertEqual(service.bot.calls, [int(OTHER)])

    async def test_a_group_turned_off_or_added_again_while_the_leave_waits_is_not_left(self):
        # The served list cannot tell an off group from a pending one: once the lock is free, right before the request
        # would go, the app says whether the group is still pending from this add. No receipt is kept, so the stage asks
        # again later and finds the group superseded.
        async def waiting(body, answer):
            service.action_lock.waiting.clear()
            await service.action_lock.acquire()
            leaving = asyncio.create_task(service.leave_chat(body))
            await service.action_lock.waiting.wait()
            self.stands.append(answer)
            service.action_lock.release()
            return await leaving
        body = {'id': ID, 'chat_id': STRANGER}
        with tempfile.TemporaryDirectory() as folder:
            service = self.service(Path(folder))
            service.action_lock = Gate()
            self.assertEqual(await waiting(body, False), {'state': 'not_started', 'error_code': 'leave_superseded'})
            self.assertEqual(await waiting(body, None), {'state': 'not_started', 'error_code': 'leave_check_unavailable'})
            self.assertEqual(service.bot.calls, [])
            self.assertEqual(list((Path(folder) / 'spool/dispatch').glob('leave-*')), [], 'neither keeps a receipt')
            self.assertEqual([call.args[0] for call in self.asked.call_args_list], [body, body], 'this add and this chat')
            # While it stands, the leave goes; a repeat answers from its receipt and asks nothing.
            self.assertEqual(await service.leave_chat(body), {'state': 'done'})
            self.assertEqual(await service.leave_chat(body), {'state': 'done'})
            self.assertEqual((service.bot.calls, self.asked.call_count), ([int(STRANGER)], 3))

    def test_the_app_is_asked_about_this_add_and_this_chat_alone(self):
        sent, answers = [], [b'{"valid":true}', b'{"valid":false}', b'{"valid":"yes"}', OSError('down')]
        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size): return self.body
        def urlopen(request, timeout):
            sent.append((request.full_url, request.get_method(), request.data, request.get_header('Authorization')))
            answer = answers.pop(0)
            if isinstance(answer, Exception): raise answer
            return Response(answer)
        with patch.dict(os.environ, {'SERVICE_TOKEN': 's' * 32, 'ARCHIVE_URL': 'http://app.test'}), patch.object(checks.urllib.request, 'urlopen', urlopen):
            self.assertEqual([checks.check_leave_policy({'id': ID, 'chat_id': STRANGER, 'extra': 1}) for _ in range(4)], [True, False, None, None],
                             'only a yes or a no counts; anything else, or no answer, is neither')
        self.assertEqual(sent[0], ('http://app.test/internal/chats/leave', 'POST', canonical({'id': ID, 'chat_id': STRANGER}), 'Bearer ' + 's' * 32))

    def test_the_bound_check_admits_only_leaving_that_chat(self):
        check = leave_check(STRANGER)
        check('leaveChat', {'chat_id': int(STRANGER)})
        for method, parameters in (('leaveChat', {'chat_id': OTHER}), ('sendMessage', {'chat_id': STRANGER, 'text': 'x'}),
                                   ('banChatMember', {'chat_id': STRANGER, 'user_id': 5}), ('leaveChat', {'chat_id': STRANGER, 'extra': 1})):
            with self.subTest(method=method, parameters=parameters), self.assertRaises(Held):
                check(method, parameters)


if __name__ == '__main__':
    unittest.main()
