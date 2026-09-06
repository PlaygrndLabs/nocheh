"""Native archive tools. Scope is bound by the trusted dispatcher, never an argument."""
import contextvars
import base64
import json
import os
import urllib.request

ARCHIVE_CREDENTIAL = contextvars.ContextVar('nocheh_archive_credential', default=None)


def request(path):
    credential = ARCHIVE_CREDENTIAL.get()
    if not credential:
        raise RuntimeError('archive_scope_not_bound')
    req = urllib.request.Request(os.environ.get('ARCHIVE_URL','http://archive:8780') + path,
                                 headers={'Authorization': 'Bearer ' + credential})
    with urllib.request.urlopen(req,timeout=15) as response:
        data=response.read(2*1024*1024+1)
        if len(data)>2*1024*1024:
            raise ValueError('archive_response_too_large')
        return json.loads(data)


def search_tool(args, **kwargs):
    from urllib.parse import urlencode
    try:
        query=args.get('query')
        if not isinstance(query,str) or not 0<len(query)<=2000:
            raise ValueError('invalid_query')
        rows=request('/v1/search?'+urlencode({'q':query,'limit':min(10,max(1,int(args.get('limit',5))))}))
        return json.dumps({'sources':rows},ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'archive_search_unavailable'})


def read_tool(args, **kwargs):
    import re
    try:
        source=args.get('id','').removeprefix('nocheh:event:')
        if not re.fullmatch('[a-f0-9]{64}',source):
            raise ValueError('invalid_source')
        record=request('/v1/events/'+source)
        event=record['event']; text=event.get('text') or ''
        # Full raw payloads remain available through authenticated archive/export.
        # Model context is bounded and labels separately generated content.
        return json.dumps({'source':record['source'],'scope':event['scope'],'origin':event['origin'],
                           'kind':event['kind'],'text':text[:12000],'truncated':len(text)>12000,
                           'artifacts':[{'id':a['id'],'kind':a['kind'],'state':a['state']} for a in record['artifacts'][:50]],
                           'derived':[{'id':d['id'],'kind':d['kind'],
                             'text':base64.b64decode(d['content_base64']).decode('utf-8',errors='replace')[:2000],
                             'provenance':str(d['provenance'])[:1000]} for d in record['derived'][:5]]},ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'archive_source_unavailable'})


def register(ctx):
    for name,description,properties,required,handler in (
        ('nocheh_archive_search','Search original archived text in your authorized scope. Cite returned source references.',
         {'query':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':10}},['query'],search_tool),
        ('nocheh_archive_read','Read an archived source. Originals and generated artifacts have distinct provenance.',
         {'id':{'type':'string'}},['id'],read_tool),
    ):
        ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
            schema={'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':required,'additionalProperties':False}},
            handler=handler)
