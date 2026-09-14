"""Native archive tools. Scope is bound by the trusted dispatcher, never an argument."""
import contextvars
import base64
import json
import os
import urllib.request

ARCHIVE_CREDENTIAL = contextvars.ContextVar('nocheh_archive_credential', default=None)
_PROCESS_CREDENTIAL = None
_PROCESS_PREFERENCES = None


def bind_process_preferences(values):
    global _PROCESS_PREFERENCES
    from .policy_config import validate
    validate(values);_PROCESS_PREFERENCES=dict(values)


def bind_process_credential(credential):
    """Trusted child startup binds once; tool arguments cannot replace the scope."""
    global _PROCESS_CREDENTIAL
    if _PROCESS_CREDENTIAL is not None or not isinstance(credential,str) or not credential.startswith(('scope.','turn.')):
        raise RuntimeError('invalid_process_scope_binding')
    _PROCESS_CREDENTIAL=credential


def request(path,body=None):
    credential = _PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()
    if not credential:
        raise RuntimeError('archive_scope_not_bound')
    req = urllib.request.Request(os.environ.get('ARCHIVE_URL','http://archive:8780') + path,
                                 data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                                 headers={'Authorization': 'Bearer ' + credential,'Content-Type':'application/json'})
    # Leave time for the broker's bounded Honcho recall, including cold guarding.
    timeout = 615 if path == '/v1/memory/honcho/recall' else 15
    with urllib.request.urlopen(req,timeout=timeout) as response:
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
        claims=json.loads(base64.urlsafe_b64decode((_PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()).split('.')[1]+'==='))
        shared=request('/v1/memory/context?'+urlencode({'q':query})) if claims.get('space') and claims.get('scope') is not None else {'sources':[]}
        return json.dumps({'sources':rows+shared['sources'],'filter_status':shared.get('filter_status')},ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'archive_search_unavailable'})


def read_tool(args, **kwargs):
    import re
    try:
        match=re.fullmatch(r'nocheh:(shared|filtered):([a-f0-9]{64})',args.get('id',''))
        if match:return json.dumps(request('/v1/memory/'+match[1]+'/'+match[2]),ensure_ascii=False)
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
        ('nocheh_archive_search','Search the current permitted archived text in your authorized scope. Cite returned source references.',
         {'query':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':10}},['query'],search_tool),
        ('nocheh_archive_read','Read an archived source. Originals and generated artifacts have distinct provenance.',
         {'id':{'type':'string'}},['id'],read_tool),
        ('nocheh_memory_recall','Recall primary Honcho memory for this audience, alongside native context and archive tools. Inferences are not original evidence.',
         {'query':{'type':'string'},'profile':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':50}},['query'],recall_tool),
        ('nocheh_action_request','Propose an external Telegram message. Nothing is sent until the owner reviews and approves the exact action in their private DM.',
         {'destination':{'type':'string','description':'Numeric Telegram chat ID'},'text':{'type':'string','maxLength':3500}},['destination','text'],action_tool),
    ):
        ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
            schema={'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':required,'additionalProperties':False}},
            handler=handler)
    for kind,description,properties,required in (
        ('shell','Propose a bounded shell command in this profile workspace. No network, credentials or other profiles are mounted. Owner approval or an exact standing permission is required.',
         {'command':{'type':'string','maxLength':16000}},['command']),
        ('browser','Propose inspection of one public HTTPS HTML page. The approved response renders offline without scripts or secondary requests. No logins, clicks or form submissions.',
         {'url':{'type':'string'}},['url']),
        ('mcp','Propose an MCP operation at a public HTTPS endpoint supporting 2025-11-25 JSON responses. Set operation=list to discover tools; for call supply tool and input. No ambient authentication, local processes, sampling or server-initiated capabilities.',
         {'url':{'type':'string'},'operation':{'type':'string','enum':['list','call']},'tool':{'type':'string'},'input':{'type':'object'}},['url']),
    ):
        name='nocheh_'+kind
        ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
            schema={'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':required,'additionalProperties':False}},
            handler=lambda args,_kind=kind,**kwargs:controlled_tool(_kind,args))
    name='nocheh_action_status';description='Read a proposed controlled action and its separate execution result in your authorized scope.'
    ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
        schema={'name':name,'description':description,'parameters':{'type':'object','properties':{'id':{'type':'string'}},'required':['id'],'additionalProperties':False}},handler=controlled_status)


def controlled_tool(kind,args):
    try:
        from pathlib import Path
        from .profile_config import inherited_config,read,preferences
        home=Path(os.environ['HERMES_HOME']);config,_=inherited_config(home,read(home/'config.yaml'))
        if (_PROCESS_PREFERENCES or preferences(config))['nocheh_tools.'+kind]!='on':return json.dumps({'error':'tool_disabled_by_owner'})
        return json.dumps(request('/v1/tools/propose',{'kind':kind,'arguments':args}),ensure_ascii=False)
    except Exception:return json.dumps({'error':'controlled_action_unavailable'})


def controlled_status(args,**kwargs):
    import re
    try:
        id=args.get('id','')
        if not re.fullmatch(r'[a-f0-9]{64}',id):raise ValueError('invalid_action')
        value=request('/v1/tools/actions/'+id)
        # Bound tool context; complete bytes remain in the archive and owner UI.
        result=json.dumps({key:value.get(key) for key in ('id','kind','state','result','result_id','error_code')},ensure_ascii=False)
        return result if len(result)<=24000 else json.dumps({'id':id,'state':value['state'],'result_id':value['result_id'],'excerpt':result[:22000],'truncated':True})
    except Exception:return json.dumps({'error':'controlled_action_unavailable'})


def action_tool(args,**kwargs):
    try:return json.dumps(request('/v1/action-requests',{'destination':args['destination'],'text':args['text']}),ensure_ascii=False)
    except Exception:return json.dumps({'error':'action_request_unavailable'})


def recall_tool(args, **kwargs):
    try:
        result=request('/v1/memory/honcho/recall',{'query':args.get('query','')})
        claims=json.loads(base64.urlsafe_b64decode((_PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()).split('.')[1]+'==='))
        if claims.get('scope') is None:
            result['native']=request('/v1/memory/recall',args)
        return json.dumps(result,ensure_ascii=False)
    except Exception:return json.dumps({'error':'owner_memory_unavailable'})
