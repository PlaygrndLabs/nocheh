import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import initialize,env_path,write_env,compose_environment,load
from scripts.honcho_runtime import enable,operate

ROOT=Path(__file__).resolve().parents[2]

class HonchoRuntimeTests(unittest.TestCase):
    def test_profiles_cannot_activate_from_ambient_shell_or_inactive_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            with patch.dict(os.environ,{'COMPOSE_PROFILES':'honcho,honcho-tools,workflows'}):
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'')
                values['NOCHEH_HONCHO_ENABLED']='true';write_env(env_path(state),values)
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'honcho')
                (state/'spool/.restore-inactive').touch()
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'')
                with self.assertRaisesRegex(ValueError,'inactive_restore'):operate(state,'up')

    def test_legacy_writers_and_existing_data_prevent_automatic_new_database(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state);memory=state/'honcho';memory.mkdir()
            (memory/'internal_token').write_text('synthetic-memory-token')
            values['NOCHEH_MEMORY_TOKEN']='synthetic-memory-token';write_env(env_path(state),values)
            with patch('scripts.honcho_runtime.subprocess.check_output',return_value='running-id\n'):
                with self.assertRaisesRegex(ValueError,'quiesced_migration'):enable(state,memory)
            with patch('scripts.honcho_runtime.subprocess.check_output',return_value=''),patch('scripts.honcho_runtime.subprocess.run',return_value=subprocess.CompletedProcess([],0)) as run:
                with self.assertRaisesRegex(ValueError,'verified_adoption'):enable(state,memory)
                self.assertEqual(run.call_count,1)
            self.assertEqual(load(state)['NOCHEH_HONCHO_ENABLED'],'false')

    @unittest.skipUnless(shutil.which('docker'),'Compose CLI unavailable')
    def test_resolved_compose_keeps_memory_private_and_uses_preserved_external_volumes(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            values.update(NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_DATABASE_VOLUME='synthetic-preserved-db',NOCHEH_HONCHO_REDIS_VOLUME='synthetic-preserved-cache')
            write_env(env_path(state),values)
            raw=subprocess.check_output(['docker','compose','--env-file',str(env_path(state)),'-f',str(ROOT/'docker-compose.yml'),'--profile','honcho','--profile','honcho-tools','config','--format','json'],env=compose_environment(state),text=True,stderr=subprocess.PIPE,timeout=30)
            config=json.loads(raw);services=config['services']
            self.assertTrue(config['volumes']['honcho_database']['external'])
            self.assertEqual(config['volumes']['honcho_database']['name'],'synthetic-preserved-db')
            self.assertTrue(config['networks']['honcho-isolated']['internal'])
            self.assertNotIn('honcho-isolated',services['hermes']['networks'])
            self.assertNotIn('memory',services['hermes']['networks'])
            self.assertEqual(set(services['honcho-postgres']['networks']),{'honcho-isolated'})
            self.assertNotIn('ports',services['honcho-api'])
            self.assertIn('honcho-memory',services['honcho-api']['networks']['memory']['aliases'])
            self.assertEqual(services['honcho-api']['image'],'nocheh-honcho:be543555')
            self.assertIn('/nocheh/meter.py',services['honcho-provider-gateway']['command'])
            self.assertTrue(any(mount['source'].endswith('/integrations/honcho/meter.py')
                                for mount in services['honcho-provider-gateway']['volumes']))
            self.assertTrue(services['honcho-cli']['build']['context'].endswith('/integrations/honcho/cli'))
            self.assertTrue(config['volumes']['honcho_redis']['external'])
            self.assertEqual(services['honcho-redis']['volumes'][0]['source'],'honcho_redis')
            for name in ('honcho-postgres','honcho-redis','honcho-api','honcho-deriver','honcho-provider-gateway'):
                self.assertEqual(services[name]['restart'],'unless-stopped')
