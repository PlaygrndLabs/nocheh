"""Run with cli-requirements.txt installed; exercises the real pinned CLI/SDK."""
import contextlib
import io
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch
from .cli.cli_runner import main

class UpstreamCliTests(unittest.TestCase):
    def test_official_cli_pagination_and_credential_isolation(self):
        from honcho.http.client import HonchoHTTPClient
        calls=[]
        def response(client,method,path,**kwargs):
            self.assertEqual(client.base_url,'http://honcho-api:8000');self.assertEqual(client.api_key,'synthetic-experiment-token')
            self.assertEqual(method,'POST');self.assertTrue(path.endswith('/list'));calls.append((path,kwargs))
            query=kwargs.get('query') or {};body=kwargs.get('body') or {};page=query.get('page',1)
            selected=body.get('filters',{}).get('id')
            item={'workspace_id':'fixture','id':selected or 'peer'+str(page),'metadata':{},'configuration':{},'created_at':'2026-01-01T00:00:00Z'}
            return {'items':[item],'page':page,'pages':1 if selected else 2,'total':1 if selected else 2,'size':1}
        original=Path.read_text
        def token(path,*args,**kwargs):return 'synthetic-experiment-token' if str(path)=='/state/internal_token' else original(path,*args,**kwargs)
        output=io.StringIO()
        with patch.dict(os.environ,{'HONCHO_API_KEY':'unrelated-secret','HONCHO_BASE_URL':'https://wrong.invalid'}),patch.object(Path,'read_text',token),patch.object(HonchoHTTPClient,'request',response),contextlib.redirect_stdout(output):
            code=main(['peer','list','-w','fixture'])
        self.assertEqual(code,0,output.getvalue());value=json.loads(output.getvalue())
        self.assertEqual([row['id'] for row in value['data']],['peer1','peer2']);self.assertTrue(value['complete'])
        self.assertEqual(len(value['pagination']),2);self.assertEqual(len(calls),3)
