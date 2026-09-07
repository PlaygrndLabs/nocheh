import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import initialize, read_env, write_env, env_path, load, compose_environment
from integrations.hermes.environment import secret, telegram_policy


class ConfigurationTests(unittest.TestCase):
    def test_literal_roundtrip_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'.env'
            values={'TOKEN': "abc$NOT_EXPANDED# with ' quote", 'EMPTY':'', 'JSON':'["x"]'}
            write_env(path,values)
            self.assertEqual(read_env(path),values)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            path.write_text('A="quoted" # comment\nB=literal # comment\n')
            self.assertEqual(read_env(path),{'A':'quoted','B':'literal'})
            path.write_text('A=first\nA=second\n')
            with self.assertRaisesRegex(ValueError,'Duplicate'): read_env(path)

    def test_setup_preserves_archive_credentials_without_importing_provider_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'secrets').mkdir()
            (state/'secrets/database_password').write_text('old-db-password-'*3)
            (state/'secrets/service_token').write_text('old-service-token-'*3)
            (state/'.env').write_text('UNRELATED_PROVIDER_KEY=unused\n')
            values=initialize(state)
            self.assertNotIn('UNRELATED_PROVIDER_KEY',values)
            self.assertEqual(values['POSTGRES_PASSWORD'],'old-db-password-'*3)
            self.assertEqual(values['SERVICE_TOKEN'],'old-service-token-'*3)
            self.assertTrue((state/'previous-configuration/legacy.env').is_file())
            self.assertEqual(initialize(state),values)
            # An active .env must never inherit settings from retired sidecars.
            (state/'assistant.json').write_text('{"enabled":true,"owner_id":"42","group_ids":[]}')
            self.assertEqual(initialize(state)['TELEGRAM_ENABLED'],'false')

    def test_isolated_state_does_not_use_root_credentials_or_shell_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with self.assertRaises(ValueError): load(state)
            values=initialize(state)
            self.assertEqual(env_path(state),state.resolve()/'.env')
            with patch.dict(os.environ,{'SERVICE_TOKEN':'stale-shell-value'}):
                self.assertEqual(compose_environment(state)['SERVICE_TOKEN'],values['SERVICE_TOKEN'])

    def test_environment_policy_and_explicit_empty_secret(self):
        with patch.dict(os.environ,{'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':'-10, -20','TELEGRAM_BOT_TOKEN':'','TELEGRAM_BOT_TOKEN_FILE':'/does/not/exist'},clear=True):
            self.assertEqual(telegram_policy(),{'enabled':True,'owner_id':'42','group_ids':['-10','-20']})
            self.assertEqual(secret('TELEGRAM_BOT_TOKEN',required=False),'')
            with self.assertRaises(ValueError): secret('TELEGRAM_BOT_TOKEN')

    def test_native_admin_port_follows_isolated_archive_port(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); values = initialize(state)
            values['NOCHEH_PORT'] = '8795'; write_env(env_path(state), values)
            self.assertEqual(compose_environment(state)['NOCHEH_NATIVE_ADMIN_PORT'], '8800')
