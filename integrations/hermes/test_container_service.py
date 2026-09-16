import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import archive_url,native_endpoint,compose_command,initialize,compose_environment
from scripts.container_service import main


class ContainerServiceTests(unittest.TestCase):
    def test_internal_endpoints_ignore_host_published_ports(self):
        with patch.dict(os.environ,{'NOCHEH_CONTAINER':'1','NOCHEH_NATIVE_ADMIN_PORT':'19005'}):
            self.assertEqual(archive_url(Path('/missing')),'http://nocheh-app:8780')
            self.assertEqual(native_endpoint(Path('/missing')),('hermes-runtime',8785))

    def test_compose_uses_installation_paths_and_separate_dashboard_port(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);initialize(state)
            with patch('scripts.configuration.INSTALLATION_ROOT',Path('/installation')):
                self.assertEqual(compose_command(state)[-1],'/installation/docker-compose.yml')
                env=compose_environment(state)
                self.assertEqual(env['NOCHEH_INSTALLATION_ROOT'],'/installation')
                self.assertEqual(env['NOCHEH_DASHBOARD_PORT'],'8783')

    def test_inactive_worker_is_healthy_but_stale_heartbeat_is_not(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'NOCHEH_STATE_DIR':folder}):
            path=Path(folder)/'admin/workflows/status.json';path.parent.mkdir(parents=True)
            self.assertEqual(main(['executor-health']),1)
            path.write_text(json.dumps({'state':'inactive','seen_at':time.time()}))
            self.assertEqual(main(['executor-health']),0)
            path.write_text(json.dumps({'state':'running','seen_at':time.time()-60}))
            self.assertEqual(main(['executor-health']),1)

    def test_container_shutdown_uses_compose_to_suppress_restart(self):
        from scripts.workflow_worker import stop
        with patch('scripts.workflow_worker.compose_command',return_value=['docker','compose']),patch('scripts.workflow_worker.compose_environment',return_value={}),patch('scripts.workflow_worker.subprocess.run') as call:
            self.assertEqual(stop(Path('/unused'),wait=True),{'state':'stopped'})
            self.assertEqual(call.call_args.args[0],['docker','compose','stop','nocheh-host-executor'])
