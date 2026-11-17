import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.chats import Served
from tools.operations.archive import telegram_directory as directory


class TelegramDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.values = {'TELEGRAM_BOT_TOKEN': 'fixture-secret', 'TELEGRAM_OWNER_ID': '42'}
        # The groups Nocheh serves come from the app (ADR-0253), never from a setting.
        self.served = Served.of('42', groups=['-10042'])
        mocked = patch.object(directory, 'load', return_value=self.values)
        mocked.start(); self.addCleanup(mocked.stop)
        # Storage lists the members with a switch for the group (step 3), also one Nocheh never saw there, who has no name yet.
        self.observed = {'groups': [{'id': '-10042', 'external': '-10042', 'telegram_ids': ['-10042'], 'name': 'Old name',
                                     'users': [{'id': '73', 'name': 'Mira Chen', 'username': '@mira', 'state': 'in', 'seen': True, 'member': True},
                                               {'id': '91', 'name': None, 'username': None, 'state': None, 'seen': False, 'member': True},
                                               {'id': '92', 'name': None, 'username': None, 'state': 'left', 'seen': False, 'member': False}]}],
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

        result = directory.directory(self.state, self.observed, api, self.served)
        self.assertEqual(result['groups'][0]['name'], 'Aurora group')
        people = {person['id']: person for person in result['groups'][0]['users']}
        self.assertEqual(people['42']['name'], 'Owner')
        self.assertEqual(people['73'], {'id': '73', 'name': 'Mira Chen', 'username': '@mira', 'state': 'in', 'seen': True, 'member': True})
        self.assertEqual(people['84']['username'], '@devon')
        # A carried member who never wrote gets a name from Telegram; what storage knows about them stays.
        self.assertEqual(people['91'], {'id': '91', 'name': 'Known member', 'username': None, 'seen': False, 'member': True})
        self.assertEqual(people['92'], {'id': '92', 'name': None, 'username': None, 'state': 'left', 'seen': False})
        self.assertNotIn('85', people)
        # Only members with no name are asked about: never someone who is not a member, nor one Telegram already named.
        self.assertEqual([(method, params.get('user_id')) for method, params in calls],
                         [('getChat', None), ('getChatAdministrators', None), ('getChatMember', '91')])

    def test_named_members_never_crowd_out_the_unnamed_from_the_forty_asked(self):
        # 41 carried members Telegram already named, and member 900 carried by ID who never wrote. Ids sort as text, so
        # '100'..'139' come first: only the unnamed count toward the 40 Telegram is asked about.
        users = [{'id': str(number), 'name': 'Member ' + str(number), 'username': None, 'state': 'in', 'seen': True, 'member': True}
                 for number in range(100, 141)]
        users.append({'id': '900', 'name': None, 'username': None, 'state': None, 'seen': False, 'member': True})
        observed = {'groups': [{'id': '-10042', 'external': '-10042', 'name': 'Old name', 'users': users}], 'truncated': False}
        asked = []

        def api(token, method, **params):
            if method == 'getChatMember':
                asked.append(params['user_id'])
                return {'user': {'id': int(params['user_id']), 'first_name': 'Named ' + params['user_id']}}
            return None

        result = directory.directory(self.state, observed, api, self.served)
        people = {person['id']: person for person in result['groups'][0]['users']}
        self.assertEqual(asked, ['42', '900'], 'the owner and the unnamed member are asked; no named member is')
        self.assertEqual(people['900']['name'], 'Named 900')

    def test_each_person_is_asked_once_and_a_refusal_ends_only_their_own_lookups(self):
        from io import BytesIO
        from urllib.error import HTTPError

        # Two served groups list the same unnamed members: 91 is in the first; Telegram refuses 93, who was never there.
        served = Served.of('42', groups=['-10042', '-10043'])
        unnamed = lambda identifier: {'id': identifier, 'name': None, 'username': None, 'state': None, 'seen': False, 'member': True}
        observed = {'groups': [{'id': group, 'external': group, 'name': None, 'users': [unnamed('91'), unnamed('93'), unnamed('94')]}
                               for group in ('-10042', '-10043')], 'truncated': False}
        asked = []

        def api(token, method, **params):
            if method == 'getChatAdministrators': return [{'user': {'id': 42, 'first_name': 'Owner'}}] if params['chat_id'] == '-10042' else []
            if method != 'getChatMember': return None
            asked.append((params['chat_id'], params['user_id']))
            if params['user_id'] == '93':
                raise HTTPError('https://api.telegram.org/bot' + token + '/getChatMember', 400, 'Bad Request', {}, BytesIO(b'{}'))
            return {'user': {'id': int(params['user_id']), 'first_name': 'Named ' + params['user_id']}}

        result = directory.directory(self.state, observed, api, served)
        # The name found in the first group serves the second; 93 is not asked again after Telegram refused them; the
        # refusal does not stop 94's lookup; the owner, named by the first group's administrators, is never asked.
        self.assertEqual(asked, [('-10042', '91'), ('-10042', '93'), ('-10042', '94')])
        for group in result['groups']:
            people = {person['id']: person for person in group['users']}
            with self.subTest(group=group['id']):
                self.assertEqual((people['91']['name'], people['93']['name'], people['94']['name']), ('Named 91', None, 'Named 94'))
                self.assertEqual((people['91']['member'], people['91']['seen']), (True, False), 'what storage knows stays')

    def test_served_group_remains_visible_when_telegram_is_unavailable(self):
        def unavailable(*args, **kwargs):
            raise TimeoutError('private network detail')

        result = directory.directory(self.state, {'groups': [], 'truncated': False}, unavailable, self.served)
        self.assertEqual(result, {'groups': [{'id': '-10042', 'external': '-10042', 'name': None, 'users': []}], 'truncated': False})

    def test_telegram_is_asked_only_about_groups_nocheh_serves_now(self):
        # A group Nocheh is off in, or a list the app cannot give, asks Telegram nothing; storage still names its groups.
        def asked(*args, **kwargs):
            self.fail('Telegram was asked about a group Nocheh does not serve')

        for served in (Served.of('42'), None):
            with self.subTest(served=served), patch('tools.operations.archive.archive.served_chats', side_effect=OSError('app down')):
                result = directory.directory(self.state, self.observed, asked, served)
                self.assertEqual([(group['id'], group['name']) for group in result['groups']], [('-10042', 'Old name')])

    def test_mismatched_chat_and_user_ids_cannot_label_saved_identities(self):
        def api(token, method, **params):
            if method == 'getChat': return {'id': -10099, 'type': 'supergroup', 'title': 'Wrong group'}
            if method == 'getChatAdministrators': return []
            return {'user': {'id': 999, 'first_name': 'Wrong user'}}

        result = directory.directory(self.state, {'groups': [], 'truncated': False}, api, self.served)
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
