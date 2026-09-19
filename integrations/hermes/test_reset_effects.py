import copy
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from integrations.hermes.capture import Capture
from scripts import reset_effects as effects,reset_inventory,reset_protocol,reset_quiescence


class ResetEffectsTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
        self.state=Path(self.temporary.name).resolve();self.capture=Capture(self.state/'spool','123')
        self.source='telegram:123:update:1';self.event=effects.digest(self.source)
        self.observed={'dispatches':[{'event_id':self.event,'attempts':1,'state':'ambiguous','source_key':self.source}],
                       'telegram':[],'tools':[],'managed':[],'workflows':[]}
        self.preflight={'format':'nocheh-reset-preflight-v1','id':str(uuid.uuid4()),'executable':False,'content_copied':False,
            'blockers':[],'containers':[],'volumes':[],'installation':{'root':str(self.state.parent),'state':str(self.state),
            'state_anchor':reset_inventory.entry(self.state,'retain_root','fixture'),'memory_state':str(self.state/'honcho'),
            'project':'fixture','storage_layout':'legacy','config_path':str(self.state/'.env'),'configuration_sha256':'a'*64}}

    def ready(self,journal):
        journal.create(self.preflight,str(uuid.uuid4()));journal.complete('isolated_acceptance','a'*64)
        reset_quiescence.fence(self.state,journal.value['reset_id']);journal.complete('quiesced','b'*64)

    def deliver(self,response=(200,b'{"ok":true,"result":{"message_id":1}}')):
        parameters={'chat_id':123,'text':'private fixture message — سلام'}
        key,_=self.capture.outbound('sendMessage',parameters,self.source)
        if response is not None:self.capture.complete(key,'sendMessage',parameters,response)
        return key

    def test_no_outbound_attempt_is_distinct_from_successful_delivery(self):
        result=effects.evaluate(self.state,self.observed)
        self.assertTrue(result['settled']);self.assertEqual(result['results'][0]['outcome'],'stopped_without_delivery_attempt')
        self.assertFalse(result['actions_replayed']);self.assertFalse(result['database_receipts_changed'])

    def test_real_native_receipts_reconcile_without_retaining_message_content(self):
        self.deliver();before={p:p.read_bytes() for p in (self.state/'spool/outbound').iterdir()}
        result=effects.evaluate(self.state,self.observed)
        self.assertTrue(result['settled']);self.assertEqual(result['results'][0]['outcome'],'delivery_receipts_reconciled')
        self.assertNotIn('private fixture message',json.dumps(result));self.assertNotIn('سلام',json.dumps(result))
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_missing_or_ambiguous_transport_receipt_blocks_even_with_native_done(self):
        key=self.deliver(None)
        folder=self.state/'spool/dispatch';folder.mkdir();(folder/(effects.digest(self.event+':1')+'.result')).write_text('{"state":"done"}')
        self.assertFalse(effects.evaluate(self.state,self.observed)['settled'])
        self.capture.complete(key,'sendMessage',{'chat_id':123,'text':'private fixture message — سلام'},None)
        self.assertFalse(effects.evaluate(self.state,self.observed)['settled'])
        empty={key:[] for key in self.observed}
        self.assertFalse(effects.evaluate(self.state,empty)['settled'],'an orphan uncertain external send is still a blocker')

    def test_ambiguous_non_dropping_webhook_setup_is_not_a_delivery_blocker(self):
        parameters={'drop_pending_updates':False}
        key,_=self.capture.outbound('deleteWebhook',parameters,'telegram-polling-setup')
        self.capture.complete(key,'deleteWebhook',parameters,None)
        empty={key:[] for key in self.observed}
        result=effects.evaluate(self.state,empty)
        self.assertTrue(result['settled'])
        self.assertEqual(result['outbound'][0]['effect'],'transport_setup')
        self.assertEqual(result['outbound'][0]['outcome'],'ambiguous')

    def test_ambiguous_dropping_webhook_remains_an_external_effect_blocker(self):
        parameters={'drop_pending_updates':True}
        key,_=self.capture.outbound('deleteWebhook',parameters,'telegram-reset-boundary')
        self.capture.complete(key,'deleteWebhook',parameters,None)
        empty={key:[] for key in self.observed}
        result=effects.evaluate(self.state,empty)
        self.assertFalse(result['settled'])
        self.assertEqual(result['outbound'][0]['effect'],'delivery')

    def test_mismatched_result_or_unrecognized_journal_entry_fails_closed(self):
        self.deliver();path=next((self.state/'spool/outbound').glob('*.result'));value=json.loads(path.read_text())
        value['event']['payload']['intent_key']='different intent';path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'result_identity_invalid'):effects.evaluate(self.state,self.observed)
        path.unlink();(path.parent/'unexpected').write_text('unknown')
        with self.assertRaisesRegex(ValueError,'journal_entry_unknown'):effects.evaluate(self.state,self.observed)

    def test_unknown_remote_tool_blocks_but_stopped_local_result_stays_explicitly_unknown(self):
        identifier='c'*64
        self.observed['tools']=[{'id':identifier,'kind':'shell','state':'ambiguous','started':True,'recorded_result':True}]
        result=effects.evaluate(self.state,self.observed)
        self.assertTrue(result['settled']);self.assertEqual(result['results'][-1]['outcome'],'stopped_local_result_unknown')
        self.observed['tools'][0]['kind']='mcp'
        self.assertFalse(effects.evaluate(self.state,self.observed)['settled'])
        directory=self.state/'admin/tools/receipts';directory.mkdir(parents=True)
        (directory/(identifier+'.json')).write_text(json.dumps({'id':identifier,'state':'done','result':{'private':'content'}}))
        result=effects.evaluate(self.state,self.observed);self.assertTrue(result['settled']);self.assertNotIn('private',json.dumps(result))

    def test_workflow_receipts_require_matching_domain_evidence(self):
        self.observed['workflows']=[{'workflow_id':'d'*64,'step':'send','attempt':1,'state':'ambiguous','family':'telegram','job_id':self.event}]
        self.assertTrue(effects.evaluate(self.state,self.observed)['settled'])
        self.observed['workflows'][0]['job_id']='e'*64
        self.assertFalse(effects.evaluate(self.state,self.observed)['settled'])

    def test_orphan_ambiguous_tool_receipt_blocks_even_without_database_row(self):
        directory=self.state/'admin/tools/receipts';directory.mkdir(parents=True)
        path=directory/('c'*64+'.json');path.write_text(json.dumps({'id':'c'*64,'state':'ambiguous','result':{'private':'body'}}))
        result=effects.evaluate(self.state,self.observed)
        self.assertFalse(result['settled']);self.assertNotIn('private',json.dumps(result))
        path.write_text(json.dumps({'id':'c'*64,'state':'done'}))
        self.assertTrue(effects.evaluate(self.state,self.observed)['settled'])

    def test_receipt_symlinks_and_hardlinks_are_not_read(self):
        folder=self.state/'spool/dispatch';folder.mkdir(parents=True);path=folder/(effects.digest(self.event+':1')+'.result')
        target=self.state/'outside';target.write_text('{"state":"done"}');path.symlink_to(target)
        with self.assertRaises(OSError):effects.evaluate(self.state,self.observed)
        path.unlink();os.link(target,path)
        with self.assertRaisesRegex(ValueError,'file_invalid'):effects.evaluate(self.state,self.observed)

    def test_snapshot_routes_original_sources_separately_and_legacy_uses_one_store(self):
        for layout in ('legacy','original-only-v1'):
            calls=[]
            def query(store,sql):
                calls.append((store,sql))
                if 'SELECT event_id,attempts,state FROM dispatches' in sql:
                    return json.dumps([{k:v for k,v in self.observed['dispatches'][0].items() if k!='source_key'}])
                if 'SELECT source_key FROM events' in sql:return json.dumps([{'source_key':self.source}])
                return '[]'
            self.assertEqual(effects.snapshot(query,layout),self.observed)
            self.assertEqual(calls[0][0],'control' if layout=='original-only-v1' else None)
            self.assertEqual(calls[1][0],'archive' if layout=='original-only-v1' else None)
        with self.assertRaisesRegex(ValueError,'layout_invalid'):effects.snapshot(query,'unexpected')

    def test_settlement_requires_quiescence_and_maintenance_and_never_marks_blocker_complete(self):
        recovery=Mock(spec=['assert_maintenance','query'])
        with reset_protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(ValueError,'phase_required'):effects.settle(journal,self.preflight,recovery)
            self.ready(journal)
            recovery.assert_maintenance.side_effect=RuntimeError('maintenance lost')
            with self.assertRaisesRegex(RuntimeError,'maintenance lost'):
                effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight)
            recovery.assert_maintenance.side_effect=None;self.deliver(None)
            with patch('scripts.reset_effects.snapshot',return_value=self.observed):
                with self.assertRaisesRegex(RuntimeError,'external_effects_unresolved'):
                    effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight)
            self.assertEqual(journal.value['steps'][-1]['step'],'quiesced')
            self.assertTrue((journal.directory/'unresolved-effects.json').exists())
            self.assertFalse((journal.directory/'settlement.json').exists())

    def test_durable_settlement_survives_interruption_before_phase_record(self):
        recovery=Mock(spec=['assert_maintenance','query'])
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch('scripts.reset_effects.snapshot',return_value=self.observed),patch.object(journal,'complete',side_effect=RuntimeError('interrupted')):
                with self.assertRaisesRegex(RuntimeError,'interrupted'):
                    effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight)
            original=(journal.directory/'settlement.json').read_bytes()
            with patch('scripts.reset_effects.snapshot',return_value=self.observed):
                result=effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight)
                self.assertEqual(effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight),result)
            self.assertTrue(result['settled']);self.assertEqual(journal.value['steps'][-1]['step'],'effects_settled')
            self.assertEqual((journal.directory/'settlement.json').read_bytes(),original)

    def test_changing_database_evidence_cannot_publish_settlement(self):
        recovery=Mock(spec=['assert_maintenance','query']);changed=copy.deepcopy(self.observed);changed['dispatches'][0]['state']='done'
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch('scripts.reset_effects.snapshot',side_effect=[self.observed,changed]):
                with self.assertRaisesRegex(RuntimeError,'evidence_changed'):
                    effects.settle(journal,self.preflight,recovery,inspect=lambda:self.preflight)
            self.assertFalse((journal.directory/'settlement.json').exists())
            self.assertEqual(journal.value['steps'][-1]['step'],'quiesced')


if __name__=='__main__':unittest.main()
