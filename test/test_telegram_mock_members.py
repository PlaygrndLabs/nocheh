"""The fake Telegram answers getChatMember the way Telegram does, so the bot's check that a member is still in a group
before their private turn (telegram.member_status, step 4) runs against it: through the pinned SDK, from what the fixture
saw in its updates, from what the tester set, and with Telegram's refusals.

For the members' app (step 5, ADR-0265) it also signs Mini App launch data with the fixture's own key, exactly over the
bytes src/telegram-launch.ts checks, and records the menu buttons Settings Apply sets."""
import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI
from telegram import Bot, MenuButtonDefault, MenuButtonWebApp, WebAppInfo
from telegram.error import BadRequest, Forbidden
from telegram.request import HTTPXRequest

from tools.acceptance.telegram_mock import (BOT_USER, LAUNCH_KEY_ENV, TOKEN, TelegramMock, bot_status, launch_data, launch_public_key, left_member,
                                            new_launch_key)
from tools.paths import ROOT

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

    async def test_an_unused_fault_can_be_dropped(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER)]})
        fault = {'method': 'getChatMember', 'code': 400, 'description': 'Bad Request: member list is inaccessible'}
        self.mock.configure({'faults': [fault, {**fault, 'method': 'getFile'}]})
        self.mock.configure({'drop_faults': ['getChatMember']})
        self.assertEqual([row['method'] for row in self.mock.state['faults']], ['getFile'], 'only that method is dropped')
        self.assertEqual(await self.status(GROUP, MEMBER), 'member', 'the dropped fault answers nothing')
        for bad in ('getChatMember', ['sendPhoto'], [1]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.mock.configure({'drop_faults': bad})

    async def test_the_bot_and_posts_in_a_chats_own_name_are_nobody(self):
        post = said(10, GROUP, MEMBER)
        post['message'].update({'from': BOT_USER})
        self.mock.inject({'updates': [post]})
        self.assertEqual(self.mock.state.get('people', {}), {})


def checked(raw, public_hex, bot_id=BOT_USER['id']):
    """The bytes src/telegram-launch.ts signedLaunch checks, verified the same way: the decoded fields but hash and
    signature, sorted by key, as key=value lines after "<bot id>:WebAppData", against a base64url signature."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
    if len({key for key, _ in pairs}) != len(pairs):
        return None
    fields = dict(pairs)
    data = str(bot_id)+':WebAppData\n'+'\n'.join(key+'='+value for key, value in sorted(pairs) if key not in ('hash', 'signature'))
    signature = base64.urlsafe_b64decode(fields['signature']+'='*(-len(fields['signature']) % 4))
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_hex)).verify(signature, data.encode())
    except InvalidSignature:
        return None
    return fields


class LaunchDataTests(unittest.TestCase):
    def setUp(self):
        self.seed = new_launch_key()
        self.public = launch_public_key(self.seed)
        self.user = {'id': 778, 'first_name': 'Synthetic 778', 'language_code': 'fa'}

    def test_signed_as_telegram_signs_for_third_parties_and_the_bot_hash_matches(self):
        raw = launch_data(self.user, 1700000000, self.seed)
        fields = checked(raw, self.public)
        self.assertIsNotNone(fields)
        self.assertEqual(json.loads(fields['user']), self.user)
        self.assertEqual(fields['auth_date'], '1700000000')
        self.assertRegex(fields['signature'], r'^[A-Za-z0-9_-]{86}$', 'base64url without padding, as telegram-launch.ts takes it')
        self.assertNotIn('chat_type', fields, 'the menu button sends no chat type')
        secret = hmac.new(b'WebAppData', TOKEN.encode(), hashlib.sha256).digest()
        rest = '\n'.join(key+'='+value for key, value in sorted(fields.items()) if key != 'hash')
        self.assertEqual(fields['hash'], hmac.new(secret, rest.encode(), hashlib.sha256).hexdigest())

    def test_a_changed_field_another_bot_or_another_key_fails(self):
        raw = launch_data(self.user, 1700000000, self.seed, chat_type='sender')
        self.assertEqual(checked(raw, self.public)['chat_type'], 'sender', 'the chat type is signed with the rest')
        for old, new in (('auth_date=1700000000', 'auth_date=1700000001'), ('%22id%22%3A778', '%22id%22%3A779'), ('chat_type=sender', 'chat_type=group')):
            with self.subTest(field=old):
                self.assertIn(old, raw)
                self.assertIsNone(checked(raw.replace(old, new), self.public))
        self.assertIsNone(checked(raw, self.public, bot_id=654321), 'signed for this bot only')
        self.assertIsNone(checked(launch_data(self.user, 1700000000, self.seed, bot_id=654321), self.public))
        self.assertIsNone(checked(launch_data(self.user, 1700000000, new_launch_key()), self.public))
        with self.assertRaises(ValueError):
            launch_data(self.user, 1700000000, self.seed, chat_type='forum')

    @unittest.skipUnless(shutil.which('node') and (ROOT/'dist/src/telegram-launch.js').exists(), 'needs node and npm run build')
    def test_the_real_check_in_telegram_launch_ts_accepts_it_and_refuses_a_change(self):
        script = """const [module,raw,key,now]=process.argv.slice(1);const launch=await import(module);
const check={botId:'123456',key:launch.ed25519(key),maxAgeSeconds:launch.MEMBER_LAUNCH_MAX_AGE,now:Number(now)*1000};
try{console.log(JSON.stringify(launch.verifyLaunchUser(raw,check)));}catch(error){console.log(JSON.stringify({error:error.code}));}"""
        def verify(raw, key=self.public):
            return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, (ROOT/'dist/src/telegram-launch.js').as_uri(), raw, key,
                                                       str(int(time.time()))], text=True))
        now = int(time.time())
        raw = launch_data(self.user, now, self.seed)
        self.assertEqual(verify(raw), {'user_id': '778', 'auth_date': now, 'language_code': 'fa'})
        self.assertEqual(verify(launch_data(self.user, now, self.seed, chat_type='sender'))['user_id'], '778')
        self.assertEqual(verify(raw.replace('%22id%22%3A778', '%22id%22%3A779')), {'error': 'telegram_launch_invalid'})
        self.assertEqual(verify(raw, launch_public_key(new_launch_key())), {'error': 'telegram_launch_invalid'})
        self.assertEqual(verify(launch_data(self.user, now, self.seed, chat_type='group')), {'error': 'telegram_launch_invalid'})
        self.assertEqual(verify(launch_data(self.user, now-3601, self.seed)), {'error': 'telegram_launch_expired'})


class FixtureLaunchAndMenuTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.seed = new_launch_key()
        environment = patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1', LAUNCH_KEY_ENV: self.seed})
        environment.start()
        self.addCleanup(environment.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.mock = TelegramMock(Path(directory.name)/'telegram.json')
        app = FastAPI()
        self.mock.install(app)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://telegram.mock')
        self.addAsyncCleanup(self.client.aclose)
        self.bot = Bot(TOKEN, base_url='http://telegram.mock/bot', request=HTTPXRequest(httpx_kwargs={'transport': httpx.ASGITransport(app=app)}))
        await self.bot.initialize()
        self.addAsyncCleanup(self.bot.shutdown)

    async def launch(self, body):
        return await self.client.post('/fixture/telegram/launch', json=body)

    async def test_launch_names_the_person_telegram_knows_and_signs_with_the_fixture_key(self):
        self.mock.inject({'updates': [said(10, GROUP, MEMBER)]})
        answer = await self.launch({'user_id': MEMBER, 'chat_type': 'sender', 'language_code': 'fa'})
        self.assertEqual(answer.status_code, 200)
        fields = checked(answer.json()['init_data'], launch_public_key(self.seed))
        self.assertEqual(json.loads(fields['user'])['first_name'], 'Synthetic 778', 'the name Telegram showed in the group')
        self.assertEqual((json.loads(fields['user'])['language_code'], fields['chat_type']), ('fa', 'sender'))
        old = await self.launch({'user_id': NEWCOMER, 'auth_date': 1700000000})
        self.assertEqual(checked(old.json()['init_data'], launch_public_key(self.seed))['auth_date'], '1700000000')
        other = await self.launch({'user_id': MEMBER, 'other_key': True})
        self.assertIsNone(checked(other.json()['init_data'], launch_public_key(self.seed)))
        self.assertNotIn('init_data', json.dumps(self.mock.state), 'launch data is never kept')

    async def test_a_malformed_launch_or_no_key_is_refused(self):
        for body in ({'user_id': '778'}, {'user_id': 0}, {'user_id': MEMBER, 'auth_date': 'now'}, {'user_id': MEMBER, 'chat_type': 'forum'},
                     {'user_id': MEMBER, 'extra': 1}, {'user_id': MEMBER, 'bot_id': -1}, [MEMBER]):
            with self.subTest(body=body):
                self.assertEqual((await self.launch(body)).status_code, 400)
        with patch.dict(os.environ, {LAUNCH_KEY_ENV: ''}):
            answer = await self.launch({'user_id': MEMBER})
        self.assertEqual((answer.status_code, answer.json()), (409, {'error': 'fixture_launch_key_missing'}))

    async def test_menu_buttons_are_recorded_for_every_private_chat_and_for_one(self):
        everyone = MenuButtonWebApp('Nocheh', WebAppInfo('https://mini.example.test/m/'))
        own = MenuButtonWebApp('Nocheh', WebAppInfo('https://mini.example.test/'))
        self.assertTrue(await self.bot.set_chat_menu_button(menu_button=everyone))
        self.assertTrue(await self.bot.set_chat_menu_button(chat_id=OWNER, menu_button=own))
        sets = self.mock.state['menu_button_sets']
        self.assertEqual([(row['chat_id'], row['menu_button']['web_app']['url']) for row in sets],
                         [(None, 'https://mini.example.test/m/'), (OWNER, 'https://mini.example.test/')])
        self.assertEqual((await self.bot.get_chat_menu_button(MEMBER)).web_app.url, 'https://mini.example.test/m/', 'a chat without its own shows the default')
        self.assertEqual((await self.bot.get_chat_menu_button(OWNER)).web_app.url, 'https://mini.example.test/')
        self.assertTrue(await self.bot.set_chat_menu_button(menu_button=MenuButtonDefault()))
        self.assertEqual(self.mock.state['menu_buttons']['default'], {'type': 'default'})
        for button in ({'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'http://mini.example.test/'}}, {'type': 'web_app', 'text': '', 'web_app': {'url': 'https://a.test/'}},
                       {'type': 'link'}):
            with self.subTest(button=button):
                status, body = await self.mock.call('setChatMenuButton', {'menu_button': json.dumps(button)})
                self.assertEqual(status, 400)
        status, _ = await self.mock.call('setChatMenuButton', {'chat_id': GROUP, 'menu_button': '{"type":"default"}'})
        self.assertEqual(status, 400, 'a group has no menu button')
        self.assertEqual(len(self.mock.state['menu_button_sets']), 3)


if __name__ == '__main__':
    unittest.main()
