import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts import honcho_recovery as recovery
from scripts.operations import sha


class HonchoRecoveryTests(unittest.TestCase):
    def snapshot(self,root):
        def dump(command,**kwargs):kwargs['stdout'].write(b'synthetic memory dump')
        with patch.object(recovery,'fingerprints',return_value={'public.peers':'exact-hash'}),patch.object(recovery.subprocess,'run',side_effect=dump):
            return recovery.snapshot(['fixture'],{},root,sha)

    def test_dump_corruption_and_untrusted_table_names_fail_before_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.snapshot(root)
            recovery.validate(root,metadata,sha)
            (root/'honcho.dump').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError,'checksum'):recovery.validate(root,metadata,sha)
            (root/'honcho.dump').write_bytes(b'synthetic memory dump')
            metadata['tables']={'public.peers; DELETE FROM peers':'bad'}
            with self.assertRaisesRegex(ValueError,'table_invalid'):recovery.validate(root,metadata,sha)

    def test_restore_keeps_memory_writers_inactive_and_never_adopts_existing_volumes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.snapshot(root);state=root/'state';(state/'honcho').mkdir(parents=True)
            (state/'honcho/database_password').write_text('synthetic')
            env={'NOCHEH_HONCHO_DATABASE_VOLUME':'fixture-memory-db','NOCHEH_HONCHO_REDIS_VOLUME':'fixture-memory-cache'}
            with patch.object(recovery.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run:
                with self.assertRaisesRegex(ValueError,'volume_exists'):recovery.restore(['fixture'],env,root,state,metadata,sha)
                self.assertEqual(run.call_count,1)
            calls=[]
            def run(command,**kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command,1 if command[:3]==['docker','volume','inspect'] else 0)
            with patch.object(recovery.subprocess,'run',side_effect=run),patch.object(recovery,'fingerprints',return_value=metadata['tables']):
                recovery.restore(['fixture'],env,root,state,metadata,sha)
            self.assertEqual(calls[-1][-2:],['stop','honcho-postgres'])
            self.assertFalse(any('honcho-api' in c or 'honcho-deriver' in c or 'honcho-provider-gateway' in c for c in calls))
            self.assertTrue(any('pg_restore' in c for c in calls))

    def test_failed_restore_stops_database_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.snapshot(root);state=root/'state';(state/'honcho').mkdir(parents=True)
            (state/'honcho/database_password').write_text('synthetic')
            env={'NOCHEH_HONCHO_DATABASE_VOLUME':'fixture-memory-db','NOCHEH_HONCHO_REDIS_VOLUME':'fixture-memory-cache'}
            calls=[]
            def run(command,**kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command,1 if command[:3]==['docker','volume','inspect'] else 0)
            with patch.object(recovery.subprocess,'run',side_effect=run),patch.object(recovery,'fingerprints',return_value={}):
                with self.assertRaisesRegex(RuntimeError,'fingerprint_mismatch'):recovery.restore(['fixture'],env,root,state,metadata,sha)
            self.assertEqual(calls[-1][-2:],['stop','honcho-postgres'])
