"""One native Hermes turn per process, with a fixed profile and read capability.

Process isolation avoids profile-global tool caches crossing group boundaries.
The parent owns Telegram and credentials; the child has no shell/network tools.
"""
import contextlib
import io
import json
import logging
import os
import re
import sys
from pathlib import Path

ALLOWED_TOOLS={'memory','session_search','nocheh_archive_search','nocheh_archive_read','nocheh_archive_page','nocheh_memory_search','nocheh_action_request',
               'nocheh_shell','nocheh_browser','nocheh_mcp','nocheh_action_status','nocheh_memory_recall',
               'nocheh_knowledge_inspect','nocheh_knowledge_propose','nocheh_knowledge_status','nocheh_owner_read','nocheh_telegram_destinations','nocheh_tasks','nocheh_notion',
               'nocheh_background_job','skills_list','skill_view'}
# The owner sets skills; a turn may read them but never create or change one.
OWNER_SET_TOOLS={'skill_manage'}
TURN_TOOLSETS=['memory','session_search','nocheh_archive','skills']
# A background job's steps also keep Hermes's own to-do list, restored from the job's history each step.
BACKGROUND_TOOLS=ALLOWED_TOOLS|{'todo_list'}
BACKGROUND_TOOLSETS=TURN_TOOLSETS+['todo']


class UnexpectedProfileTool(RuntimeError):
    def __init__(self,names):
        super().__init__('unexpected_profile_tool')
        # Tool identifiers are configuration metadata, not model or chat content.
        self.names=sorted(name for name in names if isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}',name))[:16]



def bind_profile_home(profile):
    """Make Hermes read SOUL.md and skills/ from the turn profile.

    Without a bound home Hermes takes the session database's folder as the
    agent home, and Nocheh keeps that database in ``native-state/``.
    """
    from hermes_constants import set_hermes_home_override
    set_hermes_home_override(profile)

def verify_profile_tools(names,allowed=ALLOWED_TOOLS):
    unexpected=set(names)-allowed
    if unexpected:raise UnexpectedProfileTool(unexpected)


def exact_predecessor_question(text):
    """Do not infer an exact predecessor from a history that can omit sources."""
    if not isinstance(text,str):return False
    normalized=' '.join(text.casefold().split())
    asks_about_message=bool(re.search(r'\b(ask(?:ed)?|said|sent|message|question)\b',normalized))
    asks_for_order=bool(re.search(r'\b(immediately|right|directly) before (?:this|my|the current) (?:message|question)\b',normalized))
    return asks_about_message and asks_for_order


PREDECESSOR_UNVERIFIED='I cannot verify which message you sent immediately before this one from the history available to me.'


def retired_content_question(text):
    """A current question is never evidence of a retired message's contents."""
    if not isinstance(text,str):return False
    normalized=' '.join(text.casefold().split())
    if not re.search(r'\bretir(?:e|ed|ing|ement)\b',normalized):return False
    if not re.search(r'\b(?:message|question|text)\b',normalized):return False
    if re.search(r'\b(?:how|where) (?:do|can|to) (?:i |we )?retir',normalized):return False
    return bool(re.search(r'\b(?:what|which|summari[sz]e|describe|quote|repeat|recall|remind)\b',normalized)
                and re.search(r'\b(?:about|said|say|contain|content|text|ask(?:ed)?|wrote|write|quote|repeat|summari[sz]e|describe)\b',normalized))


RETIRED_CONTENT_UNAVAILABLE="I can't access the retired message's content, so I can't tell what it was about."


def restrict_session_search():
    # Native reads stay in the caller's own store; only a named profile opens another.
    from tools import session_search_tool as search
    original_resolve=search._resolve_profile_db
    def current_only(profile):
        if profile is not None and str(profile).strip():raise ValueError('profile_scope_denied')
        return None
    search._resolve_profile_db=current_only
    def restore():
        search._resolve_profile_db=original_resolve
    return restore


def sealed_dependencies():
    # Managed turns use build-time pinned dependencies. Native OpenAI client
    # construction also imports the optional Bedrock adapter, whose lazy
    # installer otherwise waits on blocked egress on every fresh process.
    os.environ['HERMES_DISABLE_LAZY_INSTALLS']='1'
    os.environ.pop('HERMES_LAZY_INSTALL_TARGET',None)


def install_tool_search_policy():
    """Pin the isolated turn's tool surface even if native config loading falls back.

    Hermes treats an unreadable tool-search setting as ``auto``. That adds the
    bridge tools to a restricted Nocheh turn, so the allowlist rejects the turn.
    The saved profile still records the policy; this pins it in the process too.
    """
    from tools import tool_search
    previous=(tool_search.load_config,tool_search.load_config_readonly)
    disabled=tool_search.ToolSearchConfig.from_raw({'enabled':'off'})
    tool_search.load_config=lambda:disabled
    tool_search.load_config_readonly=lambda:disabled
    def restore():
        tool_search.load_config,tool_search.load_config_readonly=previous
    return restore


# Hermes run results of this process, for Nocheh's usage tracker (token counts and cost, no content).
RUNS=[]


def conversation_result(result, session_id, limited_memory=False):
    """Only explicit native completion with an answer or silence marker succeeds."""
    if (not isinstance(result,dict) or result.get('completed') is not True
            or result.get('failed') or result.get('interrupted')):
        return {'state':'failed','error_code':'model_unavailable'}
    text=result.get('final_response')
    if not isinstance(text,str) or not text.strip():
        return {'state':'failed','error_code':'model_unavailable'}
    if text.strip()=='[NO_REPLY]':
        text=''
    elif limited_memory:
        text+='\n\nMemory is limited; current context, native notes and archive search remain available.'
    return {'state':'done','text':text,'session_id':session_id}


def background_limits(body):
    """How many tool and thinking steps one step of a background job may take."""
    limits=body.get('background')
    iterations=limits.get('max_iterations') if isinstance(limits,dict) else None
    if type(iterations) is not int or not 1<=iterations<=60:raise ValueError('invalid_background_step')
    return iterations


def todo_snapshot(agent):
    """The job's to-do list after a step, bounded, for the job list."""
    store=getattr(agent,'_todo_store',None)
    try:items=store.read() if store is not None else []
    except Exception:return []
    return [{'content':str(item.get('content',''))[:200],'status':str(item.get('status',''))[:20]}
            for item in items[:50] if isinstance(item,dict)]


def step_result(result, session_id, todo):
    """A background job step. An answer that ends on its own ends the job; a step
    stopped at its step limit leaves Hermes's progress summary and continues next step."""
    if not isinstance(result,dict) or result.get('failed') or result.get('interrupted'):
        return {'state':'failed','error_code':'model_unavailable'}
    reason=str(result.get('turn_exit_reason') or '')
    limited=reason.startswith('max_iterations_reached') or reason=='budget_exhausted'
    text=result.get('final_response')
    text=text if isinstance(text,str) else ''
    if text.strip()=='[NO_REPLY]':text=''
    if not limited and (result.get('completed') is not True or not text.strip()):
        return {'state':'failed','error_code':'model_unavailable'}
    return {'state':'done','text':text,'session_id':session_id,'continue':limited,'todo':todo}


def run(body, emit=None):
    if body.get('review') is not True and exact_predecessor_question(body.get('source_text',body.get('text',''))):
        return {'state':'done','text':PREDECESSOR_UNVERIFIED,'session_id':body['session_id']}
    if body.get('review') is not True and retired_content_question(body.get('source_text',body.get('text',''))):
        return {'state':'done','text':RETIRED_CONTENT_UNAVAILABLE,'session_id':body['session_id']}
    sealed_dependencies()
    from .timing import record
    from time import perf_counter
    phase=perf_counter()
    # Pinned native imports may initialize session state during module loading.
    # Install the durable path before importing any agent/tool module.
    from .isolated_profile import database_path,install_database_paths
    install_database_paths()
    install_tool_search_policy()
    from services.hermes.archive_tools import bind_process_credential,bind_process_deadline
    from services.hermes.request_boundary import install
    from services.hermes.compatibility_patch import install as native_gate
    from run_agent import AIAgent
    from hermes_state import SessionDB
    install();native_gate();restrict_session_search()
    review = body.get('review') is True
    background = body.get('channel')=='background' and not review
    iterations = background_limits(body) if background else None
    bind_process_credential(body['archive_credential'])
    if body.get('review') is not True:bind_process_deadline(body['turn_deadline_epoch'])
    from .prepared_context import install as prepare_native, prepare
    prepare_native()
    from .subscription import SubscriptionCredentials
    credentials=SubscriptionCredentials(body['api_key'],body['base_url'],body['provider'],body['api_mode'])
    # Children never receive a credential store: the only key is the configured
    # provider's (or, when isolated, a scoped broker capability).
    from hermes_cli import auth
    auth._global_auth_file_path=lambda:None
    if os.environ.get('NOCHEH_ISOLATED_TURN')=='1':
        from .security_transport import install_isolated_route
        install_isolated_route(credentials,body['model'],body.get('model_context_length'))
    profile=Path(os.environ['HERMES_HOME'])
    bind_profile_home(profile)
    from .profile_config import preferences, read
    prefs=body.get('preferences') or preferences(read(profile/'config.yaml'))
    from .archive_tools import bind_process_preferences
    bind_process_preferences(prefs)
    database=SessionDB(database_path(profile))
    record('bootstrap',phase);phase=perf_counter()
    from .prompts import reply, text
    prompt=lambda key:text(body.get('prompts'),key)
    long_term='';memory={}
    if not review:
        from .archive_tools import request
        try: memory=request('/v1/memory/honcho/context',{})
        except Exception: memory={'limited_memory':True,'note':prompt('memory.limited')}
        long_term='\nPrimary memory context (derived inferences):\n'+json.dumps(memory,ensure_ascii=False)
    record('memory_recall',phase);phase=perf_counter()
    session_id=body['session_id']
    if not review:
        from .persona import refresh_prompt
        refresh_prompt(profile,database,session_id)
    history=prepare(database.get_messages_as_conversation(session_id)) if database.get_session(session_id) else []
    record('history_prepare',phase);phase=perf_counter()
    from . import memory_evidence
    placement=body.get('memory_context','legacy')
    if placement not in ('legacy','evidence'):raise ValueError('invalid_memory_context')
    restore_evidence=memory_evidence.install(memory if not review else None) if placement=='evidence' else lambda:None
    if placement=='evidence':long_term='\n'+prompt('memory.evidence')
    agent=AIAgent(provider=credentials.provider,api_mode=credentials.api_mode,model=body['model'],
        api_key=credentials.access_token,base_url=credentials.base_url,
        enabled_toolsets=['memory'] if review else BACKGROUND_TOOLSETS if background else TURN_TOOLSETS,fallback_model=None,
        session_id=session_id,session_db=database,platform=body.get('channel','telegram'),chat_id=body['chat_id'],
        user_id=body['user_id'],chat_type='dm' if body['owner'] else 'group',
        skip_context_files=True,load_soul_identity=not review,skip_memory=False,skip_background_review=True,
        quiet_mode=True,save_trajectories=False,max_iterations=iterations or prefs['agent.max_iterations'],
        # A job step is bounded by its step count and Nocheh's step time, not by a wrap-up notice
        # that would ask for the final answer before the job is done.
        run_budget_seconds=None if background else prefs['agent.run_budget_seconds'],
        reasoning_config={'effort':prefs['agent.reasoning_effort']},ephemeral_system_prompt=(
            reply(body.get('prompts'),body['owner'])+long_term))
    record('agent_init',phase)
    try:
        if agent._memory_store is not None:
            agent._memory_store.memory_char_limit=prefs['memory.memory_char_limit']
            agent._memory_store.user_char_limit=prefs['memory.user_char_limit']
        if review:
            from .native_memory import native_review
            return native_review(agent, body['text'], RUNS, prompt('memory.notes_review'))
        agent.tools=[tool for tool in agent.tools if tool['function']['name'] not in OWNER_SET_TOOLS]
        agent.valid_tool_names=set(agent.valid_tool_names)-OWNER_SET_TOOLS
        verify_profile_tools(agent.valid_tool_names,BACKGROUND_TOOLS if background else ALLOWED_TOOLS)
        for tool in agent.tools:
            if tool['function']['name']=='session_search':
                tool['function']['parameters']['properties'].pop('profile',None)
                tool['function']['description']='Search or read native history in this profile only. Other profiles cannot be accessed.'
        options = {'conversation_history':history}
        if emit: options['stream_callback'] = lambda text: emit({'event':'message.delta','text':text})
        if body.get('channel') in ('browser','scheduler','background'): options['persist_user_message'] = body.get('source_text',body['text'])
        message=body['text']
        if body.get('images'):
            import base64,hashlib,re
            message=[{'type':'text','text':message}]
            for image in body['images']:
                if not re.fullmatch(r'[a-f0-9]{64}',image): raise ValueError('invalid_image_identity')
                if os.environ.get('NOCHEH_ISOLATED_TURN')=='1':
                    from urllib.request import Request,urlopen
                    req=Request('http://nocheh-security:8786/v1/turn-files/'+image,headers={'Authorization':'Bearer '+body['archive_credential']})
                    with urlopen(req,timeout=30) as response:data=response.read(26*1024*1024)
                else:data=(Path('/data/files')/image).read_bytes()
                if hashlib.sha256(data).hexdigest()!=image: raise ValueError('image_hash_mismatch')
                # Explicitly trusted routes may receive originals. Required
                # guarding rejects this opaque context at the existing boundary.
                from PIL import Image
                import io
                with Image.open(io.BytesIO(data)) as parsed: mime=Image.MIME.get(parsed.format)
                if not mime: raise ValueError('unsupported_image')
                message.append({'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+base64.b64encode(data).decode()}})
        from .timing import measure
        with measure('conversation'):result=agent.run_conversation(message,**options)
        RUNS.append(result)
        if background:return step_result(result,agent.session_id,todo_snapshot(agent))
        return conversation_result(result,agent.session_id,memory.get('limited_memory',False))
    finally:
        agent.close();database.close();restore_evidence()


def main():
    logging.disable(logging.CRITICAL)
    output=sys.stdout
    from .timing import reset,record,safe,VALUES
    from time import perf_counter
    reset();started=perf_counter()
    try:
        body=json.loads(sys.stdin.buffer.read(2*1024*1024))
        if os.environ.get('NOCHEH_ISOLATED_TURN')=='1':
            profile=Path(os.environ['HERMES_HOME'])
            (profile/'plugins').mkdir(exist_ok=True)
            (profile/'plugins'/'nocheh').symlink_to(Path(__file__).resolve().parent,target_is_directory=True)
        from .native_memory import memory_lock, notes_snapshot, save_receipt
        with memory_lock(os.environ['HERMES_HOME'], reclaim_native=os.environ.get('NOCHEH_ISOLATED_TURN')=='1'), contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            if body.get('review'):
                import re
                if not re.fullmatch(r'[a-f0-9]{64}', body['review_id']): raise ValueError('invalid_review_id')
                home=Path(os.environ['HERMES_HOME']);receipt=home/'reviews'/body['review_id']
                receipt.parent.mkdir(exist_ok=True)
                # A review that ended without changing the notes left no effect, so it may run again.
                if receipt.exists() and receipt.read_text()!='failed': result={'state':'done' if receipt.read_text()=='done' else 'ambiguous'}
                else:
                    before=notes_snapshot(home)
                    save_receipt(receipt,'running')
                    try:result=run(body)
                    except Exception:
                        if notes_snapshot(home)==before:save_receipt(receipt,'failed')
                        raise
                    if result.get('state')=='done':
                        save_receipt(receipt,'done')
                    elif notes_snapshot(home)==before:
                        save_receipt(receipt,'failed')
            else:
                import threading
                lock=threading.Lock();finished=threading.Event()
                def emit(event):
                    with lock:output.write(json.dumps(event,ensure_ascii=False)+'\n');output.flush()
                def heartbeat():
                    # A long job step sends a line now and then so the bridge does not take silence for a lost turn.
                    while not finished.wait(20):emit({'event':'heartbeat'})
                if body.get('heartbeat') is True:threading.Thread(target=heartbeat,daemon=True).start()
                try:result=run(body, emit if body.get('stream') else None)
                finally:finished.set()
    except Exception as error:
        import traceback
        frames=traceback.extract_tb(error.__traceback__)
        known={'unexpected_profile_tool','unsupported_memory_compaction_revision','profile_scope_denied','guard_context_changed','required_guard_unavailable','invalid_process_scope_binding'}
        result={'state':'failed','error_code':str(error) if str(error) in known else 'assistant_runtime_unavailable',
                'error_type':type(error).__name__,'error_stage':frames[-1].name if frames else 'bootstrap'}
        if isinstance(error,UnexpectedProfileTool):result['unexpected_tool_names']=error.names
    record('total',started);result['timings']=safe(VALUES)
    from .usage import combine,failure_reason
    measured=combine(RUNS)
    if measured:result['usage']=measured
    # Why it failed, as a code for the usage tracker: a run's own reason, else Nocheh's error.
    if result.get('state')!='done':result['failure_reason']=failure_reason(RUNS) if RUNS else 'nocheh_error'
    output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()


if __name__=='__main__':main()
