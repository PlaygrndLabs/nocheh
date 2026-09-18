import io,json,socket,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from scripts.management_maintenance import ManagementCoordinator,coordinating_dashboard
from scripts.store_recovery import assert_no_state_writers

TOKEN='11111111-1111-4111-8111-111111111111'
IDENTITY={'id':'owned-dashboard','started':'one','running':True,'hostname':socket.gethostname(),'service':'nocheh-dashboard'}

class ManagementMaintenanceTests(unittest.TestCase):
    def test_current_process_and_ready_operation_are_both_required(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'admin/dashboard').mkdir(parents=True);(state/'admin/dashboard/token').write_text('synthetic-dashboard-key')
            env={'NOCHEH_CONTAINER':'1','NOCHEH_MAINTENANCE_COORDINATOR':TOKEN,'NOCHEH_DASHBOARD_PORT':'18883'}
            def response(*_args,**_kwargs):return io.BytesIO(json.dumps({'ready':True,'token':TOKEN}).encode())
            with patch('scripts.management_maintenance.inspect',return_value=IDENTITY),patch('scripts.management_maintenance.urlopen',side_effect=response):
                coordinator=ManagementCoordinator(state,env,'owned-dashboard',IDENTITY)
                coordinator.assert_current()
                with patch('scripts.management_maintenance.inspect',return_value={**IDENTITY,'started':'restarted'}):
                    with self.assertRaisesRegex(RuntimeError,'coordinator_changed'):coordinator.assert_current()
                for value in ({'ready':False,'token':TOKEN},{'ready':True,'token':'old-operation'}):
                    with patch('scripts.management_maintenance.urlopen',return_value=io.BytesIO(json.dumps(value).encode())):
                        with self.assertRaisesRegex(RuntimeError,'maintenance_lost'):coordinator.assert_current()
                with self.assertRaisesRegex(RuntimeError,'maintenance_required'):ManagementCoordinator(state,{},'owned-dashboard',IDENTITY)

    def test_other_or_host_callers_cannot_claim_the_dashboard_exception(self):
        with patch('scripts.management_maintenance.subprocess.check_output',return_value='owned-dashboard\n'),\
             patch('scripts.management_maintenance.inspect',return_value={**IDENTITY,'hostname':'other'}):
            self.assertIsNone(coordinating_dashboard(Path('/fixture'),[],{'NOCHEH_CONTAINER':'1'}))
        with patch('scripts.management_maintenance.subprocess.check_output') as docker:
            self.assertIsNone(coordinating_dashboard(Path('/fixture'),[],{}));docker.assert_not_called()

    def test_only_verified_coordinator_mount_is_exempt_and_other_writers_still_block(self):
        class Coordinator:
            identity=IDENTITY
            def assert_current(self):pass
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder)
            outputs=['database\n','database\nowned-dashboard\norphan\n',json.dumps([{'RW':True,'Type':'bind','Source':str(state)}])]
            with patch('scripts.store_recovery.subprocess.check_output',side_effect=outputs):
                with self.assertRaisesRegex(RuntimeError,'writer_still_running'):assert_no_state_writers(state,{},[],Coordinator())
            with patch('scripts.store_recovery.subprocess.check_output',return_value='database\n'):
                with patch.object(Coordinator,'assert_current',side_effect=RuntimeError('lost')):
                    with self.assertRaisesRegex(RuntimeError,'lost'):assert_no_state_writers(state,{},[],Coordinator())
