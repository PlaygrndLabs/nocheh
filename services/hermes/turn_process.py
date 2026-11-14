"""Common isolated Hermes turn bootstrap for Telegram and browser transports."""
import asyncio
import fcntl
import json
import math
import os
import re
import signal
import sys
import time
from pathlib import Path
from services.durable import canonical


def scheduled_preferences(profile,body):
    from .profile_config import inherited_config,read,preferences
    from .policy_config import validate
    config,_=inherited_config(profile,read(profile/'config.yaml'),job=body['job_id'])
    values=preferences(config);overrides=body.get('job_preferences',{});validate(overrides)
    values.update({key:value for key,value in overrides.items() if value is not None})
    return values


async def run_process(root, scope, body, model, credentials, session_id, emit=None, cancelled=None, prepared_profile=None, progress=None):
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
            # Native history and notes must not replay a source retired since this profile's last turn.
            from .isolated_profile import database_path
            from .retired_history import service_lookup, withhold_retired
            await asyncio.to_thread(withhold_retired, database_path(profile), service_lookup, profile/'memories')
            return await _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled, progress)
        finally:
            await asyncio.to_thread((profile/'.foreground').touch)


# A line of message text that looks like this module's own group frame, a private answer's first line, or the owner tag
# of a speaker line.
FRAME=re.compile(r'^([ \t]*)\[(?=(?:Group message from|Recent messages in this group|End of recent messages|Private answer))',re.M|re.I)
OWNER_TAG=re.compile(r'\[the owner\]',re.I)


def unframed(text):
    """Group message text as the model reads it: a look-alike speaker or recent-messages line, or an owner tag,
    is shown as plain text, so only the line Nocheh puts before a message names its sender (ADR-0222)."""
    return OWNER_TAG.sub('(the owner)',FRAME.sub(r'\1(',text))


def recent_group(value):
    """The recent unaddressed group messages block, or '' when the input is absent or malformed."""
    if not isinstance(value,list) or not 0<len(value)<=20:return ''
    lines=['[Recent messages in this group that were not addressed to you, oldest first]']
    for item in value:
        speaker=item.get('speaker') if isinstance(item,dict) else None
        if (not isinstance(speaker,str) or not speaker.startswith('[Group message from ') or not speaker.endswith(']')
                or len(speaker)>200 or '\n' in speaker or not isinstance(item.get('text'),str) or len(item['text'])>1000
                or not isinstance(item.get('id'),str) or not re.fullmatch(r'[a-f0-9]{64}',item['id'])):return ''
        lines.append(speaker+' (source nocheh:event:'+item['id']+')\n'+unframed(item['text']))
    lines.append('[End of recent messages]')
    return '\n\n'.join(lines)


def private_answer(value):
    """A private answer's frame and question (ADR-0249): the first line Nocheh wrote from the owner's template, where
    the question was asked and which groups the answer may read, the question's event, and where it was asked as that
    line names it (`group`, optional). Anything else is refused."""
    if (not isinstance(value,dict) or not {'frame','question_event'}<=set(value)<={'frame','question_event','group'}
            or not isinstance(value['frame'],str) or not 0<len(value['frame'].strip())<=4000
            or not isinstance(value['question_event'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['question_event'])
            or 'group' in value and (not isinstance(value['group'],str) or not 0<len(value['group'].strip())<=300
                                     or any(ord(c)<32 or ord(c)==127 for c in value['group']))):raise ValueError('invalid_private_answer')
    return value


def answer_receipt(profile,answer):
    """Keep where a private answer was asked, as its first line names it, and when it ran, in the answer's own profile,
    so the owner's notes can tell answers apart (ADR-0249). The same name is already in the profile's conversation, and
    the receipt goes with the profile."""
    if 'group' not in answer:return
    from datetime import datetime,timezone
    from .native_memory import save_receipt
    path=Path(profile)/'answer.json'
    if path.is_symlink():raise ValueError('profile_path_denied')
    save_receipt(path,json.dumps({'group':answer['group'].strip(),'at':datetime.now(timezone.utc).isoformat(timespec='seconds')}))


def job_run(limits):
    """A background job run's limits from its context, checked: its box and machine flags, never both, and its soft
    and hard deadlines (epoch seconds)."""
    finite=lambda value:type(value) in (int,float) and math.isfinite(value)
    if (not isinstance(limits,dict) or type(limits.get('box',False)) is not bool or type(limits.get('machine',False)) is not bool
            or limits.get('box') is True and limits.get('machine') is True or not finite(limits.get('soft_deadline'))
            or not finite(limits.get('hard_deadline')) or limits['soft_deadline']>limits['hard_deadline']):raise ValueError('invalid_background_run')
    return limits


async def _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled, progress=None):
    if cancelled and cancelled.is_set(): return {'state':'cancelled','text':'','session_id':session_id}
    # A background job run lasts until its job's hard deadline: its box commands end then, and the process a minute
    # later if nothing stopped it before. Every other turn has the usual reply time.
    background = job_run(body.get('background')) if body.get('channel')=='background' else None
    # A private answer's pass and its framed question come together, or the turn does not run.
    answer = private_answer(body.get('private_answer')) if scope.answer else None
    if answer is None and body.get('private_answer') is not None: raise ValueError('invalid_private_answer')
    if answer: answer_receipt(profile, answer)
    if background is not None and background['hard_deadline'] <= time.time():
        return {'state':'failed','error_code':'managed_execution_failed','text':'','session_id':session_id}
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
    speaker=body.get('speaker')
    if isinstance(speaker,str) and speaker.startswith('[Group message from ') and speaker.endswith(']') and len(speaker)<=200 and '\n' not in speaker:
        # Who spoke and when stays out of the memory query; the model and native history see it.
        text = speaker + '\n' + unframed(text)
    elif answer:
        # A private answer's question is group text even without its speaker line.
        text = unframed(text)
    recent=recent_group(body.get('recent_group'))
    if recent:
        # Group messages since the last turn that did not address Nocheh never reached Hermes on their own.
        text = recent + '\n\n' + text
    if answer:
        # A private answer says first where its question was asked and which groups it may read.
        text = answer['frame'].strip() + '\n\n' + text
    waiting=body.get('untranscribed_voice')
    if type(waiting) is int and 0<waiting<=20:
        # Voice notes are archived without transcription; their content never reaches the model.
        text += ('\n\n[Earlier in this chat, ' + ('a voice note was' if waiting==1 else str(waiting)+' voice notes were') +
                 ' received and archived. Transcription is not available, so that content is not available to you.'
                 ' Do not say that no voice note was received or found.]')
    too_large=body.get('files_too_large')
    if type(too_large) is int and 0<too_large<=100:
        # Telegram does not let a bot download a file over 20 MB; only its reference is archived.
        text += ('\n\n[' + ('One attached file is' if too_large==1 else str(too_large)+' attached files are') +
                 ' over the 20 MB limit for bot downloads, so only a reference is archived and the content is not available to you.]')
    text += '\n\n[Archive source: nocheh:event:' + body['event_id'] + ']'
    # The question is a source of a private answer too: retiring it withholds the answer's history.
    if answer: text += '\n[Archive source: nocheh:event:' + answer['question_event'] + ']'
    transport = credentials.runtime()
    request = {'text':text, 'source_text':body.get('text') or '', 'channel':body.get('channel','telegram'),
               'model':model, 'memory_query':memory_query, 'session_id':session_id, 'owner':scope.owner, 'chat_id':scope.chat_id,
               'private_answer':bool(answer),
               'user_id':scope.user_id, 'archive_credential':body['archive_credential'],
               **transport, 'stream':emit is not None,
               'memory_context':os.environ.get('NOCHEH_MEMORY_CONTEXT','legacy'),
               'images':[file['sha256'] for file in body.get('files',[]) if file['kind']=='image'],
               'turn_deadline_epoch':background['hard_deadline'] if background else time.time()+230,'prompts':body.get('prompts') or {}}
    if body.get('channel')=='scheduler':
        request['preferences']=scheduled_preferences(profile,body)
    if background:
        # A job run: its iteration backstop, its time budget and what its cost notice needs come from the job,
        # and it reports its progress while it works. A box run's tools run in the job's sealed box, a machine run's
        # on the owner's machine; the turn checks the box or the way to the machine is really there.
        request.update(background={'max_iterations':background.get('max_iterations'),'box':background.get('box',False),
                                   'machine':background.get('machine',False),'soft_deadline':background['soft_deadline'],
                                   **{key:background.get(key) for key in ('rates','cost_limit_usd','prior_cost_usd')}},heartbeat=True)
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
           'ARCHIVE_URL','GUARD_URL','NOCHEH_REPLY_ROUTE_URL','NOCHEH_GUARD_ROUTE_URL','NOCHEH_INSTALLATION_FIXTURE') if key in os.environ}
    env.update(HERMES_HOME=str(profile), GUARD_MODE=body.get('guard_mode','on'))
    if isolated:
        from .environment import secret
        # This short-lived bridge is trusted parent infrastructure, not the model process.
        env['SERVICE_TOKEN']=secret('SERVICE_TOKEN')
    module='services.hermes.security_client' if isolated else 'services.hermes.assistant_turn'
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
            elif isinstance(value,dict) and value.get('event') == 'heartbeat':
                continue
            elif isinstance(value,dict) and value.get('event') == 'progress' and background:
                # A job run's counts and to-do list so far, for its heartbeat; checked, since the turn runs the model's tools.
                from .job_progress import progress_line
                value = progress_line(value,len(line))
                if progress: progress(value)
            elif isinstance(value,dict) and value.get('state') in ('done','failed'):
                result = value
            else: raise RuntimeError('assistant_output_invalid')
        await process.wait()
        if result is not None:
            # Nocheh's usage tracker: Hermes's own token counts and cost for this turn.
            from .usage import part_of, record
            usage=result.pop('usage',None)
            await asyncio.to_thread(record, part_of(body), usage, model, result.get('state')!='done',
                                    reason=result.pop('failure_reason',None), cause=result.pop('failure_cause',None))
            # A job run reports Hermes's own token counts too; Nocheh prices them at the rates frozen on the job's card.
            if background:
                from .job_progress import run_tokens
                result['tokens']=run_tokens(usage)
        if cancelled and cancelled.is_set(): return {'state':'cancelled','text':'','session_id':session_id}
        if process.returncode or result is None: raise RuntimeError('assistant_process_failed')
        from .assistant_gateway import check_delivery_policy
        if not await asyncio.to_thread(check_delivery_policy,body['archive_credential']):
            from .timing import safe
            return {'state':'failed','error_code':'guard_context_changed','timings':safe(result.get('timings'))}
        return result
    try: return await asyncio.wait_for(collect(), timeout=background['hard_deadline']+60-time.time() if background else 230)
    except asyncio.TimeoutError:
        # A turn stopped at its time limit reports nothing else; count it so its failure shows.
        from .usage import part_of, record
        await asyncio.to_thread(record, part_of(body), None, model, True, reason='timed_out')
        raise
    finally:
        watcher.cancel()
        if process.returncode is None: process.kill();await process.wait()
        try: await watcher
        except asyncio.CancelledError: pass
