import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from .async_runs import AsyncRuns,identity
from .capture import canonical,immutable_file


class AsyncRunTests(unittest.TestCase):
    def body(self):return {'channel':'telegram','event_id':'a'*64,'attempt':1,'text':'private transcript canary','archive_credential':'private credential canary'}
    def wait(self,runs,body):
        for _ in range(100):
            state=runs.resume(body)
            if state['state'] in ('done','failed','cancelled','ambiguous','suppressed'):return state
            time.sleep(.01)
        self.fail('runtime fixture did not finish')

    def test_start_returns_before_effect_and_resume_keeps_identity_and_safe_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            release=threading.Event();calls=[]
            def execute(body,progress,cancelled):
                calls.append(body);progress('assistant');release.wait(3);progress('delivery');return {'state':'done','text':'private transcript canary'}
            runs=AsyncRuns(folder,execute,lambda body:None);body=self.body()
            first=runs.start(body);self.assertEqual(first['state'],'running')
            self.assertEqual(runs.start({**body,'archive_credential':'rotated private credential'})['run_id'],first['run_id'])
            with self.assertRaisesRegex(ValueError,'identity_conflict'):runs.start({**body,'text':'different source'})
            release.set();self.assertEqual(self.wait(runs,body)['state'],'done');self.assertEqual(len(calls),1)
            self.assertEqual(runs.events({**body,'after':1})['events'][-1]['state'],'done')
            for path in Path(folder).iterdir():
                if path.suffix!='.request':self.assertNotIn('private',path.read_text())
            recovered=AsyncRuns(folder,lambda *args:self.fail('completed effect restarted'),lambda body:None)
            self.assertEqual(recovered.resume(body)['state'],'done')

    def test_queued_request_survives_before_execution_crash_and_unknown_resume_never_creates_work(self):
        with tempfile.TemporaryDirectory() as folder:
            calls=[];body=self.body()
            runs=AsyncRuns(folder,lambda *args:None,lambda body:None)
            self.assertEqual(runs.resume(body)['state'],'not_found');self.assertEqual(list(Path(folder).iterdir()),[])
            with patch('threading.Thread.start'):runs.start(body)
            restored=AsyncRuns(folder,lambda *args:(calls.append(1) or {'state':'done'}),lambda body:None)
            self.assertEqual(self.wait(restored,body)['state'],'done');self.assertEqual(calls,[1])

    def test_restart_reconciles_native_receipt_or_closes_ambiguous_without_replacement(self):
        for native in (None,{'state':'done'}):
            with self.subTest(native=native),tempfile.TemporaryDirectory() as folder:
                body=self.body();run=identity(body)
                immutable_file(Path(folder),run+'.request',canonical(body));immutable_file(Path(folder),run+'.started',b'{}')
                restored=AsyncRuns(folder,lambda *args:self.fail('uncertain effect restarted'),lambda body:native)
                expected='done' if native else 'ambiguous'
                self.assertEqual(restored.resume(body)['state'],expected)
                self.assertEqual(restored.start(body)['state'],expected)

    def test_cancellation_is_observed_by_executor_and_cannot_reopen_finished_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            entered=threading.Event();body=self.body()
            def execute(body,progress,cancelled):entered.set();cancelled.wait(3);return {'state':'cancelled'}
            runs=AsyncRuns(folder,execute,lambda body:None);runs.start(body);self.assertTrue(entered.wait(1))
            self.assertTrue(runs.cancel(body)['cancel_requested']);self.assertEqual(self.wait(runs,body)['state'],'cancelled')
            self.assertEqual(runs.start(body)['state'],'cancelled')
            self.assertEqual(runs.cancel(body)['state'],'cancelled')

    def test_exception_content_is_removed_from_durable_results(self):
        with tempfile.TemporaryDirectory() as folder:
            def fail(*args):raise RuntimeError('private provider response')
            runs=AsyncRuns(folder,fail,lambda body:None);body=self.body();runs.start(body)
            self.assertEqual(self.wait(runs,body)['state'],'ambiguous')
            self.assertNotIn('private',runs._path(identity(body),'.result').read_text())
