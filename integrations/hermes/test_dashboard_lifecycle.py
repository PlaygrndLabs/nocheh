import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.dashboard import compose, start


class DashboardLifecycleTests(unittest.TestCase):
    def test_dashboard_uses_the_main_compose_project(self):
        with tempfile.TemporaryDirectory() as folder:
            command = compose(Path(folder))
        self.assertEqual(command[:2], ['docker', 'compose'])
        self.assertTrue(command[-1].endswith('/docker-compose.yml'))
        self.assertNotIn('-p', command)
        self.assertFalse(any('docker-compose.dashboard.yml' in item for item in command))

    def test_dashboard_stop_only_stops_its_main_project_service(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch('scripts.dashboard.request', return_value={'ok': True}), \
             patch('scripts.dashboard.compose_environment', return_value={}), \
             patch('scripts.dashboard.subprocess.call', return_value=0) as call:
            result = start(Path(folder), ['--stop'])
        self.assertEqual(result, 0)
        self.assertEqual(call.call_args.args[0][-2:], ['stop', 'dashboard'])


if __name__ == '__main__':
    unittest.main()
