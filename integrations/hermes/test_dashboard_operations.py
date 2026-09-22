import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.admin_operations import run,identifier
from scripts.graph import read

class DashboardOperationsTests(unittest.TestCase):
    def test_original_graph_does_not_depend_on_native_memory(self):
        original={'nodes':[{'id':'message:'+'a'*64,'kind':'message'}],'edges':[], 'bounds':{'truncated':False}}
        with patch('scripts.graph.API') as api:
            api.return_value.storage_layout='original-only-v1'
            api.return_value.call.side_effect=lambda path: original if path.startswith('/v1/graph?') else self.fail('native memory requested')
            graph=read('*')
            self.assertEqual(graph['nodes'],original['nodes'])
            self.assertEqual(graph['bounds']['messages'],1)
            self.assertEqual(graph['format'],'nocheh-context-graph-v1')
            api.return_value.call.assert_called_once_with('/v1/graph?scope=%2A&after=&focus=')

    def test_graph_keeps_only_scoped_context_entities_and_edges(self):
        original={'nodes':[{'id':'user:alice','kind':'user'}, {'id':'message:'+'a'*64,'kind':'message'},
                           {'id':'event:'+'b'*64,'kind':'event'}, {'id':'profile:fixture','kind':'profile'}],
                  'edges':[{'from':'user:alice','to':'message:'+'a'*64,'kind':'authored'},
                           {'from':'event:'+'b'*64,'to':'message:'+'a'*64,'kind':'attempt'},
                           {'from':'profile:fixture','to':'message:'+'a'*64,'kind':'explicit_citation'}]}
        with patch('scripts.graph.API') as api:
            api.return_value.call.side_effect=lambda path: original if path.startswith('/v1/graph?') else self.fail('native memory requested')
            graph=read('-20')
        self.assertEqual([node['kind'] for node in graph['nodes']],['user','message'])
        self.assertEqual([edge['kind'] for edge in graph['edges']],['authored'])
        self.assertNotIn('profile:fixture',json.dumps(graph))
        self.assertNotIn('event:'+'b'*64,json.dumps(graph))

    def test_graph_normalizes_legacy_scope_and_author_as_context_entities(self):
        original={'nodes':[{'id':'scope:123','kind':'scope','label':'Private chat · @alice'},
                           {'id':'author:alice','kind':'author','label':'@alice'},
                           {'id':'project:work','kind':'project','label':'Work'}],
                  'edges':[{'from':'author:alice','to':'scope:123','kind':'member'},
                           {'from':'project:work','to':'scope:123','kind':'assigned'}],
                  'bounds':{'truncated':True}}
        with patch('scripts.graph.API') as api:
            api.return_value.call.return_value=original
            graph=read('*')
        self.assertEqual([(node['id'],node['kind']) for node in graph['nodes']],
                         [('group:123','group'),('user:alice','user'),('project:work','project')])
        self.assertEqual([(edge['from'],edge['to']) for edge in graph['edges']],
                         [('user:alice','group:123'),('project:work','group:123')])
        self.assertEqual(graph['bounds'],{'users':1,'projects':1,'groups':1,'messages':0,'truncated':True})

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
