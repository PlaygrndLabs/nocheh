import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.workflows.workflow_worker import start,running,resume_existing


class HostWorkerTests(unittest.TestCase):
    def test_restored_installations_never_launch_workers(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            for marker in ('workflows/inactive','spool/.restore-inactive'):
                path=state/marker;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
                with patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),patch('tools.operations.workflows.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(start(state)['state'],'inactive_restore');launch.assert_not_called()
                path.unlink()

    def test_live_os_lock_excludes_a_second_supervisor(self):
        from tools.operations.workflows.workflow_worker import serve
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);directory=state/'admin/workflows';directory.mkdir(parents=True)
            with (directory/'worker.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                with patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={'NOCHEH_PORT':'18780'}),\
                     patch('tools.operations.workflows.workflow_worker.executable',return_value='/node24'),\
                     patch('tools.operations.workflows.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(serve(state),0);launch.assert_not_called()

    def test_container_presence_is_visible_without_a_host_file_lock(self):
        with tempfile.TemporaryDirectory() as folder,\
             patch('tools.operations.workflows.workflow_worker.compose_command',return_value=['docker','compose']),\
             patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),\
             patch('tools.operations.workflows.workflow_worker.subprocess.check_output',return_value='nocheh-executor\n') as query:
            self.assertTrue(running(Path(folder)))
            self.assertEqual(query.call_args.args[0][-5:],['ps','--status','running','--services','nocheh-executor'])
            with patch('tools.operations.workflows.workflow_worker.subprocess.run') as launch:
                self.assertEqual(start(Path(folder))['state'],'running');launch.assert_not_called()

    def test_backup_resumes_existing_executor_without_recreating_it(self):
        with tempfile.TemporaryDirectory() as folder,\
             patch('tools.operations.workflows.workflow_worker.compose_command',return_value=['docker','compose']),\
             patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),\
             patch('tools.operations.workflows.workflow_worker.running',side_effect=[False,True]),\
             patch('tools.operations.workflows.workflow_worker.subprocess.run') as launch:
            state=Path(folder);directory=state/'admin/workflows';directory.mkdir(parents=True)
            (directory/'stop').touch()
            self.assertEqual(resume_existing(state)['state'],'running')
            self.assertFalse((directory/'stop').exists())
            self.assertEqual(launch.call_args.args[0],
                             ['docker','compose','start','--wait','--wait-timeout','180','nocheh-executor'])
        with tempfile.TemporaryDirectory() as folder,\
             patch('tools.operations.workflows.workflow_worker.compose_command',return_value=['docker','compose']),\
             patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),\
             patch('tools.operations.workflows.workflow_worker.running',return_value=False),\
             patch('tools.operations.workflows.workflow_worker.subprocess.run'):
            with self.assertRaisesRegex(RuntimeError,'did_not_resume'):
                resume_existing(Path(folder))

    def test_stale_lock_file_does_not_report_a_stopped_container_as_running(self):
        with tempfile.TemporaryDirectory() as folder,\
             patch('tools.operations.workflows.workflow_worker.compose_command',return_value=['docker','compose']),\
             patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),\
             patch('tools.operations.workflows.workflow_worker.subprocess.check_output',return_value=''):
            state=Path(folder);directory=state/'admin/workflows';directory.mkdir(parents=True)
            (directory/'worker.lock').touch()
            self.assertFalse(running(state))

    def test_unavailable_docker_cannot_be_mistaken_for_a_stopped_executor(self):
        import subprocess
        with patch('tools.operations.workflows.workflow_worker.compose_command',return_value=['docker','compose']),\
             patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={}),\
             patch('tools.operations.workflows.workflow_worker.subprocess.check_output',side_effect=subprocess.CalledProcessError(1,['docker','compose'])):
            with self.assertRaises(subprocess.CalledProcessError):running(Path('/unavailable'))

    def test_receipt_recovery_continues_when_connect_process_cannot_start(self):
        import json
        from tools.operations.workflows.workflow_worker import serve
        from tools.operations.archive.archive import API
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);receipts=state/'admin/tools/receipts';receipts.mkdir(parents=True)
            receipt=receipts/'effect.json';body={'id':'effect','actor':'original','state':'done','result':{'exit_code':0}}
            receipt.write_text(json.dumps(body));calls=[]
            def acknowledge(_api,path,value,*args):
                calls.append((path,value));(state/'admin/workflows/stop').touch();return {'ok':True}
            with patch('tools.operations.workflows.workflow_worker.compose_environment',return_value={'NOCHEH_PORT':'18780'}),\
                 patch('tools.operations.workflows.workflow_worker.executable',return_value='/node24'),\
                 patch('tools.operations.workflows.workflow_worker.signal.signal'),\
                 patch('tools.operations.workflows.workflow_worker.subprocess.Popen',side_effect=OSError('unavailable')),\
                 patch.object(API,'__init__',return_value=None),patch.object(API,'call',acknowledge):
                self.assertEqual(serve(state),0)
            self.assertEqual(calls,[('/v1/tools/finish',body)])
            self.assertFalse(receipt.exists())

    def test_lost_ack_keeps_receipt_until_same_result_is_acknowledged(self):
        import json
        from tools.operations.workflows.workflow_worker import recover_receipts
        from tools.operations.archive.archive import API
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
