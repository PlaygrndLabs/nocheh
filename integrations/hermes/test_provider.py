import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.configuration import initialize as initialize_configuration
from scripts.provider import CLIENTS,initialize,status


class SharedProviderTests(unittest.TestCase):
    def test_initializer_creates_distinct_private_clients_and_locked_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);result=initialize(state)
            config=json.loads((state/'provider/config.yaml').read_text())
            self.assertEqual(result['clients'],list(CLIENTS))
            self.assertEqual(len(set(config['api-keys'])),3)
            self.assertEqual(config['request-retry'],0)
            self.assertEqual(config['max-retry-credentials'],1)
            self.assertTrue(config['usage-statistics-enabled'])
            self.assertEqual(config['redis-usage-queue-retention-seconds'],300)
            self.assertFalse(config['quota-exceeded']['switch-project'])
            self.assertTrue(config['remote-management']['allow-remote'])
            self.assertTrue(config['remote-management']['disable-control-panel'])
            for path in (state/'provider').rglob('*'):
                if path.is_file():self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_initializer_is_idempotent_and_status_never_returns_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize_configuration(state)
            before={p.name:p.read_text() for p in (state/'provider/keys').glob('*.key')}
            with patch('scripts.provider.subprocess.check_output',side_effect=OSError()):result=status(state)
            self.assertEqual(before,{p.name:p.read_text() for p in (state/'provider/keys').glob('*.key')})
            encoded=json.dumps(result)
            self.assertFalse(any(value in encoded for value in before.values()))
            self.assertFalse(result['running']);self.assertFalse(result['login_present'])
