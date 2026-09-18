import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import reset_inventory, reset_protocol, reset_quiescence as shutdown


class ResetQuiescenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve(); self.generation = str(uuid.uuid4())
        services = ['nocheh-postgres', 'honcho-postgres', 'honcho-redis', 'inngest-postgres', 'inngest-redis',
                    'hermes-runtime', 'nocheh-executor', 'hermes-agent-launcher', 'nocheh-app',
                    'nocheh-security', 'nocheh-dashboard', 'cliproxy-api', 'cliproxy-monitor',
                    'honcho-api', 'honcho-deriver', 'honcho-provider-gateway']
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'executable': False,
            'content_copied': False, 'blockers': [], 'volumes': [], 'installation': {
                'root': str(self.state.parent), 'state': str(self.state), 'memory_state': str(self.state/'honcho'),
                'project': 'fixture', 'storage_layout': 'legacy', 'config_path': str(self.state/'.env'),
                'configuration_sha256': 'a'*64, 'state_anchor': reset_inventory.entry(self.state, 'retain_root', 'installation_anchor')},
            'containers': [{'id': format(index, '064x'), 'name': 'fixture-'+service, 'image': 'sha256:'+'b'*64,
                            'project': 'fixture', 'service': service, 'working_dir': str(self.state.parent),
                            'config_files': '/fixture/compose.yml', 'mounts': [], 'state': 'running',
                            'restart_policy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}
                           for index,service in enumerate(services, 1)]}
        self.current = copy.deepcopy(self.preflight); self.calls = []
        self.maintenance = Mock()

    def ready(self, journal):
        journal.create(self.preflight, self.generation); journal.complete('isolated_acceptance', 'a'*64)

    def inspect(self): return copy.deepcopy(self.current)

    def docker(self, command, environment):
        self.calls.append(command)
        self.assertEqual(environment, {'FIXTURE': 'no-credentials'})
        by_id = {row['id']: row for row in self.current['containers']}
        if command[:3] == ['docker','update','--restart=no']:
            by_id[command[3]]['restart_policy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        elif command[:4] == ['docker','stop','--time','60']:
            for identifier in command[4:]: by_id[identifier]['state'] = 'exited'
        else: self.fail('unexpected Docker mutation')

    def quiesce(self, journal, **options):
        return shutdown.quiesce(journal, self.preflight, self.maintenance, inspect=self.inspect,
                                runner=options.get('runner', self.docker), environment={'FIXTURE': 'no-credentials'})

    def test_stops_only_reviewed_owners_and_retains_database_access_and_settings(self):
        inactive = self.current['containers'][-1]; inactive['state']='exited'
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); result=self.quiesce(journal)
            self.assertFalse(result['effects_settled']); self.assertFalse(result['resumed'])
            self.assertEqual(result['remaining_services'], sorted(shutdown.DATABASES))
            receipt=reset_protocol.read(journal.directory/'quiescence.json')
            self.assertTrue(all(row['restart_policy']['Name']=='unless-stopped' for row in receipt['containers']))
            self.assertEqual(receipt['containers'][-1]['state'], 'exited')
            self.assertEqual(journal.value['steps'][-1]['step'], 'quiesced')
            stops=[call for call in self.calls if call[1]=='stop']
            self.assertEqual(stops[0][4:], [row['id'] for row in self.current['containers'] if row['service']=='hermes-runtime'])
            stopped={identifier for call in stops for identifier in call[4:]}
            self.assertEqual(stopped,{row['id'] for row in self.current['containers'] if row['service'] not in shutdown.DATABASES})
            original=(journal.directory/'quiescence.json').read_bytes()
            self.quiesce(journal)
            self.assertEqual((journal.directory/'quiescence.json').read_bytes(),original)
        self.assertTrue(self.maintenance.called)

    def test_partial_shutdown_resumes_without_replacing_original_restart_settings(self):
        count=0
        def interrupted(command,env):
            nonlocal count
            self.docker(command,env);count+=1
            if count==4: raise RuntimeError('interrupted shutdown')
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                self.quiesce(journal,runner=interrupted)
            self.assertEqual(journal.value['steps'][-1]['step'],'isolated_acceptance')
            original=(journal.directory/'quiescence.json').read_bytes()
        with reset_protocol.locked(self.state) as journal:
            self.quiesce(journal)
            self.assertEqual((journal.directory/'quiescence.json').read_bytes(),original)
            self.assertEqual(journal.value['steps'][-1]['step'],'quiesced')

    def test_acceptance_and_maintenance_are_required_before_any_shutdown(self):
        with reset_protocol.locked(self.state) as journal:
            journal.create(self.preflight,self.generation)
            with self.assertRaisesRegex(ValueError,'phase_required'):self.quiesce(journal)
            journal.complete('isolated_acceptance','a'*64)
            self.maintenance.side_effect=RuntimeError('maintenance lost')
            with self.assertRaisesRegex(RuntimeError,'maintenance lost'):self.quiesce(journal)
        self.assertEqual(self.calls,[])
        self.assertFalse((self.state/'spool/.restore-inactive').exists())

    def test_ownership_or_configuration_change_blocks_mutation(self):
        for change in ('container','configuration','volume','foreign_writer'):
            with self.subTest(change=change):
                self.current=copy.deepcopy(self.preflight)
                if change=='container':self.current['containers'][0]['image']='different'
                elif change=='configuration':self.current['installation']['configuration_sha256']='b'*64
                elif change=='volume':self.current['volumes']=[{'name':'foreign'}]
                else:self.current['blockers']=[{'code':'foreign writer'}]
                with reset_protocol.locked(self.state) as journal:
                    self.ready(journal)
                    with self.assertRaisesRegex(RuntimeError,'ownership_changed'):self.quiesce(journal)
                self.assertEqual(self.calls,[])

    def test_replaced_or_foreign_fences_and_changed_restart_policy_are_rejected(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            self.current['containers'][0]['restart_policy']={'Name':'always','MaximumRetryCount':0}
            with self.assertRaisesRegex(ValueError,'restart_policy_changed'):self.quiesce(journal)
            self.current=copy.deepcopy(self.preflight)
            (self.state/'spool').mkdir();marker=self.state/'spool/.restore-inactive';marker.write_text('inactive restore')
            with self.assertRaisesRegex(ValueError,'fence_owned_elsewhere'):self.quiesce(journal)
            marker.unlink();marker.symlink_to(self.state/'unrelated')
            with self.assertRaisesRegex(ValueError,'fence_owned_elsewhere'):self.quiesce(journal)
        self.assertEqual(self.calls,[])

    def test_changed_receipt_mid_shutdown_does_not_resume(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            def changed(command,env):
                self.docker(command,env)
                receipt=journal.directory/'quiescence.json';data=json.loads(receipt.read_text());data['containers'][0]['state']='exited'
                receipt.write_text(json.dumps(data))
            with self.assertRaisesRegex(RuntimeError,'receipt_changed'):self.quiesce(journal,runner=changed)
            self.assertEqual(len(self.calls),1)
            self.assertEqual(journal.value['steps'][-1]['step'],'isolated_acceptance')
        self.assertFalse(any(call[1] in ('start','restart') for call in self.calls))

    def test_lost_maintenance_mid_shutdown_retains_fences_and_stops_progress(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            self.maintenance.side_effect=[None,None,None,RuntimeError('maintenance lost')]
            with self.assertRaisesRegex(RuntimeError,'maintenance lost'):self.quiesce(journal)
            self.assertEqual(len(self.calls),1)
            shutdown.assert_fences(self.state,journal.value['reset_id'])
            self.assertEqual(journal.value['steps'][-1]['step'],'isolated_acceptance')

    def test_interrupted_owned_fence_creation_repairs_after_reopen(self):
        def interrupted(state,reset_id,**_):
            (state/'spool').mkdir();(state/'spool/.restore-inactive').write_bytes(b'nocheh-reset:')
            raise OSError('disk full during marker write')
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(shutdown,'fence',side_effect=interrupted):
                with self.assertRaises(OSError):self.quiesce(journal)
        self.assertEqual(self.calls,[])
        with reset_protocol.locked(self.state) as journal:
            self.quiesce(journal);shutdown.assert_fences(self.state,journal.value['reset_id'])

    def test_stuck_owner_and_new_foreign_writer_block_phase_completion(self):
        for failure in ('stuck','foreign'):
            with self.subTest(failure=failure):
                # Reuse the exact interrupted shutdown journal/settings safely.
                self.current=copy.deepcopy(self.preflight)
                def changed(command,env):
                    self.docker(command,env)
                    if command[1]=='stop' and len(self.calls)>len(self.preflight['containers'])+2:
                        if failure=='stuck':
                            next(row for row in self.current['containers'] if row['service']=='nocheh-app')['state']='running'
                        else:self.current['blockers']=[{'code':'new foreign writer'}]
                with reset_protocol.locked(self.state) as journal:
                    self.ready(journal)
                    with self.assertRaisesRegex(RuntimeError,'owner_still_running|ownership_changed'):
                        self.quiesce(journal,runner=changed)
                    self.assertEqual(journal.value['steps'][-1]['step'],'isolated_acceptance')


if __name__=='__main__':unittest.main()
