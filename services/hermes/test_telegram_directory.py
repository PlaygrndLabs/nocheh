import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.archive import telegram_directory as directory


class TelegramDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.values = {'TELEGRAM_BOT_TOKEN': 'fixture-secret', 'TELEGRAM_OWNER_ID': '42',
                       'TELEGRAM_GROUP_IDS': '-10042', 'TELEGRAM_GROUP_ACCESS': '{"-10042":{"granted":["91"],"denied":["73"]}}'}
        mocked = patch.object(directory, 'load', return_value=self.values)
        mocked.start(); self.addCleanup(mocked.stop)
        self.observed = {'groups': [{'id': '-10042', 'name': 'Old name',
                                     'users': [{'id': '73', 'name': 'Mira Chen', 'username': '@mira'}]}],
                         'truncated': False}

    def test_live_group_title_and_administrators_fill_observed_directory(self):
        calls = []

        def api(token, method, **params):
            self.assertEqual(token, 'fixture-secret'); calls.append((method, params))
            if method == 'getChat': return {'id': -10042, 'type': 'supergroup', 'title': 'Aurora group'}
            if method == 'getChatAdministrators': return [
                {'user': {'id': 42, 'first_name': 'Owner'}},
                {'user': {'id': 84, 'first_name': 'Devon', 'username': 'devon'}},
                {'user': {'id': 85, 'first_name': 'Bot', 'is_bot': True}}]
            if method == 'getChatMember': return {'user': {'id': int(params['user_id']), 'first_name': 'Known member'}}
            self.fail('unexpected method')

        result = directory.directory(self.state, self.observed, api)
        self.assertEqual(result['groups'][0]['name'], 'Aurora group')
        people = {person['id']: person for person in result['groups'][0]['users']}
        self.assertEqual(people['42']['name'], 'Owner')
        self.assertEqual(people['73']['name'], 'Mira Chen')
        self.assertEqual(people['84']['username'], '@devon')
        self.assertEqual(people['91']['name'], 'Known member')
        self.assertNotIn('85', people)
        self.assertEqual([method for method, _ in calls], ['getChat', 'getChatAdministrators', 'getChatMember'])

    def test_selected_group_remains_visible_when_telegram_is_unavailable(self):
        def unavailable(*args, **kwargs):
            raise TimeoutError('private network detail')

        result = directory.directory(self.state, {'groups': [], 'truncated': False}, unavailable)
        self.assertEqual(result, {'groups': [{'id': '-10042', 'name': None, 'users': []}], 'truncated': False})

    def test_mismatched_chat_and_user_ids_cannot_label_saved_identities(self):
        def api(token, method, **params):
            if method == 'getChat': return {'id': -10099, 'type': 'supergroup', 'title': 'Wrong group'}
            if method == 'getChatAdministrators': return []
            return {'user': {'id': 999, 'first_name': 'Wrong user'}}

        result = directory.directory(self.state, {'groups': [], 'truncated': False}, api)
        self.assertEqual(result['groups'][0]['name'], None)
        self.assertEqual(result['groups'][0]['users'], [])


class TelegramDiscoveryTests(unittest.TestCase):
    """"Find my Telegram ID" in the dashboard."""

    def setUp(self):
        self.values = {'TELEGRAM_BOT_TOKEN': 'fixture-secret', 'TELEGRAM_ENABLED': 'false'}
        mocked = patch.object(directory, 'load', return_value=self.values)
        mocked.start(); self.addCleanup(mocked.stop)
        self.runs = 0

    def run_discovery(self, found):
        def run(state):
            self.runs += 1
            return found
        return run

    def test_private_senders_are_offered_by_name_and_numeric_id(self):
        found = {'bot_username': 'aurora_helper_bot', 'messages_sent': 0, 'chats': [
            {'chat_id': '42', 'chat_type': 'private', 'sender_id': '42', 'sender_name': '  Owner   Person ', 'sender_username': 'owner'},
            {'chat_id': '-10042', 'chat_type': 'supergroup', 'sender_id': '73', 'sender_name': 'Mira Chen', 'sender_username': 'mira'},
            {'chat_id': '84', 'chat_type': 'private', 'sender_id': None, 'sender_name': None, 'sender_username': None},
            {'chat_id': '85', 'chat_type': 'private', 'sender_id': '86', 'sender_name': 'Mismatch', 'sender_username': None},
            {'chat_id': '91', 'chat_type': 'private', 'sender_id': '91', 'sender_name': None, 'sender_username': None}]}
        result = directory.discover(None, lambda token, method: {'id': 1}, self.run_discovery(found))
        self.assertEqual(result, {'bot': '@aurora_helper_bot', 'more': False, 'people': [
            {'id': '42', 'name': 'Owner Person', 'username': '@owner'},
            {'id': '91', 'name': None, 'username': None}]})
        # A full batch of waiting updates may hide a newer private message.
        full = directory.discover(None, lambda token, method: {'id': 1},
                                  self.run_discovery({'bot_username': None, 'updates_fsynced': 100, 'chats': []}))
        self.assertEqual(full, {'bot': None, 'people': [], 'more': True})

    def test_discovery_never_runs_while_telegram_is_on_or_without_a_token(self):
        for change, code in (({'TELEGRAM_ENABLED': 'true'}, 'telegram_running'),
                             ({'TELEGRAM_BOT_TOKEN': ''}, 'telegram_token_missing')):
            with self.subTest(code=code), patch.dict(self.values, change):
                with self.assertRaisesRegex(ValueError, '^' + code + '$'):
                    directory.discover(None, lambda *args: self.fail('Telegram was called'), self.run_discovery({}))
        self.assertEqual(self.runs, 0)

    def test_refused_token_and_outage_are_named_without_provider_details(self):
        from io import BytesIO
        from urllib.error import HTTPError

        def refused(token, method):
            raise HTTPError('https://api.telegram.org/bot' + token + '/getMe', 401, 'Unauthorized', {}, BytesIO(b'{}'))

        def offline(token, method):
            raise TimeoutError('private network detail')

        for api, code in ((refused, 'telegram_token_refused'), (offline, 'telegram_unreachable')):
            with self.subTest(code=code), self.assertRaises(ValueError) as raised:
                directory.discover(None, api, self.run_discovery({}))
            self.assertEqual(str(raised.exception), code)
            self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(self.runs, 0)


if __name__ == '__main__':
    unittest.main()
