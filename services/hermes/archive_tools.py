"""Native archive tools. Scope is bound by the trusted dispatcher, never an argument."""
import contextvars
import base64
import json
import math
import os
import re
import time
import urllib.request

ARCHIVE_CREDENTIAL = contextvars.ContextVar('nocheh_archive_credential', default=None)
_PROCESS_CREDENTIAL = None
_PROCESS_PREFERENCES = None
_PROCESS_DEADLINE = None


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


def bind_process_deadline(deadline):
    """Bound a foreground memory call to the trusted parent turn lifetime (a background job step is the longest)."""
    global _PROCESS_DEADLINE
    if (_PROCESS_DEADLINE is not None or isinstance(deadline,bool) or
            not isinstance(deadline,(int,float)) or not math.isfinite(deadline) or
            deadline > time.time()+600):
        raise RuntimeError('invalid_process_deadline')
    _PROCESS_DEADLINE=float(deadline)


def request(path,body=None):
    credential = _PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()
    if not credential:
        raise RuntimeError('archive_scope_not_bound')
    req = urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780') + path,
                                 data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                                 headers={'Authorization': 'Bearer ' + credential,'Content-Type':'application/json'})
    # Prepared context can include a cold guard-model pass. It is still bounded,
    # but must not share the short timeout used by ordinary archive reads.
    timeout = 615 if path == '/v1/memory/honcho/recall' else 60 if path in ('/v1/context/prepare', '/v1/memory/honcho/search') or path.startswith('/v1/jobs/') else 15
    if path == '/v1/memory/honcho/recall' and _PROCESS_DEADLINE is not None:
        # Leave time for Hermes to reason and check delivery policy.
        timeout = min(timeout, _PROCESS_DEADLINE-time.time()-45)
        if timeout <= 0:raise TimeoutError('memory_recall_turn_budget_exhausted')
    with urllib.request.urlopen(req,timeout=timeout) as response:
        data=response.read(2*1024*1024+1)
        if len(data)>2*1024*1024:
            raise ValueError('archive_response_too_large')
        return json.loads(data)


def import_status():
    """History still being imported says so, so an answer about it is not taken as complete."""
    try:
        pending=request('/v1/imports/pending').get('imports') or []
        return '; '.join(f"Still importing{' '+item['label'] if item.get('label') else ''}: {int(item['ready_percent'])}% of "
                         f"{int(item['messages'])} messages ready, so older history may be missing" for item in pending) or None
    except Exception:
        return None


def search_tool(args, **kwargs):
    from urllib.parse import urlencode
    try:
        mode=args.get('mode','text')
        count=min(10,max(1,int(args.get('limit',5))))
        if mode=='current_reactions':
            return json.dumps(request('/v1/search?'+urlencode({'mode':mode,'limit':count})),ensure_ascii=False)
        if mode!='text':raise ValueError('invalid_search_mode')
        query=args.get('query')
        if not isinstance(query,str) or not query.strip() or len(query)>2000:
            raise ValueError('invalid_query')
        status=import_status()
        rows=request('/v1/search?'+urlencode({'q':query,'limit':count}))
        claims=json.loads(base64.urlsafe_b64decode((_PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()).split('.')[1]+'==='))
        shared=request('/v1/memory/context?'+urlencode({'q':query})) if claims.get('space') and claims.get('scope') is not None else {'sources':[]}
        return json.dumps({'sources':rows+shared['sources'],'filter_status':shared.get('filter_status'),**({'import_status':status} if status else {})},ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'archive_search_unavailable'})


def page_tool(args, **kwargs):
    from urllib.error import HTTPError
    from urllib.parse import urlencode
    try:
        query={key:args[key] for key in ('chat','from','to','after') if isinstance(args.get(key),str) and args[key]}
        query['limit']=min(50,max(1,int(args.get('limit',30))))
        status=import_status()
        return json.dumps({**request('/v1/archive/page?'+urlencode(query)),**({'import_status':status} if status else {})},ensure_ascii=False)
    except HTTPError as error:
        # The agent can correct its own arguments; other failures stay opaque.
        return json.dumps({'error':{400:'invalid_page_request',403:'conversation_not_permitted'}.get(error.code,'archive_page_unavailable'),
                           **({'note':'from and to are YYYY-MM-DD or a time with its zone; after is the next value of the previous page.'} if error.code==400 else {})})
    except Exception:
        return json.dumps({'error':'archive_page_unavailable'})


def meaning_tool(args, **kwargs):
    try:
        query=args.get('query')
        if not isinstance(query,str) or not query.strip() or len(query)>2000:raise ValueError('invalid_query')
        return json.dumps(request('/v1/memory/honcho/search',{'query':query,'limit':min(10,max(1,int(args.get('limit',5))))}),ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'memory_search_unavailable'})


JOB_ERRORS=('invalid_job_request','job_not_permitted','job_not_found','job_limit_reached','job_not_running','job_in_a_job')


def job_tool(args, **kwargs):
    """Background jobs: size a chat, ask to start a job, list this chat's jobs, or stop one."""
    from urllib.error import HTTPError
    try:
        action=args.get('action')
        if action not in ('size','propose','status','stop'):raise ValueError('invalid_job_action')
        body={key:args[key] for key in ('title','instruction','chat','from','to','id') if isinstance(args.get(key),str) and args[key]}
        return json.dumps(request('/v1/jobs/'+action,body),ensure_ascii=False)
    except HTTPError as error:
        # Storage says what to correct, such as a member's daily limit; other failures stay opaque.
        try:code=json.loads(error.read(4096)).get('error')
        except Exception:code=None
        return json.dumps({'error':code if code in JOB_ERRORS else {400:'invalid_job_request',403:'job_not_permitted',404:'job_not_found'}.get(error.code,'background_jobs_unavailable')})
    except Exception:
        return json.dumps({'error':'background_jobs_unavailable'})


def reaction_observation(event):
    """Retain guarded reaction evidence; unrelated payload content stays omitted."""
    payload=event.get('payload')
    if not isinstance(payload,dict):return None
    for key,mode,fields in (
        ('message_reaction','individual',('date','user','actor_chat','old_reaction','new_reaction')),
        ('message_reaction_count','aggregate',('date','reactions')),
    ):
        value=payload.get(key)
        if not isinstance(value,dict):continue
        observation={'mode':mode,**{field:value[field] for field in fields if field in value}}
        if len(json.dumps(observation,ensure_ascii=False))>6000:return {'mode':mode,'unavailable':'observation_size_limit'}
        return observation
    return None


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
                           'reaction_observation':reaction_observation(event),
                           'current_reactions':record.get('current_reactions',{'sources':[],'complete':False}),
                           'artifacts':[{'id':a['id'],'kind':a['kind'],'state':a['state']} for a in record['artifacts'][:50]],
                           'derived':[{'id':d['id'],'kind':d['kind'],
                             'text':base64.b64decode(d['content_base64']).decode('utf-8',errors='replace')[:2000],
                             'provenance':str(d['provenance'])[:1000]} for d in record['derived'][:5]]},ensure_ascii=False)
    except Exception:
        return json.dumps({'error':'archive_source_unavailable'})


def register(ctx):
    from .knowledge_tools import register as register_knowledge
    register_knowledge(ctx)
    for name,description,properties,required,handler in (
        ('nocheh_archive_search','Find permitted archive evidence in your authorized scope. For reaction questions without a known note ID, use mode=current_reactions with no query. Results include the guarded reaction observation and bounded target text; read source references for further detail. An individual empty new_reaction list records that actor removing their reaction; it does not prove task completion or that nobody else reacted. This captured evidence is incomplete; empty search results do not prove no reactions. For mode=text (default), query is required and every query word must match; try one or two distinctive words when a longer search misses. Cite returned source references.',
         {'mode':{'type':'string','enum':['text','current_reactions']},'query':{'type':'string','description':'Required for text mode; omitted for current_reactions.'},'limit':{'type':'integer','minimum':1,'maximum':10}},[],search_tool),
        ('nocheh_archive_read','Read an archived source, its observed reaction data, and links to captured current reactions. Follow reaction links to inspect changes or removals; a reaction is not proof of task completion. Originals and generated artifacts have distinct provenance.',
         {'id':{'type':'string'}},['id'],read_tool),
        ('nocheh_archive_page','Read a conversation in time order, oldest first, one page at a time: messages, edits, reactions, replies and the text of their files and voice notes. '
         'Use it to go through a period (from and to as YYYY-MM-DD) or a whole chat; pass next as after for the following page until complete is true. '
         'position says how many of the chat\'s records are read through. Only the owner may name another chat, by an ID from nocheh_owner_read.',
         {'chat':{'type':'string'},'from':{'type':'string'},'to':{'type':'string'},'after':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':50}},[],page_tool),
        ('nocheh_memory_search','Find archived messages by meaning rather than exact words, among the messages learned into memory for this audience. '
         'Chats that were not learned return nothing (learned is false); use nocheh_archive_search or nocheh_archive_page for them. Cite returned source references.',
         {'query':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':10}},['query'],meaning_tool),
        ('nocheh_memory_recall','Recall primary Honcho memory for this audience, alongside native context and archive tools. Inferences are not original evidence: evidence_sources lists archived messages behind the conclusions Honcho read, so read them with nocheh_archive_read before relying on a claim that matters.',
         {'query':{'type':'string'},'profile':{'type':'string'},'limit':{'type':'integer','minimum':1,'maximum':50}},['query'],recall_tool),
        ('nocheh_action_request','Propose an external Telegram message. In a group, a message to that same group is posted without approval; a message to another chat waits for the owner to approve the exact message. The result says which.',
         {'destination':{'type':'string','description':'Use current for this Telegram conversation including its topic, a numeric Telegram chat ID, or CHAT_ID/topic/THREAD_ID. The server resolves current from the authenticated source turn.'},'text':{'type':'string','maxLength':3500}},['destination','text'],action_tool),
        ('nocheh_background_job','Background jobs: work too big for one reply, such as reading a whole chat or months of messages, which runs on its own and '
         'reports back here when it is done. action=size counts what a chat holds, or the period from and to (YYYY-MM-DD): messages, files and voice notes, '
         'with an estimate of the time and cost to read it all. action=propose asks to start a job, with a short title and the full instruction it will follow, '
         'written so that a fresh session can do it without this conversation; nothing runs until it is approved with buttons, and the result says who approves '
         'and what to tell the person. action=status lists this chat\'s jobs with their progress; action=stop with id stops one. Only the owner may name another chat.',
         {'action':{'type':'string','enum':['size','propose','status','stop']},'title':{'type':'string','maxLength':100},'instruction':{'type':'string','maxLength':8000},
          'chat':{'type':'string'},'from':{'type':'string'},'to':{'type':'string'},'id':{'type':'string'}},['action'],job_tool),
        ('nocheh_telegram_destinations','In a group: list the groups, with names and exact IDs, where the person asking is allowed to use Nocheh. Use an exact ID from here as an action destination; a message to another group waits for the owner\'s approval.',
         {},[],destinations_tool),
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
    name='nocheh_owner_read';description=('Read the owner\'s own directory: known Telegram conversations with names and IDs (conversations, '
        'telegram-identities), one conversation\'s context (conversation-context with space), people, projects, project-assignments and the '
        'memory-map. Available only in the owner\'s private conversation. Use exact IDs from here as action destinations.')
    ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
        schema={'name':name,'description':description,'parameters':{'type':'object','properties':{
            'view':{'type':'string','enum':list(OWNER_VIEWS)},'space':{'type':'string'},'q':{'type':'string'},'after':{'type':'string'}},
            'required':['view'],'additionalProperties':False}},handler=owner_read)
    name='nocheh_tasks';description=('Task lists kept by Nocheh, like a Notion table. Each task has a scope: personal (the owner\'s own life and personal tasks) or one '
        'project, whose tasks form that project\'s own private list. A task has a status (names from settings.statuses in a list result, such as To do, '
        'In progress, Waiting, Done or Dropped), a priority (0 none to 4 urgent, or its name from settings.priorities), optional start_on and due_on calendar days '
        '(YYYY-MM-DD) with optional start_time and due_time (HH:MM in settings.time_zone), tags such as Health or Money, a group (a group or topic ID), '
        'assignees (who does it) and people (who it is about), both IDs of people Nocheh knows, the owner\'s own columns (properties, by column name or id from '
        'settings.properties), notes, a parent task (a subtask), tasks it is blocked_by, related tasks, links (attachments of kind link with a url), '
        'reminders and a repeat. Use it when someone asks you to remember something to do, to list what is open, due today or coming up, or to finish, drop, '
        'reopen, rename, reschedule, tag, assign, move, comment on, archive or delete a task. '
        'action=list reads tasks (state open by default; done, dropped or all; when today or upcoming; scope all, personal or a project id; optionally one tag, '
        'group, person, status, priority, parent id or top, q to search words, sort due, priority, manual, created or updated) and returns the lists (scopes), '
        'tags in use, settings and today. action=get reads one task with its subtasks, links, comments and history. action=add needs title and takes the fields '
        'above; a task the owner does not tie to a project is personal, a subtask joins its parent\'s list, and a task added in a group points to that group. '
        'action=update needs id and the expected_revision from the latest list or get, plus the fields to change; lists such as tags, people, assignees, '
        'blocked_by, related, attachments and reminders replace the whole list, null clears a field, state done finishes a task (a repeating task then makes '
        'its next one), archived true archives it and trashed true moves it to the trash. action=comment adds text as a comment. '
        'reminders are times like 2030-01-04T09:00 in settings.time_zone and are sent to the owner\'s private chat; repeat is '
        '{"every":1,"unit":"day|week|month|year","weekdays":[1,4],"from":"due|done"} (weekdays only with week, 0 is Sunday) or null. '
        'In the owner private conversation every list is available; in a chat that belongs to a project only that project\'s list is, and nothing else; '
        'elsewhere none.')
    day={'type':['string','null']};ids={'type':'array','items':{'type':'string'},'maxItems':20}
    ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
        schema={'name':name,'description':description,'parameters':{'type':'object','properties':{
            'action':{'type':'string','enum':['list','get','add','update','comment']},'state':{'type':'string','enum':['open','done','dropped','all']},
            'when':{'type':'string','enum':['today','upcoming']},'sort':{'type':'string','enum':['due','priority','manual','created','updated']},
            'id':{'type':'string'},'expected_revision':{'type':'integer','minimum':1},'title':{'type':'string','maxLength':300},
            'notes':{'type':'string','maxLength':20000},'status':{'type':'string'},'priority':{'type':['integer','string']},
            'start_on':day,'start_time':day,'due_on':day,'due_time':day,'scope':{'type':'string'},
            'tags':{'type':'array','items':{'type':'string','maxLength':40},'maxItems':20},'group':{'type':['string','null']},
            'people':ids,'assignees':ids,'blocked_by':ids,'related':ids,'parent':{'type':['string','null']},
            'properties':{'type':'object'},'repeat':{'type':['object','null']},
            'reminders':{'type':'array','items':{'type':'string'},'maxItems':10},
            'attachments':{'type':'array','items':{'type':'object'},'maxItems':20},
            'archived':{'type':'boolean'},'trashed':{'type':'boolean'},'text':{'type':'string','maxLength':4000},
            'tag':{'type':'string','maxLength':40},'person':{'type':'string'},'q':{'type':'string','maxLength':200},
            'after':{'type':'string'}},
            'required':['action'],'additionalProperties':False}},handler=tasks_tool)
    name='nocheh_notion';description=('The owner\'s own Notion, through Notion\'s MCP server, when the owner has connected it and turned it on. Only in the owner\'s '
        'private conversation. operation=list returns Notion\'s tools with their input schemas; operation=call runs one tool (such as notion-search, notion-fetch, '
        'notion-create-pages or notion-update-page) with its input. Reads may run right away and changes may wait for the owner to approve the exact call, '
        'as the owner set; the result says which. Nocheh\'s own task list stays the main one: use Notion when the owner asks for Notion.')
    ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
        schema={'name':name,'description':description,'parameters':{'type':'object','properties':{
            'operation':{'type':'string','enum':['list','call']},'tool':{'type':'string','maxLength':128},'input':{'type':'object'}},
            'required':['operation'],'additionalProperties':False}},handler=notion_tool)
    name='nocheh_action_status';description=('Read a proposed action, a Telegram message or a controlled operation, with its state and result in your authorized scope. '
        'Without an id it lists this chat\'s recent Telegram message requests with their destinations and states; read one by its id for its text.')
    ctx.register_tool(name=name,toolset='nocheh_archive',description=description,
        schema={'name':name,'description':description,'parameters':{'type':'object','properties':{'id':{'type':'string'}},'additionalProperties':False}},handler=controlled_status)


OWNER_VIEWS=('conversations','conversation-context','telegram-identities','people','projects','project-assignments','memory-map')


def owner_read(args,**kwargs):
    from urllib.parse import urlencode
    try:
        view=args.get('view')
        if view not in OWNER_VIEWS:raise ValueError('invalid_owner_view')
        query={key:str(args[key]) for key in ('space','q','after') if args.get(key)}
        value=json.dumps(request('/v1/owner/'+view+('?'+urlencode(query) if query else '')),ensure_ascii=False)
        # Bound tool context; the dashboard keeps the complete owner views.
        return value if len(value)<=24000 else json.dumps({'view':view,'excerpt':value[:22000],'truncated':True},ensure_ascii=False)
    except Exception:return json.dumps({'error':'owner_read_unavailable','note':'Available only in the owner private conversation.'})


TASK_FIELDS=('title','notes','status','state','priority','start_on','start_time','due_on','due_time','repeat','parent','scope','group','people','assignees','tags',
    'properties','reminders','blocked_by','related','attachments')


def tasks_tool(args,**kwargs):
    from urllib.error import HTTPError
    from urllib.parse import urlencode
    try:
        action=args.get('action')
        if action=='list':
            query={key:str(args[key]) for key in ('state','when','scope','tag','group','person','status','priority','parent','q','sort','after') if args.get(key) not in (None,'')}
            value=json.dumps(request('/v1/owner/tasks'+('?'+urlencode(query) if query else '')),ensure_ascii=False)
            # Bound tool context; the dashboard keeps the complete lists.
            return value if len(value)<=24000 else json.dumps({'excerpt':value[:22000],'truncated':True,'note':'Narrow the list with filters or after.'},ensure_ascii=False)
        if action=='add':
            body={key:args[key] for key in TASK_FIELDS if key in args}
            return json.dumps(request('/v1/owner/tasks',body),ensure_ascii=False)
        task=str(args.get('id',''))
        if action in ('get','update','comment') and not re.fullmatch(r'[a-f0-9]{64}',task):return json.dumps({'error':'invalid_task_id'})
        if action=='get':
            value=json.dumps(request('/v1/owner/tasks/'+task),ensure_ascii=False)
            return value if len(value)<=24000 else json.dumps({'excerpt':value[:22000],'truncated':True},ensure_ascii=False)
        if action=='update':
            body={key:args[key] for key in ('expected_revision',*TASK_FIELDS,'archived','trashed') if key in args}
            return json.dumps(request('/v1/owner/tasks/'+task,body),ensure_ascii=False)
        if action=='comment':
            value=json.dumps(request('/v1/owner/tasks/'+task+'/comments',{'text':args.get('text','')}),ensure_ascii=False)
            return value if len(value)<=24000 else json.dumps({'id':task,'commented':True},ensure_ascii=False)
        return json.dumps({'error':'invalid_task_action'})
    except HTTPError as error:
        # The broker keeps storage error text private; the status still tells the next step.
        return json.dumps({'error':{400:'invalid_task_request',403:'not_available_in_this_chat',404:'task_not_found',
            409:'task_changed_list_again'}.get(error.code,'tasks_unavailable')})
    except Exception:return json.dumps({'error':'tasks_unavailable'})


def controlled_tool(kind,args):
    try:
        from pathlib import Path
        from .profile_config import inherited_config,read,preferences
        home=Path(os.environ['HERMES_HOME']);config,_=inherited_config(home,read(home/'config.yaml'))
        if (_PROCESS_PREFERENCES or preferences(config))['nocheh_tools.'+kind]!='on':return json.dumps({'error':'tool_disabled_by_owner'})
        return json.dumps(request('/v1/tools/propose',{'kind':kind,'arguments':args}),ensure_ascii=False)
    except Exception:return json.dumps({'error':'controlled_action_unavailable'})


def notion_tool(args,**kwargs):
    from urllib.error import HTTPError
    try:
        from pathlib import Path
        from .profile_config import inherited_config,read,preferences
        home=Path(os.environ['HERMES_HOME']);config,_=inherited_config(home,read(home/'config.yaml'))
        if (_PROCESS_PREFERENCES or preferences(config))['nocheh_tools.mcp']!='on':return json.dumps({'error':'tool_disabled_by_owner'})
        body={'connection':'notion',**({'operation':'list'} if args.get('operation')=='list' else {'tool':args.get('tool'),'input':args.get('input') or {}})}
        proposed=request('/v1/tools/propose',{'kind':'mcp','arguments':body})
        if proposed.get('state')!='approved':return json.dumps(proposed,ensure_ascii=False)
        # A call the owner's setting allows runs now; wait briefly so the answer comes back in this turn.
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            time.sleep(1)
            value=request('/v1/tools/actions/'+proposed['id'])
            if value.get('state') in ('done','failed','rejected','ambiguous'):
                result=json.dumps({key:value.get(key) for key in ('id','state','result','error_code')},ensure_ascii=False)
                return result if len(result)<=24000 else json.dumps({'id':value['id'],'state':value['state'],'excerpt':result[:22000],'truncated':True},ensure_ascii=False)
        return json.dumps({'id':proposed['id'],'state':'running','note':'Still running; read it later with nocheh_action_status.'})
    except HTTPError as error:
        return json.dumps({'error':{400:'invalid_notion_call',403:'notion_only_in_owner_private_chat',409:'notion_is_off_or_changed'}.get(error.code,'notion_unavailable')})
    except Exception:return json.dumps({'error':'notion_unavailable'})


def controlled_status(args,**kwargs):
    import re
    try:
        id=args.get('id') or ''
        if not id:
            # This chat's recent message requests, for a later turn that no longer holds their IDs.
            keys=('id','destination','state','error_code','created_at')
            return json.dumps({'requests':[{key:item.get(key) for key in keys} for item in request('/v1/tools/actions').get('telegram',[])]},ensure_ascii=False)[:24000]
        if not re.fullmatch(r'[a-f0-9]{64}',id):raise ValueError('invalid_action')
        value=request('/v1/tools/actions/'+id)
        # Bound tool context; complete bytes remain in the archive and owner UI.
        result=json.dumps({key:value.get(key) for key in ('id','kind','state','result','result_id','error_code')},ensure_ascii=False)
        return result if len(result)<=24000 else json.dumps({'id':id,'state':value['state'],'result_id':value['result_id'],'excerpt':result[:22000],'truncated':True})
    except Exception:return json.dumps({'error':'controlled_action_unavailable'})


def action_tool(args,**kwargs):
    try:return json.dumps(request('/v1/action-requests',{'destination':args['destination'],'text':args['text']}),ensure_ascii=False)
    except Exception:return json.dumps({'error':'action_request_unavailable'})


def destinations_tool(args,**kwargs):
    try:return json.dumps(request('/v1/telegram/destinations'),ensure_ascii=False)
    except Exception:return json.dumps({'error':'destinations_unavailable','note':'Available only in a group conversation.'})


def recall_tool(args, **kwargs):
    try:
        result=request('/v1/memory/honcho/recall',{'query':args.get('query','')})
        claims=json.loads(base64.urlsafe_b64decode((_PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()).split('.')[1]+'==='))
        if claims.get('scope') is None:
            result['native']=request('/v1/memory/recall',args)
        return json.dumps(result,ensure_ascii=False)
    except Exception:return json.dumps({'error':'owner_memory_unavailable'})
