"""One native Hermes turn per process, with a fixed profile and read capability.

Process isolation avoids profile-global tool caches crossing group boundaries.
The parent owns Telegram and credentials; the child has no shell/network tools.
"""
import contextlib
import io
import json
import logging
import os
import sys
from pathlib import Path

ALLOWED_TOOLS={'memory','session_search','nocheh_archive_search','nocheh_archive_read','nocheh_action_request',
               'nocheh_shell','nocheh_browser','nocheh_mcp','nocheh_action_status','nocheh_memory_recall'}


def restrict_session_search():
    from tools import session_search_tool as search
    original_resolve=search._resolve_profile_db
    original_locate=search._locate_session_db
    def current_only(profile):
        if profile is not None and str(profile).strip():raise ValueError('profile_scope_denied')
        return None
    search._resolve_profile_db=current_only
    search._locate_session_db=lambda *args,**kwargs:(None,None)
    def restore():
        search._resolve_profile_db=original_resolve;search._locate_session_db=original_locate
    return restore


def sealed_dependencies():
    # Managed turns use build-time pinned dependencies. Native OpenAI client
    # construction also imports the optional Bedrock adapter, whose lazy
    # installer otherwise waits on blocked egress on every fresh process.
    os.environ['HERMES_DISABLE_LAZY_INSTALLS']='1'
    os.environ.pop('HERMES_LAZY_INSTALL_TARGET',None)


def run(body, emit=None):
    sealed_dependencies()
    from .timing import record
    from time import perf_counter
    phase=perf_counter()
    # Pinned native imports may initialize session state during module loading.
    # Install the durable path before importing any agent/tool module.
    from .isolated_profile import database_path,install_database_paths
    install_database_paths()
    from integrations.hermes.archive_tools import bind_process_credential
    from integrations.hermes.request_boundary import install
    from integrations.hermes.compatibility_patch import install as native_gate
    from run_agent import AIAgent
    from hermes_state import SessionDB
    install();native_gate();restrict_session_search()
    review = body.get('review') is True
    bind_process_credential(body['archive_credential'])
    from .prepared_context import install as prepare_native, prepare
    prepare_native()
    from .subscription import SubscriptionCredentials
    credentials=SubscriptionCredentials(body['api_key'],body['base_url'],body['provider'],body['api_mode'])
    # Children never receive a refresh store. In shared mode the credential is a
    # client-specific proxy key; CLIProxyAPI alone owns the OAuth login.
    from agent import auxiliary_client as aux
    from hermes_cli import auth
    auth._global_auth_file_path=lambda:None
    aux._read_codex_access_token=lambda:credentials.access_token
    if os.environ.get('NOCHEH_ISOLATED_TURN')=='1':
        from .security_transport import install_isolated_route
        install_isolated_route(credentials,body['model'],body.get('model_context_length'))
    profile=Path(os.environ['HERMES_HOME'])
    from .profile_config import preferences, read
    prefs=body.get('preferences') or preferences(read(profile/'config.yaml'))
    from .archive_tools import bind_process_preferences
    bind_process_preferences(prefs)
    database=SessionDB(database_path(profile))
    record('bootstrap',phase);phase=perf_counter()
    long_term='';memory={}
    if not review:
        from .archive_tools import request
        try: memory=request('/v1/memory/honcho/context',{})
        except Exception: memory={'limited_memory':True,'note':'Long-term memory is limited. Current context, native notes and archive search remain available.'}
        long_term='\nPrimary memory context (derived inferences):\n'+json.dumps(memory,ensure_ascii=False)
    record('memory_recall',phase);phase=perf_counter()
    session_id=body['session_id']
    history=prepare(database.get_messages_as_conversation(session_id)) if database.get_session(session_id) else []
    record('history_prepare',phase);phase=perf_counter()
    from . import memory_evidence
    placement=body.get('memory_context','legacy')
    if placement not in ('legacy','evidence'):raise ValueError('invalid_memory_context')
    restore_evidence=memory_evidence.install(memory if not review else None) if placement=='evidence' else lambda:None
    if placement=='evidence':long_term='\n'+memory_evidence.INSTRUCTION
    agent=AIAgent(provider=credentials.provider,api_mode=credentials.api_mode,model=body['model'],
        api_key=credentials.access_token,base_url=credentials.base_url,
        enabled_toolsets=['memory'] if review else ['memory','session_search','nocheh_archive'],fallback_model=None,
        session_id=session_id,session_db=database,platform=body.get('channel','telegram'),chat_id=body['chat_id'],
        user_id=body['user_id'],chat_type='dm' if body['owner'] else 'group',
        skip_context_files=True,skip_memory=False,skip_background_review=True,
        quiet_mode=True,save_trajectories=False,max_iterations=prefs['agent.max_iterations'],
        run_budget_seconds=prefs['agent.run_budget_seconds'],
        reasoning_config={'effort':prefs['agent.reasoning_effort']},ephemeral_system_prompt=(
            'You are Nocheh. Cite returned nocheh: references when using archived or shared sources. '
            'Archive originals are evidence; derived transcripts and your inferences are separate. '
            'Honcho is your primary long-term memory; native notes are small working notes. '
            'The supplied Honcho context is bounded. Use nocheh_memory_recall when a question needs personal facts, preferences, prior decisions, or relationships missing from that context. '
            'Do not infer that a fact is absent from memory solely because it is absent from the supplied summary. '
            'You can maintain native memory and retrieve scoped sources. External actions require owner approval. '
            'Controlled tools create proposals for an independent executor. An action ID is not evidence of execution. '
            'Check nocheh_action_status for a completed result; pending requests can be reviewed in Nocheh Activity. '
            + ('This is the owner private conversation. Archive access spans all chats. Use nocheh_memory_recall for primary Honcho recall and authorized native profiles.' if body['owner'] else
               'This is a shared space. Use nocheh_memory_recall for this audience. Use only authorized context and tool results, including explicitly shared knowledge. Filtered material is a derived inference, not an original source. Never change settings or approve actions. '
               'Browser conversations address the owner privately; do not send Telegram messages without an approved action. '
               'Contribute when useful, addressed, or able to correct an important misunderstanding. '
               'For routine chatter, already answered messages, or nothing useful to add, return exactly [NO_REPLY].')+long_term))
    record('agent_init',phase)
    try:
        if agent._memory_store is not None:
            agent._memory_store.memory_char_limit=prefs['memory.memory_char_limit']
            agent._memory_store.user_char_limit=prefs['memory.user_char_limit']
        if review:
            from .native_memory import native_review
            return native_review(agent, body['text'])
        if not agent.valid_tool_names.issubset(ALLOWED_TOOLS):raise RuntimeError('unexpected_profile_tool')
        for tool in agent.tools:
            if tool['function']['name']=='session_search':
                tool['function']['parameters']['properties'].pop('profile',None)
                tool['function']['description']='Search or read native history in this profile only. Other profiles cannot be accessed.'
        options = {'conversation_history':history}
        if emit: options['stream_callback'] = lambda text: emit({'event':'message.delta','text':text})
        if body.get('channel') in ('browser','scheduler'): options['persist_user_message'] = body.get('source_text',body['text'])
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
        if result.get('failed') or result.get('interrupted') or not result.get('completed'):
            return {'state':'failed','error_code':'model_unavailable'}
        text=result.get('final_response') or ''
        if text.strip()!='[NO_REPLY]' and memory.get('limited_memory'):
            text+='\n\nMemory is limited; current context, native notes and archive search remain available.'
        return {'state':'done','text':'' if text.strip()=='[NO_REPLY]' else text,'session_id':agent.session_id}
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
        from .native_memory import memory_lock, save_receipt
        with memory_lock(os.environ['HERMES_HOME']), contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            if body.get('review'):
                import re
                if not re.fullmatch(r'[a-f0-9]{64}', body['review_id']): raise ValueError('invalid_review_id')
                receipt=Path(os.environ['HERMES_HOME'])/'reviews'/body['review_id']
                receipt.parent.mkdir(exist_ok=True)
                if receipt.exists(): result={'state':'done' if receipt.read_text()=='done' else 'ambiguous'}
                else:
                    save_receipt(receipt,'running')
                    result=run(body)
                    if result.get('state')=='done':
                        save_receipt(receipt,'done')
            else:
                def emit(event): output.write(json.dumps(event,ensure_ascii=False)+'\n');output.flush()
                result=run(body, emit if body.get('stream') else None)
    except Exception as error:
        import traceback
        frames=traceback.extract_tb(error.__traceback__)
        known={'unexpected_profile_tool','unsupported_memory_compaction_revision','profile_scope_denied','guard_context_changed','required_guard_unavailable','invalid_process_scope_binding'}
        result={'state':'failed','error_code':str(error) if str(error) in known else 'assistant_runtime_unavailable',
                'error_type':type(error).__name__,'error_stage':frames[-1].name if frames else 'bootstrap'}
    record('total',started);result['timings']=safe(VALUES)
    output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()


if __name__=='__main__':main()
