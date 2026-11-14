import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.operations.installation.configuration import initialize, load, write_env, env_path
from tools.operations.installation import database_viewer


class DatabaseViewerTests(unittest.TestCase):
    """The optional pgweb viewer gets a web login of its own (ADR-0251)."""

    def test_db_makes_the_login_once_keeps_it_and_prints_it_never_in_a_command_line(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            calls = []
            def call(arguments, **options): calls.append((arguments, options)); return 0
            def run(arguments, **options):
                calls.append((arguments, options)); return SimpleNamespace(returncode=0, stdout='', stderr='')
            outputs = []
            for _ in range(2):
                printed = io.StringIO()
                with patch.object(database_viewer.subprocess, 'call', side_effect=call), \
                        patch.object(database_viewer.subprocess, 'run', side_effect=run), \
                        patch.object(database_viewer, 'compose_environment', side_effect=lambda s: {**load(s), 'NOCHEH_VIEWER_PORT': '8782'}), \
                        contextlib.redirect_stdout(printed):
                    self.assertEqual(database_viewer.start(state, ['docker', 'compose'], Path(folder)), 0)
                outputs.append(printed.getvalue())
            password = load(state)['NOCHEH_VIEWER_WEB_PASSWORD']
            self.assertRegex(password, r'^[0-9a-f]{64}$')
            self.assertNotEqual(password, load(state)['NOCHEH_VIEWER_PASSWORD'], 'the web login is not the database login')
            for printed in outputs:
                self.assertIn('Read-only archive browser: http://127.0.0.1:8782', printed)
                self.assertIn('User: owner', printed); self.assertIn('Password: ' + password, printed)
            self.assertEqual(outputs[0], outputs[1], 'the same login every time')
            for arguments, options in calls:
                self.assertFalse(any(password in str(part) for part in arguments), arguments)
            # Compose reads it from the environment it is given, the ignored .env's values.
            last = [options for arguments, options in calls if 'pgweb-archive' in arguments][-1]
            self.assertEqual(last['env']['NOCHEH_VIEWER_WEB_PASSWORD'], password)

    def test_a_malformed_web_password_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); values = initialize(state)
            values['NOCHEH_VIEWER_WEB_PASSWORD'] = 'short'; write_env(env_path(state), values)
            with self.assertRaisesRegex(ValueError, 'NOCHEH_VIEWER_WEB_PASSWORD'):
                database_viewer.start(state, ['docker', 'compose'], Path(folder))

    def test_up_gives_a_running_viewer_its_login_and_leaves_a_stopped_one(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            for ps, expected in (('', False), ('0123abcd\n', True)):
                calls = []
                def call(arguments, **options): calls.append(arguments); return 0
                def run(arguments, ps=ps, **options):
                    calls.append(arguments); return SimpleNamespace(returncode=0, stdout=ps, stderr='')
                printed = io.StringIO()
                with patch.object(database_viewer.subprocess, 'call', side_effect=call), \
                        patch.object(database_viewer.subprocess, 'run', side_effect=run), \
                        patch.object(database_viewer, 'compose_environment', side_effect=lambda s: {**load(s), 'NOCHEH_VIEWER_PORT': '8782'}), \
                        contextlib.redirect_stdout(printed):
                    self.assertEqual(database_viewer.refresh(state, ['docker', 'compose'], Path(folder)), 0)
                restarted = ['docker', 'compose', '--profile', 'tools', 'up', '-d', '--wait', '--no-deps', 'pgweb-archive'] in calls
                self.assertEqual(restarted, expected)
                self.assertEqual('NOCHEH_VIEWER_WEB_PASSWORD' in load(state), expected, 'a stopped viewer is left as it is')
            password = load(state)['NOCHEH_VIEWER_WEB_PASSWORD']
            self.assertIn('now asks for a login', printed.getvalue()); self.assertIn('Password: ' + password, printed.getvalue())
            # Docker that can't be asked is reported, and up keeps its own result.
            with patch.object(database_viewer.subprocess, 'run', side_effect=FileNotFoundError('docker')), \
                    contextlib.redirect_stdout(io.StringIO()) as printed:
                self.assertEqual(database_viewer.refresh(state, ['docker', 'compose'], Path(folder)), 1)
            self.assertIn('./bin/nocheh db', printed.getvalue())


if __name__ == '__main__':
    unittest.main()
