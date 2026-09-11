import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.admin_operations import run,identifier
from scripts.graph import read

class DashboardOperationsTests(unittest.TestCase):
    def test_graph_citations_only_join_selected_scoped_page(self):
        def call(path,body=None):
            if path.startswith('/v1/graph'):return {'nodes':[{'id':'event:'+'a'*64}],'edges':[]}
            if body['action']=='profiles':return {'profiles':[{'scope':'-20','profile':'fixture','exists':True}]}
            return {'profile':'fixture','memories':[{'exists':True,'name':'MEMORY.md','text':'note','sha256':'hash','truncated':False,'citations':['a'*64,'b'*64]}]}
        with patch('scripts.graph.API') as api:
            api.return_value.call.side_effect=call
            graph=read('-20')
        citations=[e for e in graph['edges'] if e['kind']=='explicit_citation']
        self.assertEqual([e['to'] for e in citations],['event:'+'a'*64]);self.assertEqual(graph['nodes'][-1]['unresolved_citations'],1)
        self.assertNotIn('b'*64,json.dumps(graph))

    def test_operations_fixed_destinations_and_inactive_restore(self):
        job='11111111-1111-4111-8111-111111111111';backup='22222222-2222-4222-8222-222222222222'
        with tempfile.TemporaryDirectory() as folder,patch('scripts.admin_operations.subprocess.run') as command:
            state=Path(folder);command.return_value.returncode=0;command.return_value.stdout='{"status":"restored_inactive"}'
            result=run(state,'restore',job,{'backup':backup,'port':19543})
            self.assertEqual(result['status'],'restored_inactive')
            args=command.call_args.args[0];self.assertIn('nocheh-restore-'+job,args);self.assertIn(str(state/'admin/restores'/job),args)
            self.assertNotIn('login',args)
            with self.assertRaises(ValueError):run(state,'restore',job,{'backup':'../private','port':19543})
            with self.assertRaises(ValueError):run(state,'shell',job,{'command':'anything'})
            with self.assertRaises(ValueError):run(state,'restore',job,{'backup':backup,'port':1})
        for value in ('../escape','',None,'1'*36):
            with self.assertRaises(ValueError):identifier(value)
