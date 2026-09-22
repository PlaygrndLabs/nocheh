import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import honcho


class HonchoStatusTests(unittest.TestCase):
    def test_login_uses_single_shared_provider_credential_not_retired_bridge_store(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            experiment = root / 'experiment'
            bridge = experiment / 'bridge-auth'
            bridge.mkdir(parents=True)
            (bridge / 'old.json').write_text('{}')
            provider = root / 'local'
            auth = provider / 'provider/auth'
            auth.mkdir(parents=True)
            credential = {'type': 'codex', 'access_token': 'private-access',
                          'refresh_token': 'private-refresh'}
            with patch.object(honcho, 'STATE', experiment), \
                 patch.object(honcho, 'PROVIDER_STATE', provider), \
                 patch.object(honcho, 'enabled', return_value=False):
                self.assertFalse(honcho.status()['subscription_login'])
                (auth / 'one.json').write_text(json.dumps(credential))
                result = honcho.status()
                self.assertTrue(result['subscription_login'])
                self.assertIn('running', result)
                self.assertNotIn('private', json.dumps(result))
                (auth / 'two.json').write_text(json.dumps(credential))
                self.assertFalse(honcho.status()['subscription_login'])
                (auth / 'two.json').unlink()
                (auth / 'one.json').write_text(json.dumps({**credential, 'disabled': True}))
                self.assertFalse(honcho.status()['subscription_login'])


if __name__ == '__main__':
    unittest.main()
