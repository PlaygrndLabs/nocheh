import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.knowledge import allowed_path, main


class KnowledgeCliTests(unittest.TestCase):
    def invoke(self,command,args):
        with patch('scripts.knowledge.API') as api,contextlib.redirect_stdout(io.StringIO()):
            api.return_value.call.return_value={}
            self.assertEqual(main(command,args),0)
            return api.return_value.call.call_args.args

    def test_reprocessing_requires_original_hash_and_idempotent_request(self):
        source='a'*64;artifact='b'*64
        path,body=self.invoke('sources',['reprocess',source,'--artifact',artifact,'--input-hash','c'*64,'--engine','nocheh-subscription','--version','pinned','--operation-id','job-1'])
        self.assertEqual(path,'/v1/sources/'+source+'/reprocess')
        self.assertEqual(body['input_hash'],'c'*64);self.assertEqual(body['operation_id'],'job-1')
        self.assertEqual(self.invoke('sources',['activate',artifact,'--revision','0','--operation-id','choose-1'])[1],{'expected_revision':None,'operation_id':'choose-1'})
        with patch('scripts.knowledge.API') as api,contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):main('sources',['activate',artifact,'--revision','0'])
            api.assert_not_called()

    def test_corrections_projects_and_sharing_use_exact_revisioned_payloads(self):
        with tempfile.TemporaryDirectory() as folder:
            text=Path(folder)/'correction.txt';text.write_text('Exact owner correction')
            path,body=self.invoke('learned',['correct','a'*64,'--revision','3','--operation-id','correction-1','--text-file',str(text)])
            self.assertTrue(path.endswith('/correct'));self.assertEqual(body,{'expected_revision':3,'operation_id':'correction-1','text':'Exact owner correction','retired':False})
            self.assertEqual(self.invoke('learned',['retire','a'*64,'--revision','4','--operation-id','retire-1'])[1]['retired'],True)
            file=Path(folder)/'request.json';value={'name':'A project','state':'archived','expected_revision':3,'operation_id':'archive-1'};file.write_text(json.dumps(value))
            self.assertEqual(self.invoke('projects',['save','--file',str(file)]),('/v1/projects',value))
            file.write_text(json.dumps({'enabled':False,'expected_revision':2,'operation_id':'revoke-1'}))
            self.assertEqual(self.invoke('sharing',['save','--file',str(file)])[1]['enabled'],False)
        self.assertEqual(self.invoke('projects',['effective','--space','-10/topic/77'])[0],'/v1/projects/effective?space=-10%2Ftopic%2F77')

    def test_owner_proxy_has_an_explicit_route_allowlist(self):
        for path in ['/v1/projects','/v1/learned?scope_kind=conversation&scope_id=-10','/v1/derivatives/'+'a'*64+'/activate','/v1/guards/events/'+'b'*64+'/history']:
            self.assertTrue(allowed_path(path),path)
        for path in ['https://example.com/v1/projects','//example.com/v1/projects','/v1/projects/../tools/execute','/v1/tools/execute','/v1/projects#fragment']:
            self.assertFalse(allowed_path(path),path)

    def test_sharing_approval_binds_preview_guard_and_text(self):
        preview='a'*64
        path,body=self.invoke('sharing',['approve',preview,'--revision','2','--guard-revision','3','--text-hash','b'*64,'--operation-id','approve-1'])
        self.assertEqual(path,'/v1/sharing/previews/'+preview+'/approve')
        self.assertEqual(body,{'expected_revision':2,'guard_revision':3,'text_hash':'b'*64,'operation_id':'approve-1'})
        self.assertEqual(self.invoke('sharing',['show-preview',preview]),('/v1/sharing/previews/'+preview,None))
        self.assertEqual(self.invoke('sharing',['revoke',preview,'--revision','1','--operation-id','revoke-1']),
                         ('/v1/sharing/releases/'+preview+'/revoke',{'expected_revision':1,'operation_id':'revoke-1'}))
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'preview.json';value={'rule_id':'c'*64,'source_ids':['d'*64],'content':'Exact text','operation_id':'preview-1'}
            file.write_text(json.dumps(value))
            self.assertEqual(self.invoke('sharing',['preview','--file',str(file)]),('/v1/sharing/preview',value))
        for path in ['/v1/sharing/preview','/v1/sharing/previews/'+preview,'/v1/sharing/previews/'+preview+'/approve','/v1/sharing/releases/'+preview+'/revoke']:
            self.assertTrue(allowed_path(path),path)
        self.assertFalse(allowed_path('/v1/sharing/releases/'+preview+'/deliver'))
