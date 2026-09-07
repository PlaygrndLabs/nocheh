import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from .cli_runner import validate,read_request

class CliTests(unittest.TestCase):
    def test_read_lookup_never_creates_and_missing_is_error(self):
        calls=[]
        def original(client,method,path,**kwargs):
            calls.append((method,path,kwargs));return {'items':[{'id':'existing','metadata':{}}]}
        client=SimpleNamespace(base_url='http://honcho:8000')
        result=read_request(original,client,'POST','/v3/workspaces/w/peers',body={'id':'existing'})
        self.assertEqual(result['id'],'existing');self.assertEqual(calls[0][1],'/v3/workspaces/w/peers/list')
        with self.assertRaises(ValueError):read_request(original,client,'POST','/v3/workspaces/w/peers',body={'id':'missing'})
        for method,path,body in [('POST','/v3/workspaces/w/peers',{'id':'x','metadata':{}}),('POST','/v3/workspaces/w/peers/p/chat',{}),('POST','/v3/workspaces/w/peers/p/representation',{'search_query':'costs money'}),('DELETE','/v3/workspaces/w',{})]:
            with self.assertRaises(ValueError):read_request(original,client,method,path,body=body)
        client.base_url='https://api.honcho.dev'
        with self.assertRaises(ValueError):read_request(original,client,'POST','/v3/workspaces/list')

    def test_options_pagination_and_unavailable(self):
        for args in (['init'],['peer','chat','p'],['workspace','list','--base-url=https://remote'],['peer','representation','p','--search-query','cost']):
            with self.assertRaises(ValueError):validate(args)
        validate(['session','view','s','-w','w','--page','2','--size','50'])
        with self.assertRaises(ValueError):read_request(None,SimpleNamespace(base_url='http://honcho:8000'),'POST','/v3/workspaces/list',query={'page':101})
        from scripts.honcho import read
        with patch('scripts.honcho.status',return_value={'running':False}),patch('subprocess.run') as run:
            self.assertEqual(read(['workspace','list'])['error'],'honcho_experiment_not_running');run.assert_not_called()
