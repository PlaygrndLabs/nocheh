"""Operations reach nocheh-telegram, the only Telegram poller, and never ask Hermes about Telegram."""

import contextlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.operations.archive import telegram_directory
from tools.operations.installation import admin_operations, configuration, operations

OPERATIONS = 'tools.operations.installation.operations'


class TelegramOperationsTests(unittest.TestCase):
    def test_backup_stops_the_bot_before_the_brain_and_keeps_its_incident(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); state = root / 'state'; state.mkdir()
            (state / '.env').write_text('TELEGRAM_ENABLED=false\n')
            for name in ('files', 'spool', 'hermes', 'telegram'): (state / name).mkdir()
            (state / 'telegram/telegram-incident.json').write_text('{"state":"failed","error_code":"telegram_network_error"}')
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                if 'pg_dump' in command: kwargs['stdout'].write(b'synthetic database dump')
            with patch(OPERATIONS + '.compose', return_value=['fixture']), patch(OPERATIONS + '.environment', return_value={}), \
                    patch(OPERATIONS + '.subprocess.check_output', side_effect=['hermes\nnocheh-app\nnocheh-telegram\n', 'fixture-revision']), \
                    patch(OPERATIONS + '.fingerprints', return_value={}), patch(OPERATIONS + '.subprocess.run', side_effect=run), \
                    patch('tools.operations.workflows.workflow_worker.running', return_value=False):
                operations.backup(state, root / 'backup')
            stops = [command[-1] for command in commands if command[1] == 'stop']
            self.assertEqual(stops, ['nocheh-telegram', 'hermes', 'nocheh-app'])
            self.assertIn('telegram/telegram-incident.json', operations.validate_snapshot(root / 'backup')['files'])

    def test_a_state_without_the_bot_folder_still_backs_up(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); state = root / 'state'; state.mkdir()
            (state / '.env').write_text('TELEGRAM_ENABLED=false\n')
            for name in ('files', 'spool', 'hermes'): (state / name).mkdir()
            with patch(OPERATIONS + '.compose', return_value=['fixture']), patch(OPERATIONS + '.environment', return_value={}), \
                    patch(OPERATIONS + '.subprocess.check_output', side_effect=['', 'fixture-revision']), \
                    patch(OPERATIONS + '.fingerprints', return_value={}), \
                    patch(OPERATIONS + '.subprocess.run', side_effect=lambda command, **kwargs: 'pg_dump' in command and kwargs['stdout'].write(b'dump')), \
                    patch('tools.operations.workflows.workflow_worker.running', return_value=False):
                self.assertEqual(operations.backup(state, root / 'backup')['status'], 'backed_up')

    def test_restore_makes_the_bot_folder_and_starts_the_bot_with_telegram_off(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); snapshot = root / 'snapshot'; snapshot.mkdir(); state = root / 'restored'
            (snapshot / 'archive.dump').write_bytes(b'dump')
            with tarfile.open(snapshot / 'state.tar.gz', 'w:gz') as tar:
                raw = b'{}'; info = tarfile.TarInfo('state/files/example'); info.size = len(raw); tar.addfile(info, io.BytesIO(raw))
            manifest = {'version': 1, 'tables': {'events': 'exact-hash'}, 'files': {'files/example': {}}}
            starts = []
            def run(command, **kwargs):
                if command[:3] == ['docker', 'volume', 'inspect']: return SimpleNamespace(returncode=1)
                if 'up' in command: starts.append(command)
                return SimpleNamespace(returncode=0)
            with patch(OPERATIONS + '.validate_snapshot', return_value=manifest), \
                    patch(OPERATIONS + '.initialize', return_value={'TELEGRAM_ENABLED': 'true'}), \
                    patch(OPERATIONS + '.compose', return_value=['fixture']), patch(OPERATIONS + '.environment', return_value={}), \
                    patch(OPERATIONS + '.fingerprints', return_value=manifest['tables']), patch(OPERATIONS + '.subprocess.run', side_effect=run):
                operations.restore(snapshot, state, 'nocheh-test-restore', 18980)
            self.assertEqual((state / 'telegram').stat().st_mode & 0o777, 0o700)
            self.assertIn('nocheh-telegram', starts[-1])
            self.assertIn("TELEGRAM_ENABLED='false'", (state / '.env').read_text())

    def test_diagnose_reads_telegram_from_the_bot_and_keeps_hermes_health(self):
        answers = {'nocheh-telegram': {'ok': True, 'service': 'telegram', 'telegram': 'disabled', 'telegram_details': {}},
                   'hermes': {'ok': True}}
        execs = []
        def check_output(command, **_):
            service = command[command.index('-T') + 1]; execs.append((service, command[-1]))
            return json.dumps(answers[service])
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as folder, patch(OPERATIONS + '.compose', return_value=['fixture']), \
                patch(OPERATIONS + '.environment', return_value={}), patch(OPERATIONS + '.load', return_value={'SERVICE_TOKEN': 'synthetic'}), \
                patch(OPERATIONS + '.archive_url', return_value='http://archive.invalid'), \
                patch(OPERATIONS + '.urllib.request.urlopen', side_effect=OSError), \
                patch('tools.operations.installation.services.containers', return_value=[]), \
                patch(OPERATIONS + '.subprocess.check_output', side_effect=check_output), contextlib.redirect_stdout(output):
            operations.main('diagnose', Path(folder), [])
        result = json.loads(output.getvalue())
        self.assertEqual((result['telegram'], result['hermes']), (answers['nocheh-telegram'], answers['hermes']))
        self.assertIn('127.0.0.1:8784/health', dict(execs)['nocheh-telegram'])
        self.assertIn('127.0.0.1:8781/health', dict(execs)['hermes'])

    def test_find_my_id_and_restart_reach_the_bot(self):
        with patch.object(telegram_directory, 'compose', return_value=(['fixture'], {})), \
                patch.object(telegram_directory.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{"chats":[]}')) as run:
            self.assertEqual(telegram_directory._bot_discovery(None), {'chats': []})
        self.assertEqual(run.call_args.args[0], ['fixture', 'exec', '-T', 'nocheh-telegram', 'python', '-m', 'services.telegram.discover'])
        with tempfile.TemporaryDirectory() as folder, patch(OPERATIONS + '.compose', return_value=['fixture']), \
                patch(OPERATIONS + '.environment', return_value={}), patch.object(admin_operations.subprocess, 'run') as run:
            admin_operations.run(Path(folder), 'restart', '11111111-1111-4111-8111-111111111111')
        self.assertTrue(all('nocheh-telegram' in call.args[0] for call in run.call_args_list))

    def test_directory_names_groups_by_their_nocheh_id_and_keeps_who_their_messages_show(self):
        # Storage names each group by its Nocheh id, with its Telegram ids beside it (ADR-0252). The dashboard opens a group
        # by that id, so it stays the group's id here; TELEGRAM_GROUP_IDS, which names a group Telegram upgraded by its
        # earlier id, finds the group through any of its Telegram ids, and only Telegram ids are sent to Telegram.
        newer, upgraded = 'a' * 64, 'c' * 64
        archive = {'groups': [
            # Stored before step 2b: its Nocheh id is the Telegram id it had then; Telegram upgraded it since.
            {'id': '-1001000000001', 'external': '-1001000000009', 'telegram_ids': ['-1001000000009', '-1001000000001'],
             'name': 'Aurora planning', 'users': [
                {'id': '73', 'name': 'Mira Chen', 'username': '@mira', 'state': 'in', 'seen': True},
                {'id': '95', 'name': 'Lee', 'username': None, 'state': 'left', 'seen': False}]},
            {'id': newer, 'external': '-1002000000001', 'telegram_ids': ['-1002000000001'], 'name': 'Night sky club', 'users': [
                {'id': '91', 'name': 'Nia', 'username': None, 'state': 'left', 'seen': True}]},
            # First seen after step 2b as a basic group, then upgraded.
            {'id': upgraded, 'external': '-1003000000001', 'telegram_ids': ['-1003000000001', '-4000000000001'], 'name': 'Garden swap',
             'users': []},
            # No Telegram id here (imported): still named by its Nocheh id.
            {'id': 'b' * 64, 'external': None, 'telegram_ids': [], 'name': 'Gone', 'users': []},
            {'id': 'not an id', 'external': '-1009000000001', 'name': 'Broken', 'users': []}], 'truncated': False}
        values = {'TELEGRAM_GROUP_IDS': '-1001000000001,-1002000000001,-4000000000001,-1004000000001', 'TELEGRAM_BOT_TOKEN': '',
                  'TELEGRAM_OWNER_ID': '123', 'TELEGRAM_GROUP_ACCESS': '{}'}
        with patch.object(telegram_directory, 'load', return_value=values):
            result = telegram_directory.directory(None, archive=archive)
        self.assertEqual(result, {'groups': [
            # Only TELEGRAM_GROUP_IDS names it, so it is named by that Telegram id, as before step 2b.
            {'id': '-1004000000001', 'external': '-1004000000001', 'name': None, 'users': []},
            {'id': '-1001000000001', 'external': '-1001000000009', 'name': 'Aurora planning', 'users': [
                {'id': '95', 'name': 'Lee', 'username': None, 'state': 'left', 'seen': False},
                {'id': '73', 'name': 'Mira Chen', 'username': '@mira', 'state': 'in', 'seen': True}]},
            {'id': upgraded, 'external': '-1003000000001', 'name': 'Garden swap', 'users': []},
            {'id': 'b' * 64, 'external': None, 'name': 'Gone', 'users': []},
            {'id': newer, 'external': '-1002000000001', 'name': 'Night sky club', 'users': [{'id': '91', 'name': 'Nia', 'username': None, 'state': 'left', 'seen': True}]}],
            'truncated': False})
        # With a bot token, Telegram is asked about each listed group by the Telegram id the list gives, and what it says
        # lands on the group storage knows.
        asked = []

        def api(token, method, **params):
            asked.append((method, params['chat_id']))
            if method == 'getChat' and params['chat_id'] == '-1002000000001': return {'id': -1002000000001, 'type': 'supergroup', 'title': 'Night sky'}
            if method == 'getChatAdministrators' and params['chat_id'] == '-1002000000001': return [{'user': {'id': 456, 'first_name': 'Bob'}}]
            return None
        with patch.object(telegram_directory, 'load', return_value={**values, 'TELEGRAM_BOT_TOKEN': 'fixture-secret'}):
            named = telegram_directory.directory(None, archive=archive, bot_api=api)
        night = next(group for group in named['groups'] if group['id'] == newer)
        self.assertEqual((night['name'], [user['id'] for user in night['users']]), ('Night sky', ['456', '91']))
        self.assertEqual({chat for _, chat in asked}, {'-1001000000001', '-1002000000001', '-4000000000001', '-1004000000001'})
        self.assertEqual(len(named['groups']), 5, 'each listed group is the one storage knows')

    def test_setup_makes_the_bot_folder_private(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            configuration.initialize(state)
            self.assertEqual((state / 'telegram').stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
