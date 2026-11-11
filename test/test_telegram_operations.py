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

    def test_setup_makes_the_bot_folder_private(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            configuration.initialize(state)
            self.assertEqual((state / 'telegram').stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
