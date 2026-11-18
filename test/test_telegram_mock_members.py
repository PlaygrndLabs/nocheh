"""The fake Telegram answers getChatMember the way Telegram does, so the bot's check that a member is still in a group
before their private turn (telegram.member_status, step 4) runs against it: through the pinned SDK, from what the fixture
saw in its updates, from what the tester set, and with Telegram's refusals."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from telegram import Bot
from telegram.error import BadRequest, Forbidden
from telegram.request import HTTPXRequest

from tools.acceptance.telegram_mock import BOT_USER, TOKEN, TelegramMock, bot_status, left_member

GROUP, OTHER, MEMBER, NEWCOMER, OWNER = -10042, -10043, 778, 5000123, 123


def person(user_id):
    return {'id': user_id, 'is_bot': False, 'first_name': 'Synthetic '+str(user_id)}


def said(number, chat, user):
    return {'update_id': number, 'message': {'message_id': number, 'date': 1700000000, 'from': person(user), 'text': 'سلام',
                                             'chat': {'id': chat, 'type': 'supergroup', 'title': 'Synthetic Forum '+str(chat)}}}


class GetChatMemberTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        environment = patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'})
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)/'telegram.json'
        self.mock = TelegramMock(self.path)
        app = FastAPI()
        self.mock.install(app)
        request = lambda: HTTPXRequest(httpx_kwargs={'transport': httpx.ASGITransport(app=app)})
        self.bot = Bot(TOKEN, base_url='http://telegram.mock/bot', base_file_url='http://telegram.mock/file/bot', request=request(),
                       get_updates_request=request())
        await self.bot.initialize()
        self.addAsyncCleanup(self.bot.shutdown)

    async def status(self, chat, user):
        return (await self.bot.get_chat_member(chat, user)).status

    async def test_someone_who_wrote_in_a_group_is_a_member_there_and_has_left_the_others(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER)]})
        found = await self.bot.get_chat_member(GROUP, MEMBER)
        self.assertEqual((found.status, found.user.id, found.user.first_name), ('member', MEMBER, 'Synthetic 778'))
        self.assertEqual(await self.status(OTHER, MEMBER), 'left', 'known to Telegram, never seen in that group')
        with self.assertRaises(BadRequest):
            await self.bot.get_chat_member(GROUP, NEWCOMER)

    async def test_a_leave_message_and_a_chat_member_update_change_the_answer_and_a_later_message_shows_them_in_again(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER), left_member(20, {'id': GROUP, 'type': 'supergroup'}, person(MEMBER))]})
        self.assertEqual(await self.status(GROUP, MEMBER), 'left')
        self.mock.inject({'updates': [said(30, GROUP, MEMBER)]})
        self.assertEqual(await self.status(GROUP, MEMBER), 'member')
        banned = {'update_id': 40, 'chat_member': {'chat': {'id': GROUP, 'type': 'supergroup'}, 'from': person(OWNER), 'date': 1700000001,
                                                   'old_chat_member': {'status': 'member', 'user': person(MEMBER)},
                                                   'new_chat_member': {'status': 'kicked', 'user': person(MEMBER), 'until_date': 0}}}
        self.mock.inject({'updates': [banned]})
        self.assertEqual(await self.status(GROUP, MEMBER), 'kicked')

    async def test_the_tester_sets_a_status_telegram_never_reported_with_every_kind_parsing(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER)]})
        for status, extra in (('kicked', {}), ('administrator', {}), ('creator', {}), ('restricted', {'is_member': False}),
                              ('restricted', {'is_member': True}), ('member', {})):
            with self.subTest(status=status, **extra):
                self.assertEqual(self.mock.configure({'chat_members': [{'chat_id': GROUP, 'user_id': MEMBER, 'status': status, **extra}]})['chat_members'], 1)
                found = await self.bot.get_chat_member(GROUP, MEMBER)
                self.assertEqual(found.status, status)
                if status == 'restricted':
                    self.assertIs(found.is_member, extra['is_member'])
        self.mock.configure({'chat_members': [{'chat_id': OTHER, 'user_id': NEWCOMER, 'status': 'member'}]})
        self.assertEqual(await self.status(OTHER, NEWCOMER), 'member', 'someone set by the tester is someone Telegram knows')
        self.assertEqual(TelegramMock(self.path).state['people'][f'{OTHER}:{NEWCOMER}']['status'], 'member', 'kept across a restart')

    async def test_malformed_settings_change_nothing(self):
        for row in ({'chat_id': MEMBER, 'user_id': MEMBER, 'status': 'member'}, {'chat_id': GROUP, 'user_id': 0, 'status': 'member'},
                    {'chat_id': GROUP, 'user_id': MEMBER, 'status': 'owner'}, {'chat_id': GROUP, 'user_id': MEMBER, 'status': 'member', 'is_member': True},
                    {'chat_id': str(GROUP), 'user_id': MEMBER, 'status': 'left'}, {'chat_id': GROUP, 'user_id': MEMBER, 'status': 'left', 'extra': 1}):
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.mock.configure({'files': [], 'chat_members': [{'chat_id': OTHER, 'user_id': MEMBER, 'status': 'member'}, row]})
        self.assertNotIn(f'{OTHER}:{MEMBER}', self.mock.state.get('people', {}))

    async def test_telegram_refuses_a_private_chat_a_group_the_bot_left_and_a_fault(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER), said(20, OTHER, MEMBER)]})
        with self.assertRaises(BadRequest):
            await self.bot.get_chat_member(MEMBER, MEMBER)
        self.mock.inject({'updates': [bot_status(30, {'id': OTHER, 'type': 'supergroup'}, person(OWNER), 'member', 'left')]})
        with self.assertRaises(Forbidden):
            await self.bot.get_chat_member(OTHER, MEMBER)
        # A group where the bot is no admin and Telegram will not list its members.
        self.mock.configure({'faults': [{'method': 'getChatMember', 'code': 400, 'description': 'Bad Request: member list is inaccessible'}]})
        with self.assertRaises(BadRequest):
            await self.bot.get_chat_member(GROUP, MEMBER)
        self.assertEqual(await self.status(GROUP, MEMBER), 'member', 'a fault answers once')
        self.assertEqual([call['parameters']['user_id'] for call in self.mock.state['calls'] if call['method'] == 'getChatMember'][-1], str(MEMBER))

    async def test_the_bot_and_posts_in_a_chats_own_name_are_nobody(self):
        post = said(10, GROUP, MEMBER)
        post['message'].update({'from': BOT_USER})
        self.mock.inject({'updates': [post]})
        self.assertEqual(self.mock.state.get('people', {}), {})


if __name__ == '__main__':
    unittest.main()
