import copy
import json
import io
import tempfile
import tarfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from scripts.operations import sha
from scripts.store_recovery import STORES,StoreRecovery,validate,assert_no_state_writers


class StoreRecoveryTests(unittest.TestCase):
    def fixture(self,root):
        metadata={'version':1,'databases':{}}
        for store in STORES:
            path=root/(store+'.dump');path.write_bytes(('synthetic '+store).encode())
            metadata['databases'][store]={'size':path.stat().st_size,'sha256':sha(path),
                'tables':{'example':'a'*64},'sequences':{'example_id_seq':{'last_value':'1','is_called':False}}}
        return metadata

    def test_all_stores_and_exact_checksums_required(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.fixture(root);validate(root,metadata,sha)
            for mutation in ('missing','checksum','table','sequence'):
                data=copy.deepcopy(metadata)
                if mutation=='missing':del data['databases']['derived']
                if mutation=='checksum':data['databases']['derived']['sha256']='b'*64
                if mutation=='table':data['databases']['archive']['tables']={'bad;sql':'a'*64}
                if mutation=='sequence':data['databases']['archive']['sequences']['example_id_seq']['is_called']='true'
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):validate(root,data,sha)
            (root/'derived.dump').unlink();(root/'derived.dump').symlink_to(root/'archive.dump')
            with self.assertRaisesRegex(ValueError,'checksum'):validate(root,metadata,sha)

    def test_snapshot_refuses_missing_or_lost_barrier(self):
        recovery=StoreRecovery(['fixture'],{})
        with patch('scripts.store_recovery.subprocess.run') as command:
            with self.assertRaisesRegex(RuntimeError,'barrier'):recovery.snapshot(Path('/not-created'),sha)
            command.assert_not_called()

    def test_restore_validates_every_store_before_any_target_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.fixture(root);(root/'derived.dump').write_bytes(b'corrupt')
            recovery=StoreRecovery(['fixture'],{})
            with patch.object(recovery,'query') as query:
                with self.assertRaisesRegex(ValueError,'checksum'):recovery.restore_inactive(root,metadata,sha)
                query.assert_not_called()

    def test_restore_refuses_existing_databases_and_roles(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);metadata=self.fixture(root);recovery=StoreRecovery(['fixture'],{})
            with patch.object(recovery,'query',return_value='nocheh_archive\n') as query:
                with self.assertRaisesRegex(ValueError,'absent_databases'):recovery.restore_inactive(root,metadata,sha)
                self.assertEqual(query.call_count,1)
            with patch.object(recovery,'query',side_effect=['','nocheh_archive_owner\n']) as query:
                with self.assertRaisesRegex(ValueError,'absent_roles'):recovery.restore_inactive(root,metadata,sha)
                self.assertEqual(query.call_count,2)

    def test_orphan_writers_fail_without_touching_unrelated_containers(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'owned'
            for source,rw,blocked in ((root/'hermes/profiles/fixture',True,True),(root.parent,True,True),
                                     (root,False,False),(Path(folder)/'unrelated',True,False)):
                with self.subTest(source=source,rw=rw),patch('scripts.store_recovery.subprocess.check_output',
                    side_effect=['database-id\n','database-id\nother-id\n',json.dumps([{'Type':'bind','Source':str(source),'RW':rw}])]) as read:
                    if blocked:
                        with self.assertRaisesRegex(RuntimeError,'writer_still_running'):assert_no_state_writers(root,{},['fixture'])
                    else:assert_no_state_writers(root,{},['fixture'])
                    self.assertEqual(read.call_count,3)
                    self.assertNotIn('stop',repr(read.call_args_list))

    def test_coordinated_backup_holds_stores_through_files_and_resumes_after_release(self):
        from contextlib import contextmanager
        from scripts.operations import backup,validate_snapshot
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state';state.mkdir();(state/'.env').write_text('saved setup\n')
            for name in ('files','spool','hermes'):(state/name).mkdir()
            (state/'files/original').write_bytes(b'exact source bytes\x00\r\n')
            order=[];test=self
            class Recovery:
                def __init__(self,*_):pass
                @contextmanager
                def maintenance(self):
                    order.append('maintenance');yield;order.append('maintenance released')
                @contextmanager
                def barrier(self):
                    order.append('locked');yield
                    test.assertTrue((root/'backup/manifest.json').is_file());order.append('released')
                def snapshot(self,directory,_):order.append('database snapshot');return test.fixture(directory)
                def assert_barrier(self):test.assertNotIn('released',order)
                def assert_maintenance(self):test.assertNotIn('maintenance released',order)
            def run(command,**kwargs):
                if 'stop' in command:order.append('stop '+command[-1])
                if 'up' in command:
                    test.assertIn('released',order);order.append('resumed')
            with patch('scripts.operations.compose',return_value=['fixture']),\
                 patch('scripts.operations.environment',return_value={'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}),\
                 patch('scripts.operations.subprocess.check_output',side_effect=['hermes\nnocheh-app\nnocheh-dashboard\nnocheh-db\n','fixture-revision']),\
                 patch('scripts.operations.subprocess.run',side_effect=run),patch('scripts.workflow_worker.running',return_value=False),\
                 patch('scripts.store_recovery.StoreRecovery',Recovery),patch('scripts.store_recovery.assert_no_state_writers') as idle:
                backup(state,root/'backup');idle.assert_called_once()
            manifest=validate_snapshot(root/'backup');self.assertEqual(manifest['version'],6)
            self.assertEqual(set(manifest['stores']['databases']),set(STORES))
            self.assertEqual(manifest['files']['files/original']['sha256'],sha(state/'files/original'))
            self.assertLess(order.index('stop nocheh-dashboard'),order.index('locked'))
            self.assertLess(order.index('database snapshot'),order.index('released'))
            self.assertEqual(order[-2:],["resumed","maintenance released"])

    def test_three_store_restore_starts_only_database_and_keeps_auth_inactive(self):
        from scripts.operations import restore
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);snapshot=root/'snapshot';snapshot.mkdir();state=root/'state'
            stores=self.fixture(snapshot)
            with tarfile.open(snapshot/'state.tar.gz','w:gz') as archive:
                data=b'{"fixture":"saved login"}'
                member=tarfile.TarInfo('state/hermes/auth.json');member.size=len(data);archive.addfile(member,io.BytesIO(data))
            manifest={'version':6,'storage_layout':'original-only-v1','stores':stores,'tables':{s:stores['databases'][s]['tables'] for s in STORES},
                'files':{'hermes/auth.json':{'size':len(data),'sha256':__import__('hashlib').sha256(data).hexdigest()}},'state_sha256':sha(snapshot/'state.tar.gz')}
            (snapshot/'manifest.json').write_text(json.dumps(manifest));starts=[]
            def run(command,**kwargs):
                if command[:3]==['docker','volume','inspect']:return SimpleNamespace(returncode=1)
                if 'up' in command:
                    starts.append(command)
                    self.assertTrue((state/'spool/.restore-inactive').exists())
                    self.assertTrue((state/'hermes/auth.restore-pending.json').exists())
                return SimpleNamespace(returncode=0)
            with patch('scripts.operations.load',return_value={'TELEGRAM_ENABLED':'true','NOCHEH_STORAGE_LAYOUT':'original-only-v1'}),\
                 patch('scripts.operations.compose',return_value=['fixture']),patch('scripts.operations.environment',return_value={}),\
                 patch('scripts.operations.subprocess.run',side_effect=run),patch('scripts.store_recovery.StoreRecovery') as recovery:
                result=restore(snapshot,state,'nocheh-three-restore',18990)
                recovery.return_value.restore_inactive.assert_called_once_with(snapshot,stores,sha)
            self.assertEqual(len(starts),1);self.assertEqual(starts[0][-1],'nocheh-db')
            self.assertFalse(result['executors_active']);self.assertFalse(result['telegram_enabled'])
            self.assertFalse(result['subscription_login_activated'])

    def test_backup_cannot_create_output_inside_original_or_native_data(self):
        from scripts.operations import backup
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with patch('scripts.operations.compose',return_value=['fixture']),\
                 patch('scripts.operations.environment',return_value={'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}),\
                 patch('scripts.operations.subprocess.check_output') as external:
                for path in ('files/backup','hermes/backup','spool/backup'):
                    with self.assertRaisesRegex(ValueError,'own snapshot'):backup(state,state/path)
                    self.assertFalse((state/path).exists())
                external.assert_not_called()

    def test_lost_maintenance_does_not_resume_writers(self):
        from contextlib import contextmanager
        from scripts.operations import backup
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)/'state';state.mkdir();calls=[]
            class Lost:
                def __init__(self,*_):pass
                @contextmanager
                def maintenance(self):yield
                @contextmanager
                def barrier(self):yield
                def snapshot(self,*_):raise RuntimeError('store_maintenance_lost')
                def assert_maintenance(self):raise RuntimeError('store_maintenance_lost')
            with patch('scripts.operations.compose',return_value=['fixture']),\
                 patch('scripts.operations.environment',return_value={'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}),\
                 patch('scripts.operations.subprocess.check_output',side_effect=['nocheh-app\nnocheh-db\n','fixture-revision']),\
                 patch('scripts.operations.subprocess.run',side_effect=lambda args,**_:calls.append(args)),\
                 patch('scripts.workflow_worker.running',return_value=False),\
                 patch('scripts.store_recovery.StoreRecovery',Lost),patch('scripts.store_recovery.assert_no_state_writers'):
                with self.assertRaisesRegex(RuntimeError,'maintenance_lost'):backup(state,Path(folder)/'backup')
            self.assertEqual(calls,[['fixture','stop','nocheh-app']])
            self.assertFalse((Path(folder)/'backup').exists())


if __name__=='__main__':unittest.main()
