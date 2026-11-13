"""One native Hermes turn per process, with a fixed profile and read capability.

Process isolation avoids profile-global tool caches crossing group boundaries.
The parent owns credentials; the child has no shell/network tools.
"""
import contextlib
import io
import json
import logging
import math
import os
import re
import sys
import time
from pathlib import Path

# Nocheh's data tools come from its MCP endpoint through Hermes's own MCP client, which names each one mcp__nocheh__<tool>.
DATA_TOOLS={'mcp__nocheh__archive_search','mcp__nocheh__archive_read','mcp__nocheh__archive_page','mcp__nocheh__memory_search',
            'mcp__nocheh__memory_recall','mcp__nocheh__action_request','mcp__nocheh__background_job','mcp__nocheh__telegram_destinations',
            'mcp__nocheh__shell','mcp__nocheh__browser','mcp__nocheh__mcp','mcp__nocheh__owner_read','mcp__nocheh__tasks','mcp__nocheh__notion',
            'mcp__nocheh__action_status','mcp__nocheh__knowledge_inspect','mcp__nocheh__knowledge_propose','mcp__nocheh__knowledge_status'}
ALLOWED_TOOLS={'memory','session_search','skills_list','skill_view'}|DATA_TOOLS
# A private answer only reads (ADR-0248): Nocheh offers it these data tools alone, and tasks only lists and reads.
# Native memory is left out too, so it writes no notes.
ANSWER_DATA_TOOLS={'mcp__nocheh__archive_search','mcp__nocheh__archive_read','mcp__nocheh__archive_page','mcp__nocheh__memory_search','mcp__nocheh__tasks'}
ANSWER_TOOLS={'session_search','skills_list','skill_view'}|ANSWER_DATA_TOOLS
ANSWER_TOOLSETS=['session_search','mcp-nocheh','skills']
# The owner sets skills; a turn may read them but never create or change one.
OWNER_SET_TOOLS={'skill_manage'}
TURN_TOOLSETS=['memory','session_search','mcp-nocheh','skills']
# A job's own turns never start, list or stop jobs.
JOB_STRIPPED={'mcp__nocheh__background_job'}
# A background job's run also keeps Hermes's own to-do list.
BACKGROUND_TOOLS=(ALLOWED_TOOLS-JOB_STRIPPED)|{'todo_list'}
BACKGROUND_TOOLSETS=TURN_TOOLSETS+['todo']
# A box run runs Hermes's own terminal, file and code tools in the job's sealed box. It keeps
# the archive tools and Notion, and loses native memory, the shell and the browser.
BOX_STRIPPED={'mcp__nocheh__shell','mcp__nocheh__browser'}
BOX_TOOLS=(BACKGROUND_TOOLS-{'memory'}-BOX_STRIPPED)|{'terminal','process_manage','read_file','write_file','patch','search_files','execute_code'}
BOX_TOOLSETS=[name for name in BACKGROUND_TOOLSETS if name!='memory']+['terminal','file','code_execution']
# A machine run runs Hermes's own terminal and file tools on the owner's machine, through Nocheh (machine_box.py).
# It keeps and loses what a box run does, and has no code_execution.
MACHINE_TOOLS=(BACKGROUND_TOOLS-{'memory'}-BOX_STRIPPED)|{'terminal','process_manage','read_file','write_file','patch','search_files'}
MACHINE_TOOLSETS=[name for name in BACKGROUND_TOOLSETS if name!='memory']+['terminal','file']


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

def turn_tools(background,box,machine=False,answer=False):
    """The tools a turn drops from its profile's toolsets, and the exact set it then runs with."""
    if answer:return OWNER_SET_TOOLS|(ALLOWED_TOOLS-ANSWER_TOOLS),ANSWER_TOOLS
    removed=OWNER_SET_TOOLS|(JOB_STRIPPED if background else set())|(BOX_STRIPPED if box or machine else set())
    return removed,BOX_TOOLS if box else MACHINE_TOOLS if machine else BACKGROUND_TOOLS if background else ALLOWED_TOOLS


def verify_profile_tools(names,allowed=ALLOWED_TOOLS):
    unexpected=set(names)-allowed
    if unexpected:raise UnexpectedProfileTool(unexpected)


def data_tools_server(credential,deadline):
    """Nocheh's MCP endpoint for this turn. It lives in this process's memory only: the turn
    credential never reaches config.yaml, a file or the environment. The endpoint checks every
    call with it, as the routes behind it do."""
    return {'url':os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/mcp',
            'headers':{'Authorization':'Bearer '+credential,'X-Nocheh-Turn-Deadline':str(int(deadline))},
            # A memory recall may wait 615 s for long-term memory and 15 s more for the owner's native notes; the endpoint
            # fits it into the turn's deadline. This also lifts Hermes's 420 s limit on one tool call for these tools.
            'timeout':660,'connect_timeout':15,
            # The preflight probe would go through the guarded plain HTTP client, which refuses it.
            'skip_preflight':True,'strict_redirect_headers':True,'trust':'full',
            'sampling':{'enabled':False},'elicitation':{'enabled':False},'events':False,
            'supports_parallel_tool_calls':False,'tools':{'resources':False,'prompts':False}}


def connect_data_tools(credential,deadline,required=DATA_TOOLS):
    """Connect Nocheh's data tools for this turn; a turn without all of them does not run. A private answer needs
    only its read tools, the only ones Nocheh offers it."""
    from tools.mcp_tool_discovery import register_mcp_servers
    if not required<=set(register_mcp_servers({'nocheh':data_tools_server(credential,deadline)})):
        raise RuntimeError('data_tools_unavailable')


def disconnect_data_tools():
    """Close the turn's MCP connection and stop Hermes's MCP loop, so the process ends with its turn."""
    if 'tools.mcp_tool' not in sys.modules:return
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    shutdown_mcp_servers(timeout=5)


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


def untitled_telegram():
    """Hermes titles a session after its first message. A Telegram session holds a whole chat, so
    Nocheh names it after the chat once the turn ends (assistant_gateway.title_session)."""
    from agent import turn_context
    turn_context._UNTITLED_PLATFORMS=turn_context._UNTITLED_PLATFORMS|{'telegram'}


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


def conversation_result(result, session_id):
    """Only explicit native completion with an answer or silence marker succeeds.
    The reply is the agent's own text: memory status reaches the agent as context, never as added reply text (ADR-0221)."""
    if (not isinstance(result,dict) or result.get('completed') is not True
            or result.get('failed') or result.get('interrupted')):
        return {'state':'failed','error_code':'model_unavailable'}
    text=result.get('final_response')
    if not isinstance(text,str) or not text.strip():
        return {'state':'failed','error_code':'model_unavailable'}
    if text.strip()=='[NO_REPLY]':
        text=''
    return {'state':'done','text':text,'session_id':session_id}


def reasoning(credentials,prefs):
    """Thinking settings for the turn. On Anthropic's OpenAI-compatible route Hermes sent no
    effort setting, so the model ran with the endpoint's default. On its Messages API Hermes
    would send the preference, so Anthropic turns send none and keep the API's default."""
    return None if credentials.api_mode=='anthropic_messages' else {'effort':prefs['agent.reasoning_effort']}


def background_limits(body):
    """How many tool and thinking steps a background job's run may take: Hermes's backstop, since its time limit ends it first."""
    limits=body.get('background')
    iterations,soft=(limits.get('max_iterations'),limits.get('soft_deadline')) if isinstance(limits,dict) else (None,None)
    if type(iterations) is not int or not 1<=iterations<=1000 or type(soft) not in (int,float) or not math.isfinite(soft):
        raise ValueError('invalid_background_run')
    return iterations


def run_budget(body):
    """A job run's seconds until the job's soft deadline: Hermes asks for the report at 80% of them; Nocheh stops the run 3 minutes after the end."""
    return max(30,int(body['background']['soft_deadline']-time.time()))


def box_step(body):
    """Whether this turn is a job run in its sealed box. The run and the launcher's environment
    must agree in both directions; anything else stops before the agent runs."""
    limits=body.get('background')
    box=limits.get('box',False) if body.get('channel')=='background' and body.get('review') is not True and isinstance(limits,dict) else False
    if type(box) is not bool:raise ValueError('invalid_background_run')
    socket,backend=bool(os.environ.get('NOCHEH_BOX_SOCKET')),os.environ.get('TERMINAL_ENV')=='nocheh_box'
    if (not (os.environ.get('NOCHEH_ISOLATED_TURN')=='1' and socket and backend)) if box else (socket or backend):
        raise ValueError('job_box_unavailable')
    return box


def machine_step(body):
    """Whether this turn is a job run on the owner's machine. As for the box, the run and the launcher's environment
    must agree in both directions, and a run is never both; anything else stops before the agent runs."""
    limits=body.get('background')
    run=body.get('channel')=='background' and body.get('review') is not True and isinstance(limits,dict)
    machine=limits.get('machine',False) if run else False
    if type(machine) is not bool:raise ValueError('invalid_background_run')
    on,backend=os.environ.get('NOCHEH_MACHINE_RUN')=='1',os.environ.get('TERMINAL_ENV')=='nocheh_machine'
    if (machine and limits.get('box') is True) or ((not (os.environ.get('NOCHEH_ISOLATED_TURN')=='1' and on and backend)) if machine else (on or backend)):
        raise ValueError('job_machine_unavailable')
    return machine


def job_result(result, session_id):
    """A background job's run: its final answer is the report. The summary Hermes asks for when the run's
    iterations run out is a report too; a run that failed or was interrupted wrote none."""
    if not isinstance(result,dict) or result.get('failed') or result.get('interrupted'):
        return {'state':'failed','error_code':'model_unavailable'}
    reason=str(result.get('turn_exit_reason') or '')
    text=result.get('final_response')
    text=text if isinstance(text,str) else ''
    if text.strip()=='[NO_REPLY]':text=''
    if not text.strip() or not (result.get('completed') is True or reason.startswith('max_iterations_reached') or reason=='budget_exhausted'):
        return {'state':'failed','error_code':'model_unavailable'}
    return {'state':'done','text':text,'session_id':session_id}


def run(body, emit=None, relay=None):
    machine=machine_step(body);box=box_step(body)
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
    install();native_gate();restrict_session_search();untitled_telegram()
    review = body.get('review') is True
    background = body.get('channel')=='background' and not review
    # A private answer (ADR-0248): never the owner, only in a Telegram turn, never a review or a job.
    answer = body.get('private_answer') is True
    if answer and (body['owner'] or review or body.get('channel','telegram')!='telegram'):raise ValueError('invalid_private_answer')
    iterations = background_limits(body) if background else None
    bind_process_credential(body['archive_credential'])
    if body.get('review') is not True:bind_process_deadline(body['turn_deadline_epoch'],background=background)
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
    database=SessionDB(database_path(profile))
    record('bootstrap',phase);phase=perf_counter()
    from .prompts import reply, text
    prompt=lambda key:text(body.get('prompts'),key)
    long_term='';memory={}
    if not review:
        from .archive_tools import request
        try: memory=request('/v1/memory/longterm/context',{})
        except Exception: memory={'limited_memory':True,'note':prompt('memory.limited')}
        long_term='\nPrimary memory context (derived inferences):\n'+json.dumps(memory,ensure_ascii=False)
    record('memory_recall',phase);phase=perf_counter()
    session_id=body['session_id']
    history=prepare(database.get_messages_as_conversation(session_id)) if database.get_session(session_id) else []
    record('history_prepare',phase);phase=perf_counter()
    from . import memory_evidence
    placement=body.get('memory_context','legacy')
    if placement not in ('legacy','evidence'):raise ValueError('invalid_memory_context')
    restore_evidence=memory_evidence.install(memory if not review else None) if placement=='evidence' else lambda:None
    if placement=='evidence':long_term='\n'+prompt('memory.evidence')
    if background:
        # Each model call of the run, and its to-do list, go out as progress lines; the cost notice comes from them too.
        from services.hermes import job_progress
        job_progress.bind(relay or (lambda event:None),body['background'])
    try:
        # Nocheh's data tools, from its MCP endpoint with this turn's credential; a review only keeps native notes.
        if not review:connect_data_tools(body['archive_credential'],body['turn_deadline_epoch'],ANSWER_DATA_TOOLS if answer else DATA_TOOLS)
        agent=AIAgent(provider=credentials.provider,api_mode=credentials.api_mode,model=body['model'],
            api_key=credentials.access_token,base_url=credentials.base_url,
            enabled_toolsets=['memory'] if review else ANSWER_TOOLSETS if answer else BOX_TOOLSETS if box else MACHINE_TOOLSETS if machine else BACKGROUND_TOOLSETS if background else TURN_TOOLSETS,
            fallback_model=None,
            session_id=session_id,session_db=database,platform=body.get('channel','telegram'),chat_id=body['chat_id'],
            user_id=body['user_id'],chat_type='dm' if body['owner'] or answer else 'group',
            skip_context_files=True,load_soul_identity=not review,skip_memory=False,skip_background_review=True,
            quiet_mode=True,save_trajectories=False,max_iterations=iterations or prefs['agent.max_iterations'],
            # A job run's budget ends at the job's soft deadline; Hermes's own notice at 80% of it asks for the report.
            run_budget_seconds=run_budget(body) if background else prefs['agent.run_budget_seconds'],
            reasoning_config=reasoning(credentials,prefs),ephemeral_system_prompt=(
                reply(body.get('prompts'),body['owner'],answer)+long_term))
    except BaseException:
        disconnect_data_tools();raise
    # The turn's tools are set below; Hermes's refresh at the start of a turn would bring back a tool the turn dropped.
    agent._skip_mcp_refresh=True
    record('agent_init',phase)
    try:
        if agent._memory_store is not None:
            agent._memory_store.memory_char_limit=prefs['memory.memory_char_limit']
            agent._memory_store.user_char_limit=prefs['memory.user_char_limit']
        memory_evidence.collect(agent)
        if review:
            from .native_memory import native_review
            return native_review(agent, body['text'], RUNS, prompt('memory.notes_review'))
        removed,allowed=turn_tools(background,box,machine,answer)
        agent.tools=[tool for tool in agent.tools if tool['function']['name'] not in removed]
        agent.valid_tool_names=set(agent.valid_tool_names)-removed
        verify_profile_tools(agent.valid_tool_names,allowed)
        if box or machine:
            # The box or machine tools must all be there, on that backend; the hook then lets only this run's tools
            # run, and none of their commands outlives the run.
            from services.hermes import job_box
            job_box.seal(agent.valid_tool_names,body['turn_deadline_epoch'])
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
        if background:
            job_progress.finish(result)
            return job_result(result,agent.session_id)
        return conversation_result(result,agent.session_id)
    finally:
        agent.close()
        if review:
            # A memory review leaves an empty native session behind; Hermes's own hidden flag keeps it out of the session list.
            with contextlib.suppress(Exception):database.set_session_hidden(session_id,True)
        database.close();restore_evidence();disconnect_data_tools()


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
                    # A job run sends a line now and then, even during a long model call, so the bridge does not take silence for a lost turn.
                    while not finished.wait(20):emit({'event':'heartbeat'})
                if body.get('heartbeat') is True:threading.Thread(target=heartbeat,daemon=True).start()
                try:result=run(body, emit if body.get('stream') else None, emit if body.get('channel')=='background' else None)
                finally:finished.set()
    except Exception as error:
        import traceback
        frames=traceback.extract_tb(error.__traceback__)
        known={'unexpected_profile_tool','unsupported_memory_compaction_revision','profile_scope_denied','guard_context_changed','guard_transition_pending','audience_context_changed','runtime_turn_changed','required_guard_unavailable','invalid_process_scope_binding','job_box_unavailable','job_machine_unavailable','data_tools_unavailable'}
        result={'state':'failed','error_code':str(error) if str(error) in known else 'assistant_runtime_unavailable',
                'error_type':type(error).__name__,'error_stage':frames[-1].name if frames else 'bootstrap'}
        if isinstance(error,UnexpectedProfileTool):result['unexpected_tool_names']=error.names
    record('total',started);result['timings']=safe(VALUES)
    from .usage import combine,failure,nocheh_failure
    from .request_boundary import model_refusals
    measured=combine(RUNS)
    if measured:result['usage']=measured
    # Why it failed, as codes for the usage tracker: a run's own reason and the provider's exact error, or the code of
    # Nocheh's own refusal, such as its secret check's; else Nocheh's error.
    if result.get('state')!='done':
        result['failure_reason'],cause=failure(RUNS,model_refusals()) if RUNS else nocheh_failure(result.get('error_code'))
        if cause:result['failure_cause']=cause
    output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()


if __name__=='__main__':main()
