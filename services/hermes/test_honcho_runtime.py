import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.installation.configuration import initialize,env_path,write_env,compose_environment,load
from tools.operations.memory.honcho_runtime import enable,operate

ROOT=Path(__file__).resolve().parents[2]

class HonchoRuntimeTests(unittest.TestCase):
    def test_profiles_cannot_activate_from_ambient_shell_or_inactive_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            values['NOCHEH_HONCHO_ENABLED']='false';write_env(env_path(state),values)
            with patch.dict(os.environ,{'COMPOSE_PROFILES':'honcho,honcho-tools,workflows'}):
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'')
                values['NOCHEH_HONCHO_ENABLED']='true';write_env(env_path(state),values)
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'honcho')
                (state/'spool/.restore-inactive').touch()
                self.assertEqual(compose_environment(state)['COMPOSE_PROFILES'],'')
                with self.assertRaisesRegex(ValueError,'inactive_restore'):operate(state,'up')

    def test_a_state_without_its_own_project_never_touches_the_installation(self):
        # A temporary state would otherwise fall back to the Compose file's
        # `nocheh` project and recreate the running installation's containers.
        from tools.operations.installation.settings import refresh_honcho
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            with patch('tools.operations.memory.honcho_runtime.subprocess.call') as call:
                for action in ('up','down'):
                    with self.assertRaisesRegex(ValueError,'state_project_required'):operate(state,action)
                values['NOCHEH_MODEL']='claude-opus-5-5'
                self.assertEqual(refresh_honcho(state,values),'skipped_unowned_state')
                call.assert_not_called()
            values['COMPOSE_PROJECT_NAME']='nocheh-synthetic-owned';write_env(env_path(state),values)
            with patch('tools.operations.memory.honcho_runtime.subprocess.call',return_value=0) as call,\
                    patch('tools.operations.memory.honcho_runtime.ensure_own_resources'):
                self.assertEqual(operate(state,'up'),0)
                self.assertEqual(call.call_args.kwargs['env']['COMPOSE_PROJECT_NAME'],'nocheh-synthetic-owned')

    def test_apply_restarts_a_container_left_on_an_older_route(self):
        # The generated files can already match the saved routes while a container
        # still runs an older route, after a start that failed; Compose recreates it.
        from tools.operations.installation.settings import refresh_honcho
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            values.update(COMPOSE_PROJECT_NAME='nocheh-synthetic-owned',NOCHEH_HONCHO_ENABLED='true')
            write_env(env_path(state),values)
            with patch('tools.operations.memory.honcho_runtime.operate',return_value=0) as up:
                self.assertEqual(refresh_honcho(state,values),'unchanged')
                self.assertEqual([call.args[1] for call in up.call_args_list],['up'])
            with patch('tools.operations.memory.honcho_runtime.operate',return_value=1):
                self.assertEqual(refresh_honcho(state,values),'failed')

    def test_other_project_volumes_block_and_clean_setup_uses_managed_volumes(self):
        # Several workspaces each run their own memory engine (ADR-0245); only another project's volume
        # or network under this workspace's names stops it.
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state);memory=state/'honcho'
            (memory/'internal_token').write_text('synthetic-memory-token')
            values['NOCHEH_MEMORY_TOKEN']='synthetic-memory-token';write_env(env_path(state),values)
            def held_by(project):
                return lambda command,**_:SimpleNamespace(returncode=0,stdout='{"com.docker.compose.project":"%s"}'%project)
            with patch('tools.operations.memory.honcho_runtime.subprocess.run',side_effect=held_by('nocheh-other')):
                with self.assertRaisesRegex(ValueError,'other_project_resources'):enable(state,memory)
            self.assertEqual(load(state)['NOCHEH_HONCHO_ENABLED'],values['NOCHEH_HONCHO_ENABLED'])
            asked=[]
            def missing(command,**_):
                asked.append(command[1:3]+command[-1:]);return SimpleNamespace(returncode=1,stdout='')
            with patch('tools.operations.memory.honcho_runtime.subprocess.run',side_effect=missing):
                enable(state,memory)
            self.assertEqual(asked,[['volume','inspect','nocheh_honcho_database'],['volume','inspect','nocheh_honcho_redis'],
                                    ['network','inspect','nocheh-memory']])
            with patch('tools.operations.memory.honcho_runtime.subprocess.run',side_effect=held_by('nocheh')):
                enable(state,memory)
            saved=load(state)
            self.assertEqual(saved['NOCHEH_HONCHO_ENABLED'],'true')
            self.assertEqual(saved['NOCHEH_HONCHO_DATABASE_VOLUME'],'nocheh_honcho_database')
            self.assertEqual(saved['NOCHEH_HONCHO_REDIS_VOLUME'],'nocheh_honcho_redis')

    @unittest.skipUnless(shutil.which('docker'),'Compose CLI unavailable')
    def test_resolved_compose_keeps_memory_private_and_uses_managed_volumes(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);values=initialize(state)
            values.update(NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_DATABASE_VOLUME='synthetic-preserved-db',NOCHEH_HONCHO_REDIS_VOLUME='synthetic-preserved-cache')
            write_env(env_path(state),values)
            raw=subprocess.check_output(['docker','compose','--env-file',str(env_path(state)),'-f',str(ROOT/'docker-compose.yml'),'--profile','honcho','--profile','honcho-tools','config','--format','json'],env=compose_environment(state),text=True,stderr=subprocess.PIPE,timeout=30)
            config=json.loads(raw);services=config['services']
            self.assertFalse(config['volumes']['honcho_database'].get('external',False))
            self.assertEqual(config['volumes']['honcho_database']['name'],'synthetic-preserved-db')
            self.assertTrue(config['networks']['honcho-isolated']['internal'])
            self.assertNotIn('honcho-isolated',services['hermes']['networks'])
            self.assertNotIn('memory',services['hermes']['networks'])
            self.assertEqual(set(services['honcho-postgres']['networks']),{'honcho-isolated'})
            self.assertNotIn('ports',services['honcho-api'])
            self.assertIn('honcho-memory',services['honcho-api']['networks']['memory']['aliases'])
            self.assertEqual(services['honcho-api']['image'],'nocheh-honcho:3326373c')
            self.assertIn('/nocheh/meter.py',services['honcho-provider-gateway']['command'])
            self.assertTrue(any(mount['source'].endswith('/services/honcho/meter.py')
                                for mount in services['honcho-provider-gateway']['volumes']))
            self.assertTrue(services['honcho-cli']['build']['context'].endswith('/services/honcho/cli'))
            # The state folder here is outside the checkout, as an owner's may be: the build file still sits inside
            # the build context, the one place Compose's Bake build reads without an extra file-read permission.
            from tools.operations.memory.honcho_setup import BUILD_FILE
            for name in ('honcho-api','honcho-deriver'):
                self.assertEqual(services[name]['build']['context'],str(ROOT/'data/compat/upstreams/honcho'))
                self.assertEqual(services[name]['build']['dockerfile'],BUILD_FILE)
            self.assertFalse(config['volumes']['honcho_redis'].get('external',False))
            self.assertEqual(services['honcho-redis']['volumes'][0]['source'],'honcho_redis')
            for name in ('honcho-postgres','honcho-redis','honcho-api','honcho-deriver','honcho-provider-gateway'):
                self.assertEqual(services[name]['restart'],'unless-stopped')
