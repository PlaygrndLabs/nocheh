import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import telegram_directory as directory


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


if __name__ == '__main__':
    unittest.main()
