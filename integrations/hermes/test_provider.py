import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.configuration import initialize as initialize_configuration
from scripts.provider import CLIENTS,initialize,login_state,status
from scripts.provider_acceptance import _retire_native_login,cutover
from integrations.hermes.subscription import SHARED_BASE_URL,resolve_credentials
from integrations.hermes.verify import valid_refresh


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
            self.assertTrue((state/'provider/monitor').is_dir())
            self.assertEqual(len((state/'provider/keys/monitor-admin.key').read_text().strip()),64)
            self.assertEqual(len((state/'provider/keys/monitor-data.key').read_text().strip()),64)
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

    def test_shared_route_resolves_only_the_scoped_hermes_key(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'hermes.key';path.write_text('h'*32)
            with patch.dict('os.environ',{'NOCHEH_REASONING_ROUTE':'shared','CLIPROXY_HERMES_KEY_FILE':str(path)}):
                credentials=resolve_credentials()
            self.assertEqual(credentials.runtime(),{'api_key':'h'*32,'base_url':SHARED_BASE_URL,
                'provider':'openai','api_mode':'chat_completions'})
            link=Path(folder)/'linked.key';link.symlink_to(path)
            with patch.dict('os.environ',{'NOCHEH_REASONING_ROUTE':'shared','CLIPROXY_HERMES_KEY_FILE':str(link)}):
                with self.assertRaises(ValueError):resolve_credentials()

    def test_proxy_build_disables_hidden_unauthorized_replay(self):
        path=Path(__file__).resolve().parents[2]/'deploy/cliproxy.Dockerfile'
        if not path.is_file():self.skipTest('deployment sources are outside the runtime image')
        dockerfile=path.read_text()
        self.assertIn("grep -c 'false && okRefresh'",dockerfile)
        self.assertIn('test \"$(grep -c',dockerfile)

    def test_exactly_one_active_codex_login_is_required(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize(state);auth=state/'provider/auth'
            (auth/'one.json').write_text(json.dumps({'type':'codex','access_token':'token-one','refresh_token':'refresh-one'}))
            self.assertTrue(login_state(state)['login_present'])
            (auth/'two.json').write_text(json.dumps({'type':'codex','access_token':'token-two','refresh_token':'refresh-two'}))
            current=login_state(state)
            self.assertFalse(current['login_present']);self.assertEqual(current['login_count'],2)
            (auth/'two.json').write_text('{')
            current=login_state(state)
            self.assertFalse(current['login_present']);self.assertEqual(current['invalid_login_files'],1)

    def test_cutover_stays_native_without_fresh_provider_login(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize_configuration(state)
            result=cutover(state)
            self.assertEqual(result['status'],'credentials_pending')
            saved=json.loads((state/'reports/shared-provider-acceptance.json').read_text())
            self.assertEqual(saved['status'],'credentials_pending')
            from scripts.configuration import load
            self.assertEqual(load(state)['NOCHEH_REASONING_ROUTE'],'native')

    def test_native_login_retires_and_refresh_owner_is_route_specific(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);source=state/'hermes/auth.json';source.parent.mkdir(parents=True)
            source.write_text('{\"refresh_token\":\"private\"}')
            self.assertEqual(_retire_native_login(state),'retired');self.assertFalse(source.exists())
            retired=list((state/'provider/retired').glob('*.json'));self.assertEqual(len(retired),1)
            self.assertEqual(retired[0].stat().st_mode&0o777,0o600)
        self.assertTrue(valid_refresh('shared',{'refreshed':False,'owner':'cliproxy'}))
        self.assertFalse(valid_refresh('shared',{'refreshed':True,'owner':'hermes'}))
        self.assertTrue(valid_refresh('native',{'refreshed':True,'owner':'hermes'}))
