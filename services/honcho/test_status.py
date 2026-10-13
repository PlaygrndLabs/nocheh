import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation.configuration import DEFAULTS, write_env
from tools.operations.memory import honcho

GATEWAY = {'id': 'gateway', 'name': 'Synthetic gateway', 'url': 'https://gateway.example.test/v1'}


class HonchoStatusTests(unittest.TestCase):
    def test_reasoning_provider_follows_the_configured_memory_route_without_its_key(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            provider = root / 'local'; provider.mkdir()
            values = {**DEFAULTS, 'NOCHEH_PROVIDERS': json.dumps([GATEWAY])}
            write_env(provider / '.env', values)
            with patch.object(honcho, 'STATE', root / 'honcho'), \
                 patch.object(honcho, 'PROVIDER_STATE', provider), \
                 patch.object(honcho, 'enabled', return_value=False):
                # A fresh installation has no provider for memory.
                self.assertFalse(honcho.status()['reasoning_provider_configured'])
                write_env(provider / '.env', {**values, 'NOCHEH_PROVIDER_KEYS': '{"gateway":"private-key"}',
                                              'NOCHEH_MEMORY_PROVIDER': 'gateway'})
                result = honcho.status()
                self.assertTrue(result['reasoning_provider_configured'])
                self.assertIn('running', result)
                self.assertNotIn('private', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
