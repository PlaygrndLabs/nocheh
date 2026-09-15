import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import initialize,compose_environment,write_env,env_path
from scripts.settings import view,save
from scripts.operations import sha
from scripts.workflow_recovery import snapshot,validate,restore,REDIS_RESTORE_SCRIPT


class WorkflowRecoveryTests(unittest.TestCase):
    def test_dedicated_keys_are_private_idempotent_and_cannot_enable_cutover_through_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);values=initialize(root)
            keys=('INNGEST_EVENT_KEY','INNGEST_SIGNING_KEY','INNGEST_POSTGRES_PASSWORD')
            self.assertEqual(len({values[k] for k in keys}),3)
            self.assertTrue(all(len(values[k])==64 for k in keys))
            self.assertEqual(initialize(root),values)
            fields={field['key']:field for field in view(root)['fields']}
            for key in keys:
                self.assertIsNone(fields[key]['value']);self.assertFalse(fields[key]['editable'])
                self.assertTrue(fields[key]['secret'])
            with self.assertRaisesRegex(ValueError,'unsupported_setting'):
                save(root,{'NOCHEH_WORKFLOWS_ENABLED':'true'},view(root)['revision'])
            with patch.dict('os.environ',{'COMPOSE_PROFILES':'tools,workflows'}):
                self.assertEqual(compose_environment(root)['COMPOSE_PROFILES'],'tools')
            values['NOCHEH_WORKFLOWS_ENABLED']='false';write_env(env_path(root),values)
            self.assertNotIn('NOCHEH_WORKFLOWS_ENABLED',initialize(root))
            self.assertTrue((root/'workflows/redis').is_dir())
            self.assertNotIn('workflows',compose_environment(root)['COMPOSE_PROFILES'])

    def test_snapshot_requires_both_quiesced_stores_and_detects_corruption(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            def run(command,**kwargs):kwargs['stdout'].write(b'REDIS-fixture' if 'redis-cli' in command else b'database-fixture')
            with patch('scripts.workflow_recovery.fingerprints',return_value={'public.events':'hash'}),patch('scripts.workflow_recovery.subprocess.run',side_effect=run):
                metadata=snapshot(['fixture'],{},root,sha)
            validate(root,metadata,sha)
            (root/'workflow-redis.rdb').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError,'checksum'):validate(root,metadata,sha)
            (root/'workflow-redis.rdb').write_bytes(b'REDIS-fixture')
            metadata['tables']={'public.events;DROP DATABASE nocheh':'hash'}
            with self.assertRaisesRegex(ValueError,'table_invalid'):validate(root,metadata,sha)

    def test_restore_verifies_metadata_before_releasing_any_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);backup=root/'snapshot';backup.mkdir();state=root/'state';state.mkdir()
            def dump(command,**kwargs):kwargs['stdout'].write(b'fixture')
            with patch('scripts.workflow_recovery.fingerprints',return_value={'public.events':'hash'}),patch('scripts.workflow_recovery.subprocess.run',side_effect=dump):
                metadata=snapshot(['fixture'],{},backup,sha)
            commands=[]
            with patch('scripts.workflow_recovery.fingerprints',return_value=metadata['tables']),patch('scripts.workflow_recovery.subprocess.run',side_effect=lambda command,**kwargs:commands.append(command)):
                result=restore(['fixture'],{},backup,state,metadata,sha)
            self.assertFalse(result['active'])
            self.assertEqual(sha(state/'workflows/redis/dump.rdb'),metadata['workflow-redis.rdb']['sha256'])
            self.assertFalse(any('inngest' in c or 'workflow-worker' in c for c in commands))
            self.assertIn('--role=nocheh_inngest',commands[1])


class RedisRestoreStartupTests(unittest.TestCase):
    def run_restore(self, reject_config=False):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            server=root/'redis-server';server.write_text('#!/bin/sh\nexit 0\n');server.chmod(0o700)
            client=root/'redis-cli'
            client.write_text('#!'+sys.executable+'\n'+"""
import os,sys
from pathlib import Path
root=Path(os.environ['REDIS_TEST_DIR']);operation=sys.argv[3]
if operation=='ping':
    counter=root/'pings';count=int(counter.read_text())+1 if counter.exists() else 1
    counter.write_text(str(count));print('PONG' if count>=3 else 'LOADING Redis is loading the dataset in memory')
elif operation=='config':
    if int((root/'pings').read_text())<3:raise SystemExit(1)
    (root/'config').touch();print('ERR synthetic refusal' if os.environ['REDIS_TEST_REJECT']=='1' else 'OK')
elif operation=='info':
    (root/'info').touch();print('aof_rewrite_in_progress:0\\r\\naof_last_bgrewrite_status:ok')
elif operation=='shutdown':
    (root/'shutdown').touch();print('OK')
else:raise SystemExit(1)
""")
            client.chmod(0o700)
            result=subprocess.run(['sh','-c',REDIS_RESTORE_SCRIPT],env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],
                'REDIS_TEST_DIR':str(root),'REDIS_TEST_REJECT':'1' if reject_config else '0'},capture_output=True,text=True,timeout=15)
            self.assertGreaterEqual(int((root/'pings').read_text()),3)
            self.assertTrue((root/'shutdown').exists(),'temporary Redis is stopped on success and rejection')
            self.assertEqual((root/'info').exists(),not reject_config)
            return result.returncode

    def test_restore_waits_for_loaded_redis_before_enabling_aof(self):
        self.assertEqual(self.run_restore(),0)

    def test_redis_cli_error_text_cannot_claim_aof_enabled(self):
        self.assertNotEqual(self.run_restore(reject_config=True),0)
