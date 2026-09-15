import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.workflow_worker import start,running


class HostWorkerTests(unittest.TestCase):
    def test_restored_installations_never_launch_workers(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            for marker in ('workflows/inactive','spool/.restore-inactive'):
                path=state/marker;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
                with patch('scripts.workflow_worker.compose_environment',return_value={}),patch('scripts.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(start(state)['state'],'inactive_restore');launch.assert_not_called()
                path.unlink()

    def test_live_os_lock_excludes_a_second_supervisor(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);directory=state/'admin/workflows';directory.mkdir(parents=True)
            with (directory/'worker.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                self.assertTrue(running(state))
                with patch('scripts.workflow_worker.compose_environment',return_value={}),patch('scripts.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(start(state)['state'],'running');launch.assert_not_called()
            self.assertFalse(running(state))

    def test_receipt_recovery_continues_when_connect_process_cannot_start(self):
        import json
        from scripts.workflow_worker import serve
        from scripts.archive import API
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);receipts=state/'admin/tools/receipts';receipts.mkdir(parents=True)
            receipt=receipts/'effect.json';body={'id':'effect','actor':'original','state':'done','result':{'exit_code':0}}
            receipt.write_text(json.dumps(body));calls=[]
            def acknowledge(_api,path,value,*args):
                calls.append((path,value));(state/'admin/workflows/stop').touch();return {'ok':True}
            with patch('scripts.workflow_worker.compose_environment',return_value={'NOCHEH_PORT':'18780'}),\
                 patch('scripts.workflow_worker.executable',return_value='/node24'),\
                 patch('scripts.workflow_worker.signal.signal'),\
                 patch('scripts.workflow_worker.subprocess.Popen',side_effect=OSError('unavailable')),\
                 patch.object(API,'__init__',return_value=None),patch.object(API,'call',acknowledge):
                self.assertEqual(serve(state),0)
            self.assertEqual(calls,[('/v1/tools/finish',body)])
            self.assertFalse(receipt.exists())

    def test_lost_ack_keeps_receipt_until_same_result_is_acknowledged(self):
        import json
        from scripts.workflow_worker import recover_receipts
        from scripts.archive import API
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);receipts=state/'admin/tools/receipts';receipts.mkdir(parents=True)
            receipt=receipts/'effect.json';body={'id':'effect','actor':'original','state':'done','result':{'exit_code':0}}
            receipt.write_text(json.dumps(body))
            with patch.object(API,'__init__',return_value=None),patch.object(API,'call',side_effect=[ConnectionError('lost reply'),{'ok':True}]) as finish:
                with self.assertRaises(ConnectionError):recover_receipts(state)
                self.assertEqual(json.loads(receipt.read_text()),body)
                self.assertEqual(recover_receipts(state),1)
            self.assertFalse(receipt.exists())
            self.assertEqual(finish.call_args_list[0],finish.call_args_list[1])
