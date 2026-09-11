import fcntl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.workflow_worker import start,running


class HostWorkerTests(unittest.TestCase):
    def test_disabled_and_restored_installations_never_launch_workers(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            with patch('scripts.workflow_worker.compose_environment',return_value={'NOCHEH_WORKFLOWS_ENABLED':'false'}),patch('scripts.workflow_worker.subprocess.Popen') as launch:
                self.assertEqual(start(state)['state'],'disabled');launch.assert_not_called()
            for marker in ('workflows/inactive','spool/.restore-inactive'):
                path=state/marker;path.parent.mkdir(parents=True,exist_ok=True);path.touch()
                with patch('scripts.workflow_worker.compose_environment',return_value={'NOCHEH_WORKFLOWS_ENABLED':'true'}),patch('scripts.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(start(state)['state'],'inactive_restore');launch.assert_not_called()
                path.unlink()

    def test_live_os_lock_excludes_a_second_supervisor(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);directory=state/'admin/workflows';directory.mkdir(parents=True)
            with (directory/'worker.lock').open('a') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                self.assertTrue(running(state))
                with patch('scripts.workflow_worker.compose_environment',return_value={'NOCHEH_WORKFLOWS_ENABLED':'true'}),patch('scripts.workflow_worker.subprocess.Popen') as launch:
                    self.assertEqual(start(state)['state'],'running');launch.assert_not_called()
            self.assertFalse(running(state))
