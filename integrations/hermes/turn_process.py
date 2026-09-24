"""Common isolated Hermes turn bootstrap for Telegram and browser transports."""
import asyncio
import fcntl
import json
import os
import signal
import sys
from pathlib import Path
from .capture import canonical


def scheduled_preferences(profile,body):
    from .profile_config import inherited_config,read,preferences
    from .policy_config import validate
    config,_=inherited_config(profile,read(profile/'config.yaml'),job=body['job_id'])
    values=preferences(config);overrides=body.get('job_preferences',{});validate(overrides)
    values.update({key:value for key,value in overrides.items() if value is not None})
    return values


async def run_process(root, scope, body, model, credentials, session_id, emit=None, cancelled=None, prepared_profile=None):
    from .assistant_gateway import prepare_profile
    from .scopes import Scopes
    import base64
    claims=json.loads(base64.urlsafe_b64decode(body['archive_credential'].split('.')[1]+'==='))
    scope=Scopes.apply_revision(scope,claims)
    if prepared_profile is not None and Path(prepared_profile).name != scope.profile:
        raise ValueError('prepared_profile_scope_mismatch')
    profile = prepared_profile if prepared_profile is not None else await asyncio.to_thread(prepare_profile, root, scope, model)
    await asyncio.to_thread((profile/'.foreground').touch)
    with (profile / '.turn.lock').open('a') as lock:
        # Wait before starting a child, keeping the same execution identity.
        # Reviews use this lock too. Cancellation and policy changes remain live.
        while True:
            if cancelled and cancelled.is_set():
                return {'state':'cancelled','text':'','session_id':session_id}
            from .assistant_gateway import check_delivery_policy
            if not await asyncio.to_thread(check_delivery_policy,body['archive_credential']):
                return {'state':'failed','error_code':'space_policy_changed','text':'','session_id':session_id}
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                await asyncio.sleep(.25)
        try:
            return await _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled)
        finally:
            await asyncio.to_thread((profile/'.foreground').touch)


async def _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled):
    if cancelled and cancelled.is_set(): return {'state':'cancelled','text':'','session_id':session_id}
    text = body.get('text') or ''
    if body.get('transcripts'):
        text += '\n\n[Derived voice transcript; original audio is separately archived]\n' + '\n'.join(body['transcripts'])
    if not text: text = '[An attachment or non-text event was archived. Use its source reference if useful.]'
    for file in body.get('files',[]):
        text += '\n\n[Archived attachment: ' + file['name'] + '; SHA-256: ' + file['sha256'] + ']'
        if file.get('text') is not None: text += '\n' + file['text']
        elif file['kind']=='file': text += '\n[Binary file retained; text extraction is unavailable.]'
    # Retrieval uses the conversation content. The per-execution source hash
    # belongs in agent provenance, not in the semantic memory query/cache key.
    memory_query=text[:2000]
    text += '\n\n[Archive source: nocheh:event:' + body['event_id'] + ']'
    transport = credentials.runtime() if hasattr(credentials, 'runtime') else {
        'api_key': credentials.access_token, 'base_url': 'https://chatgpt.com/backend-api/codex',
        'provider': 'openai-codex', 'api_mode': 'codex_responses'}
    request = {'text':text, 'source_text':body.get('text') or '', 'channel':body.get('channel','telegram'),
               'model':model, 'memory_query':memory_query, 'session_id':session_id, 'owner':scope.owner, 'chat_id':scope.chat_id,
               'user_id':scope.user_id, 'archive_credential':body['archive_credential'],
               **transport, 'stream':emit is not None,
               'memory_context':os.environ.get('NOCHEH_MEMORY_CONTEXT','legacy'),
               'images':[file['sha256'] for file in body.get('files',[]) if file['kind']=='image']}
    if body.get('channel')=='scheduler':
        request['preferences']=scheduled_preferences(profile,body)
    from .security_transport import isolated_enabled,scoped_transport
    isolated=isolated_enabled()
    if isolated:
        from .isolated_profile import prepare
        from .profile_config import inherited_config,read,preferences
        prepare(profile)
        request.update(scoped_transport(body['archive_credential'],transport['api_mode']))
        if 'preferences' not in request:
            effective,_=inherited_config(profile,read(profile/'config.yaml'))
            request['preferences']=preferences(effective)
    env = {key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','PYTHONPATH','LD_LIBRARY_PATH',
           'ARCHIVE_URL','GUARD_URL','GUARD_TRUSTED_ENDPOINTS','NOCHEH_REASONING_ROUTE') if key in os.environ}
    env.update(HERMES_HOME=str(profile), NOCHEH_CAPTURE_ENABLED='0',GUARD_MODE=body.get('guard_mode','on'))
    if isolated:
        from .environment import secret
        # This short-lived bridge is trusted parent infrastructure, not the model process.
        env['SERVICE_TOKEN']=secret('SERVICE_TOKEN')
    module='integrations.hermes.security_client' if isolated else 'integrations.hermes.assistant_turn'
    process = await asyncio.create_subprocess_exec(sys.executable, '-m', module,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=env, cwd=Path(__file__).resolve().parents[2], limit=2*1024*1024)
    async def stop_when_cancelled():
        while process.returncode is None:
            if cancelled and cancelled.is_set():
                process.send_signal(signal.SIGINT)
                try: await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError: process.kill()
                return
            await asyncio.sleep(.1)
    watcher = asyncio.create_task(stop_when_cancelled())
    async def collect():
        process.stdin.write(canonical(request));await process.stdin.drain();process.stdin.close()
        result = None;size = 0
        async for line in process.stdout:
            size += len(line)
            if size > 8*1024*1024: raise RuntimeError('assistant_output_limit')
            value = json.loads(line)
            if isinstance(value,dict) and value.get('event') == 'message.delta' and emit:
                from .assistant_gateway import check_delivery_policy
                if not await asyncio.to_thread(check_delivery_policy,body['archive_credential']):raise RuntimeError('guard_context_changed')
                if isinstance(value.get('text'),str): emit(value['text'])
            elif isinstance(value,dict) and value.get('state') in ('done','failed'):
                result = value
            else: raise RuntimeError('assistant_output_invalid')
        await process.wait()
        if cancelled and cancelled.is_set(): return {'state':'cancelled','text':'','session_id':session_id}
        if process.returncode or result is None: raise RuntimeError('assistant_process_failed')
        from .assistant_gateway import check_delivery_policy
        if not await asyncio.to_thread(check_delivery_policy,body['archive_credential']):raise RuntimeError('guard_context_changed')
        return result
    try: return await asyncio.wait_for(collect(), timeout=230)
    finally:
        watcher.cancel()
        if process.returncode is None: process.kill();await process.wait()
        try: await watcher
        except asyncio.CancelledError: pass
