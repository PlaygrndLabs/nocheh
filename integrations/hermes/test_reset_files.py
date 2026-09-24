import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import reset_files, reset_inventory


class ResetFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root/'state'; self.state.mkdir()
        self.files = self.state/'files'; self.files.mkdir(); (self.files/'original').write_bytes(b'original exact bytes')
        self.nested = self.files/'nested'; self.nested.mkdir(); (self.nested/'derived').write_text('generated content')
        self.spool = self.state/'spool'; self.spool.mkdir(); (self.spool/'observation').write_text('private source')
        self.fence = self.spool/'.restore-inactive'; self.fence.write_text('reset-owned-fence')
        self.config = self.state/'.env'; self.config.write_text('synthetic setup and login')
        self.foreign = self.root/'foreign'; self.foreign.mkdir(); (self.foreign/'sentinel').write_text('unrelated')
        self.preflight = {'blockers': [], 'installation': {'state': str(self.state), 'memory_state': str(self.state/'honcho')},
            'paths': [reset_inventory.entry(self.files,'erase','content'), reset_inventory.entry(self.spool,'erase','content'),
                      reset_inventory.entry(self.config,'preserve','configuration')]}

    def freeze(self):
        return reset_files.freeze(self.preflight, [self.fence])

    def test_exact_scope_fences_credentials_and_unrelated_files_survive(self):
        plan = self.freeze(); barrier = Mock()
        with patch.object(Path,'read_bytes',side_effect=AssertionError('content must not be read')):
            result = reset_files.erase(plan,barrier)
        self.assertGreater(result['removed_entries'],0); self.assertFalse(self.files.exists())
        self.assertEqual(list(self.spool.iterdir()),[self.fence])
        self.assertEqual(self.fence.read_text(),'reset-owned-fence')
        self.assertEqual(self.config.read_text(),'synthetic setup and login')
        self.assertEqual((self.foreign/'sentinel').read_text(),'unrelated')
        self.assertGreater(barrier.call_count,4)
        self.assertEqual(reset_files.erase(plan,barrier)['removed_entries'],0)

    def test_symlink_itself_is_removed_without_following_target(self):
        (self.files/'link').symlink_to(self.foreign,target_is_directory=True)
        result=reset_files.erase(self.freeze(),lambda:None)
        self.assertGreater(result['removed_entries'],0)
        self.assertEqual((self.foreign/'sentinel').read_text(),'unrelated')

    def test_hard_links_and_special_files_require_review_before_erasure(self):
        os.link(self.foreign/'sentinel',self.files/'linked')
        with self.assertRaisesRegex(ValueError,'type_requires_review'):self.freeze()
        (self.files/'linked').unlink();os.mkfifo(self.files/'fifo')
        with self.assertRaisesRegex(ValueError,'type_requires_review'):self.freeze()
        self.assertTrue((self.files/'original').exists())

    def test_replaced_or_changed_files_and_new_entries_block_before_any_deletion(self):
        for change in ('modified','replaced','new','directory_link'):
            with self.subTest(change=change):
                plan=self.freeze();item=self.nested/'derived';previous=None
                if change=='modified':item.write_text('changed')
                if change=='replaced':
                    previous=self.root/'old';item.rename(previous);item.write_text('generated content')
                if change=='new':(self.nested/'new').write_text('unreviewed')
                if change=='directory_link':
                    previous=self.root/'prior';self.nested.rename(previous);self.nested.symlink_to(self.foreign,target_is_directory=True)
                with self.assertRaises((ValueError,OSError)):reset_files.erase(plan,lambda:None)
                self.assertTrue((self.files/'original').exists())
                if change=='new':(self.nested/'new').unlink()
                elif change=='directory_link':self.nested.unlink();previous.rename(self.nested)
                elif change=='replaced':item.unlink();previous.rename(item)
                else:item.write_text('generated content')

    def test_interrupted_erasure_resumes_same_frozen_manifest(self):
        plan=self.freeze();unlink=os.unlink;removed=[]
        def interrupted(name,**kwargs):
            unlink(name,**kwargs);removed.append(name)
            if len(removed)==1:raise RuntimeError('interrupted after unlink')
        with patch('scripts.reset_files.os.unlink',side_effect=interrupted):
            with self.assertRaisesRegex(RuntimeError,'interrupted'):reset_files.erase(plan,lambda:None)
        self.assertEqual(len(removed),1)
        self.assertGreater(reset_files.erase(plan,lambda:None)['removed_entries'],0)
        self.assertEqual(list(self.spool.iterdir()),[self.fence])

    def test_failed_barrier_and_changed_file_immediately_before_unlink_fail_closed(self):
        plan=self.freeze()
        with self.assertRaisesRegex(RuntimeError,'barrier lost'):
            reset_files.erase(plan,Mock(side_effect=RuntimeError('barrier lost')))
        self.assertTrue((self.files/'original').exists())
        count=0
        def barrier():
            nonlocal count
            count+=1
            if count==5:(self.nested/'derived').write_text('changed after validation')
        with self.assertRaisesRegex(ValueError,'identity_changed'):reset_files.erase(plan,barrier)
        self.assertEqual((self.nested/'derived').read_text(),'changed after validation')

    def test_inventory_cannot_include_root_external_or_retained_setup(self):
        for path in (self.state,self.foreign,self.config):
            with self.subTest(path=path):
                original=copy.deepcopy(self.preflight)
                self.preflight['paths'].append(reset_inventory.entry(path,'erase','untrusted decision'))
                with self.assertRaisesRegex(ValueError,'scope_invalid'):self.freeze()
                self.preflight=original
        self.preflight['blockers']=[{'code':'foreign_writer'}]
        with self.assertRaisesRegex(ValueError,'inventory_blocked'):self.freeze()
        self.preflight['blockers']=[]
        credentials=self.state/'credentials';credentials.mkdir();key=credentials/'key';key.write_text('saved login')
        self.preflight['paths'] += [reset_inventory.entry(credentials,'preserve','login'),reset_inventory.entry(key,'erase','untrusted child')]
        with self.assertRaisesRegex(ValueError,'scope_invalid'):self.freeze()

    def test_replaced_ancestor_and_missing_protected_marker_are_rejected(self):
        plan=self.freeze();original=self.root/'old-state';self.state.rename(original);self.state.mkdir()
        self.files.mkdir();(self.files/'original').write_text('replacement')
        with self.assertRaisesRegex(ValueError,'ancestor_changed'):reset_files.erase(plan,lambda:None)
        (self.files/'original').unlink();self.files.rmdir();self.state.rmdir();original.rename(self.state)
        self.fence.unlink()
        with self.assertRaisesRegex(ValueError,'preservation_missing'):reset_files.erase(plan,lambda:None)
        self.assertTrue((self.files/'original').exists())

    def test_protected_subtree_is_kept_whole(self):
        plan=reset_files.freeze(self.preflight,[self.fence,self.nested])
        reset_files.erase(plan,lambda:None)
        self.assertEqual((self.nested/'derived').read_text(),'generated content')
        self.assertFalse((self.files/'original').exists())

    def test_explicit_post_shutdown_file_rebind_freezes_only_current_file_identity(self):
        native=self.state/'hermes';native.mkdir()
        status=native/'gateway_state.json';status.write_text('old status')
        self.preflight['paths'].append(reset_inventory.entry(status,'erase','native status'))
        prior=self.root/'old-status';status.rename(prior);status.write_text('stopped status')
        with self.assertRaisesRegex(ValueError,'identity_changed'):self.freeze()
        observed=reset_files.metadata(status.lstat())
        rebound={str(status):{key:observed[key] for key in reset_files.FIELDS}}
        plan=reset_files.freeze(self.preflight,[self.fence],rebound=rebound)
        self.assertEqual(plan['targets'][-1]['tree']['metadata']['inode'],status.stat().st_ino)
        with self.assertRaisesRegex(ValueError,'rebound_invalid'):
            reset_files.freeze(self.preflight,[self.fence],rebound={str(self.config):rebound[str(status)]})
        arbitrary=self.state/'arbitrary';arbitrary.write_text('not native status')
        self.preflight['paths'].append(reset_inventory.entry(arbitrary,'erase','content'))
        identity=reset_files.metadata(arbitrary.lstat())
        with self.assertRaisesRegex(ValueError,'rebound_invalid'):
            reset_files.freeze(self.preflight,[self.fence],rebound={str(arbitrary):
                {key:identity[key] for key in reset_files.FIELDS}})
        status.unlink();status.symlink_to(self.foreign/'sentinel')
        with self.assertRaisesRegex(ValueError,'identity_changed'):
            reset_files.freeze(self.preflight,[self.fence],rebound=rebound)


if __name__=='__main__':unittest.main()
