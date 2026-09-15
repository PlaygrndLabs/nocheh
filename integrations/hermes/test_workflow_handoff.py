import io
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.archive import digest
from scripts.workflow_handoff import import_records,stopped_dashboard
from scripts.tool_receipts import flush_receipts


class WorkflowHandoffTests(unittest.TestCase):
    def test_import_handoff_refuses_a_running_owner_dashboard(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1',0));server.listen()
            with patch.dict(os.environ,{'NOCHEH_DASHBOARD_PORT':str(server.getsockname()[1])}):
                with self.assertRaisesRegex(RuntimeError,'stop_owner_dashboard'):
                    with stopped_dashboard():self.fail('running dashboard was not fenced')

    def test_import_handoff_preserves_mapping_consent_checkpoint_and_closed_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);jobs=root/'admin/jobs';jobs.mkdir(parents=True)
            identity='11111111-1111-4111-8111-111111111111';folder=jobs/identity;folder.mkdir();data=b'{"private":"synthetic source"}'
            (folder/'result.json').write_bytes(data)
            job={'id':identity,'kind':'import','state':'interrupted','completed':1,'duplicates':1,'review_approved':False,'mapping':{'42':'42'},'preview':{'file':'result.json','sha256':digest(data),'messages':3}}
            (folder/'job.json').write_text(json.dumps(job));calls=[]
            class API:
                def call(self,path,body=None):calls.append((path,body));return {'state':'queued'}
            with patch('scripts.workflow_handoff.load',return_value={'TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':''}):
                migration={'id':'a'*64,'to_owner':'inngest'}
                self.assertEqual(import_records(root,API(),migration),{'staged':1,'closed':0})
                self.assertEqual(calls[0][1]['completed'],1);self.assertFalse(calls[0][1]['review_approved']);self.assertEqual(calls[0][1]['learning_after'],0)
                self.assertNotIn('synthetic source',json.dumps(calls));self.assertNotIn('mapping',calls[0][1])
                saved=json.loads((folder/'job.json').read_text());self.assertEqual(saved['mapping'],job['mapping']);self.assertEqual(saved['workflow'],'inngest')
                saved['state']='cancelled';(folder/'job.json').write_text(json.dumps(saved));calls.clear()
                self.assertEqual(import_records(root,API(),migration),{'staged':0,'closed':1});self.assertEqual(calls,[])
                saved['state']='interrupted';saved.pop('review_approved');(folder/'job.json').write_text(json.dumps(saved))
                with self.assertRaisesRegex(ValueError,'confirmed_import_configuration_required'):import_records(root,API(),migration)
                saved['review_approved']=False;(folder/'job.json').write_text(json.dumps(saved));(folder/'result.json').write_bytes(b'edited')
                with self.assertRaisesRegex(ValueError,'export_integrity_failed'):import_records(root,API(),migration)

    def test_tool_receipt_handoff_never_claims_and_lost_ack_preserves_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);receipts=root/'admin/tools/receipts';receipts.mkdir(parents=True);path=receipts/('a'*64+'.json')
            body={'id':'a'*64,'actor':'existing-actor','state':'done','result':{'private':'protected result'}};path.write_text(json.dumps(body))
            class API:
                def __init__(self):self.fail=True;self.calls=[]
                def call(self,route,value):
                    self.assert_route(route);self.calls.append(value)
                    if self.fail:raise RuntimeError('lost ack')
                def assert_route(self,route):
                    if route!='/v1/tools/finish':raise AssertionError('handoff attempted execution')
            api=API()
            with self.assertRaisesRegex(RuntimeError,'lost ack'):flush_receipts(root,api)
            self.assertTrue(path.exists());api.fail=False
            self.assertEqual(flush_receipts(root,api),1);self.assertFalse(path.exists());self.assertEqual(api.calls,[body,body])

    def test_retired_import_runner_cannot_execute(self):
        from scripts.management import dispatch
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);identity='11111111-1111-4111-8111-111111111111'
            with patch.dict('os.environ',{'NOCHEH_STATE_DIR':str(root)}),patch('scripts.import_job.run') as execute:
                with self.assertRaisesRegex(ValueError,'unknown_operation'):dispatch({'operation':'import.run','job':identity,'mapping':{}})
                execute.assert_not_called()

    def test_retained_completion_receipt_survives_lost_ack_without_reimport(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);identity='11111111-1111-4111-8111-111111111111';folder=root/'admin/jobs'/identity;folder.mkdir(parents=True)
            job={'id':identity,'kind':'import','state':'failed','review_approved':False,'mapping':{},'preview':{'sha256':'a'*64,'messages':3}}
            (folder/'job.json').write_text(json.dumps(job));policy={'TELEGRAM_OWNER_ID':'42','TELEGRAM_GROUP_IDS':''}
            receipt=folder/'workflow-receipt.json';body={'id':identity,'configuration_hash':'b'*64,'completed':3,'duplicates':1,'learning_after':0};receipt.write_text(json.dumps(body))
            class FinishedAPI:
                fail=True
                def call(self,path,value):
                    if path!='/v1/workflows/imports/reconcile-receipt' or value!=body:raise AssertionError('completion was reimported')
                    if self.fail:raise RuntimeError('lost ack')
                    return {'state':'completed'}
            api=FinishedAPI()
            with patch('scripts.workflow_handoff.load',return_value=policy):
                with self.assertRaisesRegex(RuntimeError,'lost ack'):import_records(root,api,{'id':'a'*64,'to_owner':'inngest'})
                self.assertTrue(receipt.exists());api.fail=False
                self.assertEqual(import_records(root,api,{'id':'a'*64,'to_owner':'inngest'}),{'staged':0,'closed':1})
            self.assertFalse(receipt.exists());self.assertEqual(json.loads((folder/'job.json').read_text())['state'],'complete')
