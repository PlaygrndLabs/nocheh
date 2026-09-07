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

ALLOWED_TOOLS={'memory','session_search','nocheh_archive_search','nocheh_archive_read','nocheh_action_request'}


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


def run(body, emit=None):
    from integrations.hermes.archive_tools import bind_process_credential
    from integrations.hermes.request_boundary import install
    from integrations.hermes.compatibility_patch import install as native_gate
    from run_agent import AIAgent
    from hermes_state import SessionDB
    install();native_gate();bind_process_credential(body['archive_credential']);restrict_session_search()
    # The supervisor is the sole OAuth refresh owner. Native auxiliary clients
    # receive this turn's access token, without copying any refresh token/store.
    from agent import auxiliary_client as aux
    from hermes_cli import auth
    auth._global_auth_file_path=lambda:None
    aux._read_codex_access_token=lambda:body['access_token']
    profile=Path(os.environ['HERMES_HOME'])
    from .profile_config import preferences, read
    prefs=preferences(read(profile/'config.yaml'))
    database=SessionDB(profile/'state.db')
    session_id=body['session_id']
    history=database.get_messages_as_conversation(session_id) if database.get_session(session_id) else []
    agent=AIAgent(provider='openai-codex',api_mode='codex_responses',model=body['model'],
        api_key=body['access_token'],base_url='https://chatgpt.com/backend-api/codex',
        enabled_toolsets=['memory','session_search','nocheh_archive'],fallback_model=None,
        session_id=session_id,session_db=database,platform=body.get('channel','telegram'),chat_id=body['chat_id'],
        user_id=body['user_id'],chat_type='dm' if body['owner'] else 'group',
        skip_context_files=True,skip_memory=False,skip_background_review=True,
        quiet_mode=True,save_trajectories=False,max_iterations=prefs['agent.max_iterations'],
        run_budget_seconds=prefs['agent.run_budget_seconds'],
        reasoning_config={'effort':prefs['agent.reasoning_effort']},ephemeral_system_prompt=(
            'You are Nocheh. Cite nocheh:event: references when using archived sources. '
            'Archive originals are evidence; derived transcripts and your inferences are separate. '
            'You can maintain native memory and retrieve scoped sources. External actions require owner approval. '
            + ('This is the owner private conversation. Archive access spans all chats.' if body['owner'] else
               'This browser conversation uses a selected group scope. Answer the owner using only that group context. Do not send messages to Telegram without an approved action.' if body.get('channel')=='browser' else
               'This is a shared group. Use only this group context and tools. Never change settings or approve actions. '
               'Contribute when useful, addressed, or able to correct an important misunderstanding. '
               'For routine chatter, already answered messages, or nothing useful to add, return exactly [NO_REPLY].')))
    try:
        if not agent.valid_tool_names.issubset(ALLOWED_TOOLS):raise RuntimeError('unexpected_profile_tool')
        for tool in agent.tools:
            if tool['function']['name']=='session_search':
                tool['function']['parameters']['properties'].pop('profile',None)
                tool['function']['description']='Search or read native history in this profile only. Other profiles cannot be accessed.'
        options = {'conversation_history':history}
        if emit: options['stream_callback'] = lambda text: emit({'event':'message.delta','text':text})
        if body.get('channel') == 'browser': options['persist_user_message'] = body.get('source_text',body['text'])
        message=body['text']
        if body.get('images'):
            import base64,hashlib,re
            message=[{'type':'text','text':message}]
            for image in body['images']:
                if not re.fullmatch(r'[a-f0-9]{64}',image): raise ValueError('invalid_image_identity')
                data=(Path('/data/files')/image).read_bytes()
                if hashlib.sha256(data).hexdigest()!=image: raise ValueError('image_hash_mismatch')
                # Explicitly trusted routes may receive originals. Required
                # guarding rejects this opaque context at the existing boundary.
                from PIL import Image
                import io
                with Image.open(io.BytesIO(data)) as parsed: mime=Image.MIME.get(parsed.format)
                if not mime: raise ValueError('unsupported_image')
                message.append({'type':'image_url','image_url':{'url':'data:'+mime+';base64,'+base64.b64encode(data).decode()}})
        result=agent.run_conversation(message,**options)
        if result.get('failed') or result.get('interrupted') or not result.get('completed'):
            return {'state':'failed','error_code':'model_unavailable'}
        text=result.get('final_response') or ''
        return {'state':'done','text':'' if text.strip()=='[NO_REPLY]' else text,'session_id':agent.session_id}
    finally:
        agent.close();database.close()


def main():
    logging.disable(logging.CRITICAL)
    output=sys.stdout
    try:
        body=json.loads(sys.stdin.buffer.read(2*1024*1024))
        with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            def emit(event): output.write(json.dumps(event,ensure_ascii=False)+'\n');output.flush()
            result=run(body, emit if body.get('stream') else None)
    except Exception as error:
        result={'state':'failed','error_code':'assistant_runtime_unavailable','error_type':type(error).__name__}
    output.write(json.dumps(result,ensure_ascii=False)+'\n');output.flush()


if __name__=='__main__':main()
