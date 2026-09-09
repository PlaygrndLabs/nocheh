"""Acceptance failures cannot activate memory or bypass the pilot budget."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from . import control,verify


class AcceptanceTests(unittest.TestCase):
    def state(self,root,credentials=False):
        root=Path(root)
        (root/'reports').mkdir();(root/'bridge-auth').mkdir()
        (root/'temporary_embedding_key').write_text('synthetic-dedicated-key' if credentials else '')
        if credentials:(root/'bridge-auth/fixture.json').write_text('{}')
        return root

    def test_missing_credentials_keep_all_gates_pending_without_startup_or_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.state(directory)
            with patch.object(verify,'STATE',root),patch.object(verify,'request') as request,patch.object(verify.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(verify.main(),2)
            request.assert_not_called();run.assert_not_called()
            report=json.loads((root/'reports/live-memory.json').read_text())
            self.assertEqual(report['status'],'credentials_pending')
            self.assertEqual(set(report['checks'].values()),{'pending'})

    def test_failed_subscription_never_ingests_and_retains_content_free_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root=self.state(directory,True)
            with patch.object(verify,'STATE',root),patch.object(verify,'request',side_effect=RuntimeError('private provider body')) as request,patch.object(verify.subprocess,'run'),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(verify.main(),1)
            self.assertEqual(request.call_count,1)
            report=(root/'reports/live-memory.json').read_text()
            self.assertNotIn('private provider body',report)
            self.assertEqual(json.loads(report)['checks']['ingestion'],'pending')
            self.assertEqual(json.loads(report)['status'],'incomplete')

    def test_monthly_cutover_requires_live_acceptance_and_attachment(self):
        with patch.object(control,'initialize'),patch('sys.argv',['honcho-experiment','monthly']),patch('scripts.archive.API') as api,patch('experiments.honcho.meter.Ledger') as ledger,contextlib.redirect_stdout(io.StringIO()):
            for connection in ({'verified':False,'attached':False},{'verified':True,'attached':False}):
                api.return_value.call.return_value={'connection':connection}
                with self.assertRaises(SystemExit):control.main()
            ledger.assert_not_called()
            api.return_value.call.return_value={'connection':{'verified':True,'attached':True}}
            self.assertEqual(control.main(),0)
            ledger.return_value.enable_monthly.assert_called_once_with()


if __name__=='__main__':unittest.main()
