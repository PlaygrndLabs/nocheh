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
import unicodedata
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
            # This parent records who wrote each note the turn adds or changes, outside the turn's reach (ADR-0257). A
            # private answer, or the owner's ask about a member (step 4b), has no memory tool, so it writes no notes; neither
            # does a member's private chat (step 4).
            from . import note_sources
            watch=None if scope.answer or scope.member or scope.member_read else await asyncio.to_thread(note_sources.before, profile, scope.space or scope.chat_id, database_path(profile), body.get('event_id'))
            result=None
            try:
                result=await _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled, progress, watch and watch['sources'])
                return result
            finally:
                # Also after a cancelled or failed turn: its notes may have changed before it stopped.
                if watch is not None:await asyncio.to_thread(note_sources.after_turn, profile, body, session_id, watch, result)
        finally:
            await asyncio.to_thread((profile/'.foreground').touch)


# The words that open this module's own group frame, a private answer's first line, a forwarded message's line, the
# owner tag of a speaker line, or a replied-to message's lines, as frame() compares them. Retiring a message withholds
# what these lines quote from stored history (retired_history.py), so message text never writes one.
FRAME_WORDS=('groupmessagefrom','recentmessagesinthisgroup','endofrecentmessages','privateanswer','forwarded','theowner',
             'replyingto','inreplyto','endofreplied')
OWNER_TAG=re.compile(r'\[the owner\]',re.I)


def frame(text,start):
    """Whether the text from `start` reads as one of FRAME_WORDS: compared in its compatibility form, without case,
    and without the spaces, invisible characters and marks a reader would not notice between the letters. It reads
    only as far as the text could still be one of them."""
    letters=''
    for char in text[start:start+120]:
        for part in unicodedata.normalize('NFKC',char):
            if unicodedata.category(part)[0] in 'CZ' or unicodedata.category(part)=='Mn':continue
            letters+=part.casefold()
            if letters.startswith(FRAME_WORDS):return True
            if not any(word.startswith(letters) for word in FRAME_WORDS):return False
    return False


# Every opening bracket but the plain parenthesis: all of Unicode's opening punctuation is in its first plane.
OPENING=re.compile('['+''.join(re.escape(chr(c)) for c in range(0x10000) if unicodedata.category(chr(c))=='Ps' and chr(c)!='(')+']')


def unframed(text):
    """Group or forwarded message text as the model reads it: an opening bracket of any kind that starts something
    reading like Nocheh's own speaker, recent-messages, private-answer, forwarded or replied-to line, or an owner tag, wherever it
    stands, is shown as a plain parenthesis, so only the lines Nocheh puts before a message say who wrote it and where
    it came from (ADR-0222, ADR-0250). Persian half-spaces and other text stay as typed."""
    text=OWNER_TAG.sub('(the owner)',text)
    return OPENING.sub(lambda match:'(' if frame(text,match.end()) else match.group(),text)


def forwarded(value):
    """A forwarded message's line, which Nocheh writes from Telegram's own forward fields (ADR-0250), or '' when it is
    absent or malformed."""
    ok=(isinstance(value,str) and value.startswith('[Forwarded: ') and value.endswith(']') and len(value)<=600
        and not any(ord(c)<32 or ord(c)==127 or c in '\u2028\u2029' or 0xd800<=ord(c)<=0xdfff for c in value))
    return value if ok else ''


def recent_group(value):
    """The recent unaddressed group messages block, or '' when the input is absent or malformed. A message that replies
    to another carries its reply part, which names that message without its text, on its own line after the speaker
    line; a malformed one drops only itself (reply_part)."""
    if not isinstance(value,list) or not 0<len(value)<=20:return ''
    lines=['[Recent messages in this group that were not addressed to you, oldest first]']
    for item in value:
        speaker=item.get('speaker') if isinstance(item,dict) else None
        if (not isinstance(speaker,str) or not speaker.startswith('[Group message from ') or not speaker.endswith(']')
                or len(speaker)>200 or '\n' in speaker or not isinstance(item.get('text'),str) or len(item['text'])>1000
                or not isinstance(item.get('id'),str) or not re.fullmatch(r'[a-f0-9]{64}',item['id'])):return ''
        forward=forwarded(item.get('forwarded'))
        if 'forwarded' in item and not forward:return ''
        reply=reply_part(item.get('reply'))
        lines.append(speaker+' (source nocheh:event:'+item['id']+')\n'+(reply+'\n' if reply else '')+(forward+'\n' if forward else '')+unframed(item['text']))
    lines.append('[End of recent messages]')
    return '\n\n'.join(lines)


# Whose words a source is, as a source tag's by= says (src/source-tags.ts TagBy).
BY=('owner','person','forward','file','mixed','nocheh','shared','unknown')
# The reply lines' shapes are the ones stored history is read with (retired_history.py), so a block this frame writes is
# always one retiring its message finds.
from .retired_history import PART, REPLY, REPLY_END  # noqa: E402
REPLY_BY=re.compile(r'\[(?:Replying to|In reply to), by=([a-z]+): [^\]]')


def _one_line(value,size):
    """Whether a value is text of at most `size` characters on one line, with nothing that could end it or hide in it."""
    return (isinstance(value,str) and len(value)<=size
            and not any(ord(c)<32 or ord(c)==127 or c in '\x85\u2028\u2029' or 0xd800<=ord(c)<=0xdfff for c in value))


def _reply_line(value,shape):
    """A reply line Nocheh wrote from the archive's reply relation and a source tag (ADR-0261): `[<words>, by=<by>: <tag>]
    (source nocheh:event:<id>)`, at most 300 characters on one line, as (by, id), or None."""
    if not _one_line(value,300):return None
    found,by=shape.fullmatch(value),REPLY_BY.match(value)
    return (by.group(1),found.group(1)) if found and by and by.group(1) in BY else None


def reply_part(value):
    """A recent group message's reply part: who · where · when of the message it replies to, never its text, or ''."""
    return value if _reply_line(value,PART) else ''


def reply_block(value):
    """The block naming the message the turn's own message replies to (ADR-0261), or '' when absent or malformed: its
    line, at most 200 characters of its text on one line, shown unframed since they may be someone else's words, and
    the line that ends it. by= and the id must be the line's own."""
    if not isinstance(value,dict) or set(value)!={'line','text','by','id'}:return ''
    found=_reply_line(value['line'],REPLY)
    if (found!=(value['by'],value['id']) or not _one_line(value['text'],200)
            or not value['text'].strip()):return ''
    return value['line']+'\n'+unframed(value['text'])+'\n'+REPLY_END


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


def member_read(value):
    """The owner's ask about a member (step 4b): its ask, as its pass names it, and the member as Nocheh's own frame
    names them. Its frame is already the turn's text. Anything else is refused."""
    if (not isinstance(value,dict) or set(value)!={'ask','member'} or not isinstance(value['ask'],str) or not re.fullmatch(r'[a-f0-9]{32}',value['ask'])
            or not isinstance(value['member'],str) or not 0<len(value['member'].strip())<=300
            or any(ord(c)<32 or ord(c)==127 for c in value['member'])):raise ValueError('invalid_member_read')
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


def ask_receipt(profile):
    """Keep when the owner's ask about a member ran in its own profile, like a private answer's receipt, so the owner's
    notes date it (step 4b). It names no member: only the time."""
    from datetime import datetime,timezone
    from .native_memory import save_receipt
    path=Path(profile)/'answer.json'
    if path.is_symlink():raise ValueError('profile_path_denied')
    save_receipt(path,json.dumps({'at':datetime.now(timezone.utc).isoformat(timespec='seconds')}))


def job_run(limits):
    """A background job run's limits from its context, checked: its box and machine flags, never both, and its soft
    and hard deadlines (epoch seconds)."""
    finite=lambda value:type(value) in (int,float) and math.isfinite(value)
    if (not isinstance(limits,dict) or type(limits.get('box',False)) is not bool or type(limits.get('machine',False)) is not bool
            or limits.get('box') is True and limits.get('machine') is True or not finite(limits.get('soft_deadline'))
            or not finite(limits.get('hard_deadline')) or limits['soft_deadline']>limits['hard_deadline']):raise ValueError('invalid_background_run')
    return limits


async def _run_process(profile, scope, body, model, credentials, session_id, emit, cancelled, progress=None, note_sources=None):
    if cancelled and cancelled.is_set(): return {'state':'cancelled','text':'','session_id':session_id}
    # A background job run lasts until its job's hard deadline: its box commands end then, and the process a minute
    # later if nothing stopped it before. Every other turn has the usual reply time.
    background = job_run(body.get('background')) if body.get('channel')=='background' else None
    # A private answer's pass and its framed question come together, or the turn does not run.
    answer = private_answer(body.get('private_answer')) if scope.answer else None
    if answer is None and body.get('private_answer') is not None: raise ValueError('invalid_private_answer')
    if answer: answer_receipt(profile, answer)
    # The owner's ask about a member: its pass and its ask come together, and it is never a private answer too.
    asked = member_read(body.get('member_read')) if scope.member_read else None
    if (asked is None) != (body.get('member_read') is None) or asked and (answer or asked['ask'] != scope.member_read): raise ValueError('invalid_member_read')
    if asked: ask_receipt(profile)
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
    group=isinstance(speaker,str) and speaker.startswith('[Group message from ') and speaker.endswith(']') and len(speaker)<=200 and '\n' not in speaker
    forward=forwarded(body.get('forwarded'))
    if forward:
        # Where a forwarded message came from goes before its text, which cannot write that line itself.
        text = forward + '\n' + unframed(text)
    elif group or answer or scope.member:
        # Group text, a private answer's question too even without its speaker line, cannot write a frame line; a
        # member's own words never read as one of Nocheh's lines either (step 4).
        text = unframed(text)
    reply=reply_block(body.get('reply'))
    if reply:
        # The message this one replies to, named and quoted, before its text: after the speaker line in a group, first in
        # the owner's chat, where retiring that message finds it in stored history (retired_history.py).
        text = reply + '\n' + text
    if group:
        # Who spoke and when stays out of the memory query; the model and native history see it.
        text = speaker + '\n' + text
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
               'private_answer':bool(answer), 'member_read':bool(asked),
               # A member's own private chat (step 4): read tools only, no notes, the member's reply rules.
               'member':bool(scope.member),
               'user_id':scope.user_id, 'archive_credential':body['archive_credential'],
               **transport, 'stream':emit is not None,
               'memory_context':os.environ.get('NOCHEH_MEMORY_CONTEXT','legacy'),
               'images':[file['sha256'] for file in body.get('files',[]) if file['kind']=='image'],
               'turn_deadline_epoch':background['hard_deadline'] if background else time.time()+230,'prompts':body.get('prompts') or {},
               # Each native note's source, as storage labels it from this parent's records, by the note's key.
               'note_sources':note_sources or {}}
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
            # A turn that could not read long-term memory, or part of it, says so; it is counted for the owner's notice.
            from .usage import note_done, note_failed
            problem=result.pop('memory_problem',None)
            if problem=='memory_read':await asyncio.to_thread(note_failed,'memory_read')
            elif result.get('state')=='done' and not answer and not asked and not scope.member:await asyncio.to_thread(note_done,'memory_read')
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
