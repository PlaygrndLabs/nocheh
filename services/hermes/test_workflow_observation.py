import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from .review_worker import observe


class WorkflowObservationTests(unittest.TestCase):
    def test_native_review_observation_never_prepares_or_executes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);profile=root/'profiles'/('nocheh-'+'a'*24)
            receipt=profile/'reviews'/('b'*64);receipt.parent.mkdir(parents=True)
            body={'id':'b'*64,'scope':'42','observe_only':True};policy=SimpleNamespace(owner='42')
            with patch('subprocess.run',side_effect=AssertionError('observation executed a worker')):
                self.assertEqual(observe(root,policy,body),{'state':'not_found'})
                receipt.write_text('done');self.assertEqual(observe(root,policy,body),{'state':'done'})
                receipt.write_text('running');self.assertEqual(observe(root,policy,body),{'state':'ambiguous'})
                with (profile/'.memory.lock').open('a') as lock:
                    fcntl.flock(lock,fcntl.LOCK_EX)
                    self.assertEqual(observe(root,policy,body),{'state':'running'})
                self.assertEqual(observe(root,policy,body),{'state':'ambiguous'})
                with self.assertRaisesRegex(ValueError,'owner_review_required'):observe(root,policy,{**body,'scope':'43'})
