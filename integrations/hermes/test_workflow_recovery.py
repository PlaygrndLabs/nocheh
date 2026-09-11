import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import initialize,compose_environment,write_env,env_path
from scripts.settings import view,save
from scripts.operations import sha
from scripts.workflow_recovery import snapshot,validate,restore


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
            values['NOCHEH_WORKFLOWS_ENABLED']='true';write_env(env_path(root),values);initialize(root)
            self.assertTrue((root/'workflows/redis').is_dir())
            self.assertIn('workflows',compose_environment(root)['COMPOSE_PROFILES'])

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
