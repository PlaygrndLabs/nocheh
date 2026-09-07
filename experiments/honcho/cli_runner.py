"""Pinned official CLI with a read-only transport for the isolated experiment."""
import contextlib
import io
import json
import os
import re
import sys
from pathlib import Path

ALLOWED = {'workspace': {'list','inspect','queue-status'}, 'peer': {'list','inspect','card','get-metadata','representation'},
           'session': {'list','view','peers','get-metadata'}, 'message': {'list','get'}, 'conclusion': {'list'}}
ID = r'[A-Za-z0-9_-]+'
COLLECTION = rf'/v3/workspaces(?:/{ID}/(?:peers|sessions))?'
LIST = rf'(?:{COLLECTION}/list|/v3/workspaces/{ID}/peers/{ID}/sessions|/v3/workspaces/{ID}/sessions/{ID}/messages/list|/v3/workspaces/{ID}/conclusions/list)'
GET = rf'/v3/workspaces/{ID}/(?:queue/status|peers/{ID}/card|sessions/{ID}/(?:peers|messages/{ID}))'


def validate(args):
    if len(args)<2 or args[1] not in ALLOWED.get(args[0],set()): raise ValueError('honcho_command_denied')
    # The CLI cannot select a different endpoint, account, stack, or inference.
    flags={'-w','--workspace','-p','--peer','-s','--session','--json','--last','--reverse','--brief','--target','--max-conclusions','--observer','--observed','--size','--page','--all','--ids'}
    if any(a.startswith('-') and a.split('=')[0] not in flags for a in args[2:]): raise ValueError('honcho_option_denied')
    if len(args)>30 or any(not isinstance(a,str) or len(a)>256 for a in args): raise ValueError('honcho_arguments_invalid')
    return args


def read_request(original, client, method, path, **kwargs):
    if client.base_url!='http://honcho:8000': raise ValueError('honcho_endpoint_denied')
    body=kwargs.get('body') or {}; query=kwargs.get('query') or {}
    if method=='POST' and re.fullmatch(COLLECTION,path):
        if set(body)!={'id'} or not re.fullmatch(ID,body['id']): raise ValueError('honcho_write_denied')
        result=original(client,'POST',path+'/list',body={'filters':{'id':body['id']}},query={'page':1,'size':2})
        items=[item for item in result['items'] if item['id']==body['id']]
        if len(items)!=1: raise ValueError('honcho_resource_not_found')
        return items[0]
    allowed=(method=='POST' and re.fullmatch(LIST,path)) or (method=='GET' and re.fullmatch(GET,path))
    if method=='POST' and re.fullmatch(rf'/v3/workspaces/{ID}/peers/{ID}/representation',path):
        allowed=not body.get('search_query') and not body.get('search')
    if not allowed: raise ValueError('honcho_inference_or_write_denied')
    if int(query.get('page',1))>100 or int(query.get('size',50))>100: raise ValueError('honcho_export_limit')
    return original(client,method,path,**kwargs)


def main(args=None):
    args=validate(args if args is not None else sys.argv[1:])
    # Never load an ambient global CLI account or OAuth grant.
    import tempfile
    with tempfile.TemporaryDirectory() as config:
        for key in list(os.environ):
            if key.startswith('HONCHO_'): del os.environ[key]
        os.environ.update(HONCHO_CONFIG_DIR=config,HONCHO_API_KEY=Path('/state/internal_token').read_text().strip(),
                          HONCHO_BASE_URL='http://honcho:8000',HONCHO_NO_UPDATE_CHECK='1',HONCHO_JSON='1')
        from honcho.http.client import HonchoHTTPClient
        original=HonchoHTTPClient.request
        pages=[]
        def request(client,method,path,**kwargs):
            result=read_request(original,client,method,path,**kwargs)
            if isinstance(result,dict) and 'pages' in result:
                pages.append({'path':path,'page':result.get('page'),'pages':result.get('pages'),'total':result.get('total')})
            return result
        HonchoHTTPClient.request=request
        from honcho_cli.main import app
        output=io.StringIO()
        try:
            with contextlib.redirect_stdout(output),contextlib.redirect_stderr(io.StringIO()):
                app(args=args,standalone_mode=False)
            value=json.loads(output.getvalue())
            if isinstance(value,dict) and 'error' in value: raise ValueError('honcho_upstream_error')
            print(json.dumps({'data':value,'pagination':pages,'complete':True,'selection':args[:2],
                              'note':'Complete for the requested command/limit; message list defaults to the most recent 20.'}))
            return 0
        except Exception as error:
            code=str(error) if isinstance(error,ValueError) and str(error).startswith('honcho_') else 'honcho_upstream_unavailable_or_incompatible'
            print(json.dumps({'error':code,'complete':False}));return 1
        finally: HonchoHTTPClient.request=original


if __name__=='__main__':
    try: raise SystemExit(main())
    except ValueError as error: print(json.dumps({'error':str(error),'complete':False}));raise SystemExit(1)
