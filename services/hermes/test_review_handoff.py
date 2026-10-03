"""A blocked native review must release its HTTP/workflow caller, not its identity."""
import fcntl
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .review_worker import start,observe


class ReviewHandoffTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name);self.profile=self.root/'profiles'/('nocheh-'+'c'*24)
        self.profile.mkdir(parents=True);self.policy=SimpleNamespace(owner='42')
        self.body={'id':'a'*64,'scope':'42','content':'synthetic protected input','archive_credential':'synthetic credential'}
        self.prepare=patch('services.hermes.review_worker.review_profile',return_value=self.profile)
        self.prepare.start();self.addCleanup(self.prepare.stop)

    def wait_state(self,body,state):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            value=observe(self.root,self.policy,body)
            if value['state']==state:
                # A receipt can become durable immediately before the worker
                # releases its file descriptors. Wait for cleanup before reuse.
                lease=self.root/'nocheh-review-runs'/(body['id']+'.lock')
                if state in ('done','ambiguous') and lease.exists():
                    with lease.open('rb') as file:
                        try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB)
                        except BlockingIOError:time.sleep(.01);continue
                return value
            time.sleep(.01)
        self.fail('review did not reach '+state)

    def test_handoff_is_bounded_observable_and_replay_safe(self):
        entered=threading.Event();release=threading.Event();finished=threading.Event()
        def native(*args):
            entered.set()
            try:
                if not release.wait(3):raise RuntimeError('fixture_timeout')
                return {'state':'done'}
            finally:finished.set()
        second={**self.body,'id':'b'*64}
        with patch('services.hermes.review_worker._review',side_effect=native) as child:
            try:
                self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'running'})
                self.assertTrue(entered.wait(1));self.assertFalse(finished.is_set())
                self.assertEqual(observe(self.root,self.policy,self.body),{'state':'running'})
                self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'running'})
                self.assertEqual(start(self.root,self.policy,'model',None,second),{'state':'waiting','error_code':'profile_busy'})
                self.assertFalse((self.root/'nocheh-review-runs'/(second['id']+'.started')).exists())
                with (self.profile/'.turn.lock').open('a') as lock:
                    with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(child.call_count,1)
            finally:release.set()
            self.wait_state(self.body,'done')
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'done'})
            self.assertEqual(child.call_count,1,'replayed completion never mutates notes again')
            self.assertEqual(start(self.root,self.policy,'model',None,second),{'state':'running'})
            self.wait_state(second,'done');self.assertEqual(child.call_count,2)
        for file in (self.root/'nocheh-review-runs').iterdir():
            self.assertNotIn(b'synthetic',file.read_bytes(),'supervisor receipts contain neither content nor credential')

    def test_lost_supervisor_receipt_reconciles_child_without_relaunch(self):
        journal=self.root/'nocheh-review-runs';journal.mkdir()
        (journal/(self.body['id']+'.started')).write_text('{}')
        with patch('services.hermes.review_worker._review',side_effect=AssertionError('replayed effect')):
            self.assertEqual(observe(self.root,self.policy,self.body),{'state':'ambiguous'})
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'ambiguous'})
            receipts=self.profile/'reviews';receipts.mkdir();(receipts/self.body['id']).write_text('done')
            self.assertEqual(observe(self.root,self.policy,self.body),{'state':'done'})
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'done'})

    def test_failed_thread_launch_keeps_ambiguity_and_releases_capacity(self):
        with patch('services.hermes.review_worker.threading.Thread.start',side_effect=RuntimeError('fixture_launch_failed')):
            with self.assertRaisesRegex(RuntimeError,'fixture_launch_failed'):start(self.root,self.policy,'model',None,self.body)
        self.assertEqual(observe(self.root,self.policy,self.body),{'state':'ambiguous'})
        second={**self.body,'id':'b'*64}
        with patch('services.hermes.review_worker._review',return_value={'state':'done'}) as child:
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'ambiguous'})
            child.assert_not_called()
            self.assertEqual(start(self.root,self.policy,'model',None,second),{'state':'running'})
            self.wait_state(second,'done')

    def test_child_failure_is_not_reexecuted_or_reported_as_completion(self):
        with patch('services.hermes.review_worker._review',side_effect=RuntimeError('protected failure text')) as child:
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'running'})
            self.wait_state(self.body,'ambiguous')
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'ambiguous'})
            self.assertEqual(child.call_count,1)
        self.assertFalse((self.root/'nocheh-review-runs'/(self.body['id']+'.done')).exists())

    def test_foreground_quiet_interval_has_no_launch_receipt(self):
        (self.profile/'.foreground').touch()
        with patch('services.hermes.review_worker._review') as child:
            self.assertEqual(start(self.root,self.policy,'model',None,self.body),{'state':'waiting','error_code':'profile_busy'})
            child.assert_not_called()
            self.assertEqual(observe(self.root,self.policy,self.body),{'state':'not_found'})

    def test_observation_and_launch_reject_symlinked_supervisor_state(self):
        other=self.root/'other';other.mkdir();(self.root/'nocheh-review-runs').symlink_to(other,target_is_directory=True)
        for operation in (lambda:observe(self.root,self.policy,self.body),lambda:start(self.root,self.policy,'model',None,self.body)):
            with self.assertRaisesRegex(ValueError,'review_receipt_path_denied'):operation()


if __name__=='__main__':unittest.main()
