import contextlib
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation.dashboard import compose, script_reports, start


class DashboardLifecycleTests(unittest.TestCase):
    def test_dashboard_uses_the_main_compose_project(self):
        with tempfile.TemporaryDirectory() as folder:
            command = compose(Path(folder))
        self.assertEqual(command[:2], ['docker', 'compose'])
        self.assertTrue(command[-1].endswith('/docker-compose.yml'))
        self.assertNotIn('-p', command)
        self.assertFalse(any('docker-compose.dashboard.yml' in item for item in command))

    def test_dashboard_stop_does_not_stop_runtime_containers(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch('tools.operations.installation.dashboard.request', return_value={'ok': True}), \
             patch('tools.operations.installation.dashboard.compose_environment', return_value={}), \
             patch('tools.operations.installation.dashboard.subprocess.call', return_value=0) as call:
            result = start(Path(folder), ['--stop'])
        self.assertEqual(result, 0)
        self.assertEqual(call.call_args.args[0][-2:],['stop','nocheh-dashboard'])

    def test_clear_pause_starts_the_dashboard_then_ends_every_sign_in_pause_with_the_installation_token(self):
        calls = []
        def answer(state, path, body=None): calls.append((path, body)); return {'cleared': 1}
        with tempfile.TemporaryDirectory() as folder, \
             patch('tools.operations.installation.dashboard.request', side_effect=answer), \
             patch('tools.operations.installation.dashboard.compose_environment', return_value={}), \
             patch('tools.operations.installation.dashboard.subprocess.run') as run, \
             contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(start(Path(folder), ['--clear-pause', '--no-open']), 0)
        self.assertEqual(run.call_args.args[0][-1], 'nocheh-dashboard')
        self.assertEqual(calls, [('/owner-lock/clear-pause', {})])
        self.assertIn('Sign-in pause cleared', printed.getvalue())
        # A dashboard that does not answer is said plainly, with a non-zero exit.
        with tempfile.TemporaryDirectory() as folder, \
             patch('tools.operations.installation.dashboard.request', side_effect=urllib.error.URLError('refused')), \
             patch('tools.operations.installation.dashboard.compose_environment', return_value={}), \
             patch('tools.operations.installation.dashboard.subprocess.run'), \
             contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(start(Path(folder), ['--clear-pause', '--no-open']), 1)
        self.assertIn('could not be cleared', printed.getvalue())
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            start(Path(folder), ['--clear-pause', '--stop'])

    def test_diagnose_shows_the_hermes_page_script_reports_without_page_text(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            self.assertEqual(script_reports(state), {'mode': 'report_only', 'total': 0, 'first_at': None, 'last_at': None, 'kinds': []})
            (state / 'admin/dashboard').mkdir(parents=True)
            (state / 'admin/dashboard/csp-reports.json').write_text(json.dumps({'total': 3, 'first_at': '2026-01-02T03:04:05.000Z',
                'last_at': '2026-01-03T03:04:05.000Z', 'kinds': [{'directive': 'script-src-elem', 'blocked': 'inline', 'page': '/hermes/chat',
                                                                   'count': 3, 'first_at': '2026-01-02T03:04:05.000Z', 'last_at': '2026-01-03T03:04:05.000Z'}]}))
            shown = script_reports(state)
            self.assertEqual((shown['total'], shown['kinds'][0]['directive'], shown['kinds'][0]['count']), (3, 'script-src-elem', 3))
            (state / 'admin/dashboard/csp-reports.json').write_text('{not json')
            self.assertEqual(script_reports(state), {'mode': 'report_only', 'error': 'unreadable'})


if __name__ == '__main__':
    unittest.main()
